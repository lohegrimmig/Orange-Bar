// IOTA-Wallet-Schicht (custodial): pro Nutzer ein Ed25519-Schlüsselpaar,
// verschlüsselt in der DB. Senden/Empfangen von IOTA und NFTs (Objekten)
// auf wählbarem Netzwerk (testnet/devnet/mainnet) – dieselbe Adresse gilt
// auf allen Netzwerken. Dazu die Gas Station für Startguthaben.
import { IotaClient, getFullnodeUrl } from '@iota/iota-sdk/client';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
import { Transaction } from '@iota/iota-sdk/transactions';
import { NANOS_PER_IOTA, fromBase64, toBase64 } from '@iota/iota-sdk/utils';
import { decodeIotaPrivateKey } from '@iota/iota-sdk/cryptography';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import {
  insertWallet, getWalletByUser,
  getStation, insertStation, insertGasGrant,
  setWalletSelfCustody, upsertSelfCustodyKey, setWalletPublicKey, now,
} from './db.js';

export { NANOS_PER_IOTA };

// Ein Client pro Netzwerk, lazy erzeugt.
const clients = new Map();
export function getClient(network) {
  if (!config.iotaNetworks.includes(network)) {
    throw new Error(`Unbekanntes Netzwerk: ${network}`);
  }
  if (!clients.has(network)) {
    const url = config.iotaRpcUrls[network] || getFullnodeUrl(network);
    clients.set(network, new IotaClient({ url }));
  }
  return clients.get(network);
}

/** Erzeugt für einen Nutzer ein Wallet und legt es verschlüsselt ab. */
export function createWalletForUser(userId) {
  const keypair = new Ed25519Keypair();
  const address = keypair.getPublicKey().toIotaAddress();
  const secret = Buffer.from(keypair.getSecretKey(), 'utf8'); // bech32 "iotaprivkey1..."
  insertWallet.run(userId, address, encrypt(secret), 'ed25519', now());
  return { address };
}

/** Lädt das entschlüsselte Keypair eines Nutzers (nur Custodial). */
export function loadKeypair(userId) {
  const row = getWalletByUser.get(userId);
  if (!row || row.self_custody) return null;
  if (!row.key_ciphertext?.length) return null;
  const secret = decrypt(row.key_ciphertext).toString('utf8');
  return Ed25519Keypair.fromSecretKey(secret);
}

export function getAddress(userId) {
  const row = getWalletByUser.get(userId);
  return row ? row.address : null;
}

/** Ed25519-Signatur über eine Personal Message (Mintly-Login-Challenge o. Ä.). */
export async function signPersonalMessageForUser(userId, message) {
  const keypair = loadKeypair(userId);
  if (!keypair) throw new Error('Kein Wallet vorhanden.');
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const { signature } = await keypair.signPersonalMessage(bytes);
  return { address: keypair.getPublicKey().toIotaAddress(), signature };
}

/** IOTA-Guthaben (in Nanos) einer Adresse. */
export async function getBalance(network, address) {
  const bal = await getClient(network).getBalance({ owner: address });
  return { coinType: bal.coinType, totalBalance: bal.totalBalance };
}

/** Eigene Objekte (NFTs & Co.) einer Adresse, mit Anzeige-Metadaten. */
export async function getOwnedObjects(network, address, cursor = null) {
  const page = await getClient(network).getOwnedObjects({
    owner: address,
    cursor: cursor || undefined,
    limit: 50,
    options: { showType: true, showDisplay: true, showContent: false },
  });
  const objects = page.data
    .map((o) => o.data)
    .filter(Boolean)
    // Gas-/Coin-Objekte nicht als "NFTs" listen
    .filter((d) => !(d.type || '').startsWith('0x2::coin::Coin<'))
    .map((d) => ({
      objectId: d.objectId,
      type: d.type,
      display: d.display?.data || null,
    }));
  return { objects, nextCursor: page.hasNextPage ? page.nextCursor : null };
}

/** Letzte Transaktionen einer Adresse (gesendet + empfangen). */
export async function getActivity(network, address) {
  const client = getClient(network);
  const opts = { options: { showEffects: true, showBalanceChanges: true }, limit: 10, order: 'descending' };
  const [sent, received] = await Promise.all([
    client.queryTransactionBlocks({ filter: { FromAddress: address }, ...opts }),
    client.queryTransactionBlocks({ filter: { ToAddress: address }, ...opts }),
  ]);
  const seen = new Set();
  const items = [];
  for (const tx of [...sent.data, ...received.data]) {
    if (seen.has(tx.digest)) continue;
    seen.add(tx.digest);
    const change = (tx.balanceChanges || []).find(
      (c) => c.owner?.AddressOwner === address && c.coinType?.endsWith('::iota::IOTA')
    );
    items.push({
      digest: tx.digest,
      timestampMs: tx.timestampMs ? Number(tx.timestampMs) : null,
      status: tx.effects?.status?.status || 'unknown',
      amountNanos: change ? change.amount : null, // negativ = gesendet
    });
  }
  items.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
  return items.slice(0, 15);
}

/** Chain-Status aus einer Tx-Antwort (nach waitForTransaction bevorzugt). */
export function txStatusFromResponse(txResponse) {
  return txResponse?.effects?.status?.status || 'unknown';
}

/** DB-Status für pay_requests aus dem Chain-Ergebnis.
 *  Mit Digest und ohne explizites failure → confirmed (Spiel/SDK freischalten).
 *  „unknown“ nach waitForTransaction ist oft Indexing-Lag, nicht gescheiterte Tx. */
export function payRequestStatusFromChain(chainStatus, digest = null) {
  if (chainStatus === 'failure') return 'failed';
  if (chainStatus === 'success') return 'confirmed';
  if (digest) return 'confirmed';
  return 'pending';
}

async function waitForTxEffects(client, digest, initialResult) {
  const waited = await client.waitForTransaction({
    digest,
    options: { showEffects: true },
  });
  return {
    digest,
    status: txStatusFromResponse(waited) !== 'unknown'
      ? txStatusFromResponse(waited)
      : txStatusFromResponse(initialResult),
  };
}

async function executeTransfer(network, keypair, buildFn) {
  const client = getClient(network);
  const tx = new Transaction();
  buildFn(tx);
  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  return waitForTxEffects(client, result.digest, result);
}

/** Sendet IOTA (amount in Nanos) an eine Adresse. */
export async function sendIota(network, userId, toAddress, amountNanos) {
  const keypair = loadKeypair(userId);
  if (!keypair) throw new Error('Kein Wallet für diesen Nutzer.');
  return executeTransfer(network, keypair, (tx) => {
    const [coin] = tx.splitCoins(tx.gas, [BigInt(amountNanos)]);
    tx.transferObjects([coin], toAddress);
  });
}

/** Überträgt ein Objekt (z. B. NFT) an eine Adresse. */
export async function sendObject(network, userId, objectId, toAddress) {
  const keypair = loadKeypair(userId);
  if (!keypair) throw new Error('Kein Wallet für diesen Nutzer.');
  return executeTransfer(network, keypair, (tx) => {
    tx.transferObjects([tx.object(objectId)], toAddress);
  });
}

/** Grobe Plausibilitätsprüfung einer IOTA-Adresse (0x + 64 Hex-Zeichen). */
export function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{64}$/.test(addr);
}

// ---------- Self-Custody (WebAuthn-PRF) ----------

export function isSelfCustody(userId) {
  const row = getWalletByUser.get(userId);
  return !!(row && row.self_custody);
}

/**
 * Legt ein reines Self-Custody-Wallet an (PRF-first, kein Server-Schlüssel).
 * Der Client liefert Adresse, Public Key und den PRF-verschlüsselten Seed.
 */
export function initSelfCustodyWallet(userId, { address, publicKey, credentialId, wrapped }) {
  if (config.custodialMode) {
    throw new Error('initSelfCustodyWallet nur im Non-Custodial-Modus.');
  }
  if (getWalletByUser.get(userId)) throw new Error('Wallet existiert bereits.');
  if (!isValidAddress(address)) throw new Error('Ungültige Wallet-Adresse.');
  if (!publicKey || publicKey.length !== 32) throw new Error('Ungültiger Public Key.');
  if (typeof wrapped !== 'string' || wrapped.length < 20) throw new Error('Ungültiger verschlüsselter Seed.');
  insertWallet.run(userId, address, Buffer.alloc(0), 'ed25519', now());
  setWalletPublicKey.run(Buffer.from(publicKey), userId);
  upsertSelfCustodyKey.run(userId, credentialId, wrapped, now());
  setWalletSelfCustody.run(1, Buffer.alloc(0), userId);
  return { address };
}

/** Exportiert den 32-Byte-Seed (hex) – nur solange noch custodial. Damit kann der
 *  Client den Seed per PRF verschlüsseln. Danach wird der Serverschlüssel gelöscht. */
export function exportSeedHex(userId) {
  const row = getWalletByUser.get(userId);
  if (!row) throw new Error('Kein Wallet.');
  if (row.self_custody) throw new Error('Wallet ist bereits im Self-Custody-Modus.');
  const bech32 = decrypt(row.key_ciphertext).toString('utf8');
  const { secretKey } = decodeIotaPrivateKey(bech32); // 32-Byte-Seed
  return Buffer.from(secretKey).toString('hex');
}

/** Schaltet Self-Custody ein: speichert den PRF-verschlüsselten Seed für den
 *  aktuellen Passkey und LÖSCHT den serverseitigen Schlüssel (kein Zugriff mehr). */
export function enableSelfCustody(userId, credentialId, wrappedB64) {
  upsertSelfCustodyKey.run(userId, credentialId, wrappedB64, now());
  // key_ciphertext auf leeren Blob setzen (Spalte ist NOT NULL) – Server kann
  // ab jetzt nicht mehr signieren.
  setWalletSelfCustody.run(1, Buffer.alloc(0), userId);
}

/** Hinterlegt den PRF-verschlüsselten Seed für ein weiteres Gerät/Passkey. */
export function enrollSelfCustodyDevice(userId, credentialId, wrappedB64) {
  if (!isSelfCustody(userId)) throw new Error('Self-Custody ist nicht aktiv.');
  upsertSelfCustodyKey.run(userId, credentialId, wrappedB64, now());
}

/** Baut die zu signierenden Tx-Bytes für einen IOTA-Transfer (Client signiert selbst). */
export async function buildTransferBytes(network, sender, toAddress, amountNanos) {
  const client = getClient(network);
  const tx = new Transaction();
  tx.setSender(sender);
  const [coin] = tx.splitCoins(tx.gas, [BigInt(amountNanos)]);
  tx.transferObjects([coin], toAddress);
  const bytes = await tx.build({ client }); // löst Gas-Coins auf (braucht Netzwerk)
  return toBase64(bytes);
}

/** Baut die zu signierenden Tx-Bytes für einen NFT-/Objekt-Transfer. */
export async function buildObjectTransferBytes(network, sender, objectId, toAddress) {
  const client = getClient(network);
  const tx = new Transaction();
  tx.setSender(sender);
  tx.transferObjects([tx.object(objectId)], toAddress);
  const bytes = await tx.build({ client });
  return toBase64(bytes);
}

/** Führt eine extern (clientseitig) signierte Transaktion aus. */
export async function submitSignedTransaction(network, txBytesB64, signatureB64) {
  const client = getClient(network);
  const result = await client.executeTransactionBlock({
    transactionBlock: fromBase64(txBytesB64),
    signature: signatureB64,
    options: { showEffects: true },
  });
  return waitForTxEffects(client, result.digest, result);
}

/** Erzeugt ein frisches Ed25519-Wallet (für Projekt-Gas-Stationen). */
export function createStationWallet() {
  const keypair = new Ed25519Keypair();
  return {
    address: keypair.getPublicKey().toIotaAddress(),
    secret: Buffer.from(keypair.getSecretKey(), 'utf8'),
  };
}

/** Sendet IOTA von einem beliebigen (entschlüsselten) Station-Secret. */
export async function sendFromSecret(network, secretBytes, toAddress, amountNanos) {
  const keypair = Ed25519Keypair.fromSecretKey(secretBytes.toString('utf8'));
  return executeTransfer(network, keypair, (tx) => {
    const [coin] = tx.splitCoins(tx.gas, [BigInt(amountNanos)]);
    tx.transferObjects([coin], toAddress);
  });
}

// ---------- Gas Station ----------

/** Liefert die Gas Station (legt Wallet beim ersten Zugriff an). */
export function ensureStation() {
  let station = getStation.get();
  if (!station) {
    const keypair = new Ed25519Keypair();
    const address = keypair.getPublicKey().toIotaAddress();
    const secret = Buffer.from(keypair.getSecretKey(), 'utf8');
    insertStation.run(address, encrypt(secret), '100000000', now());
    station = getStation.get();
    console.log(`[orange-bar] Gas-Station-Wallet angelegt: ${address}`);
  }
  return station;
}

function loadStationKeypair() {
  const station = ensureStation();
  return Ed25519Keypair.fromSecretKey(decrypt(station.key_ciphertext).toString('utf8'));
}

/**
 * Überweist Gas von der Station an einen Nutzer und protokolliert das Ergebnis.
 * kind: 'auto' (bei Registrierung) oder 'manual' (vom Admin ausgelöst).
 */
export async function grantGas(network, userId, amountNanos, kind) {
  const grantId = randomUUID();
  const to = getAddress(userId);
  try {
    if (!to) throw new Error('Nutzer hat kein Wallet.');
    const keypair = loadStationKeypair();
    const result = await executeTransfer(network, keypair, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(amountNanos)]);
      tx.transferObjects([coin], to);
    });
    insertGasGrant.run(grantId, userId, network, String(amountNanos), kind, result.digest, 'success', null, now());
    return { ok: true, digest: result.digest };
  } catch (err) {
    insertGasGrant.run(grantId, userId, network, String(amountNanos), kind, null, 'failed', err.message, now());
    return { ok: false, error: err.message };
  }
}
