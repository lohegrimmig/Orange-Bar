// IOTA-Wallet-Schicht (custodial): pro Nutzer ein Ed25519-Schlüsselpaar,
// verschlüsselt in der DB. Senden/Empfangen von IOTA und NFTs (Objekten)
// über das IOTA-Rebased-Netzwerk (@iota/iota-sdk).
import { IotaClient, getFullnodeUrl } from '@iota/iota-sdk/client';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
import { Transaction } from '@iota/iota-sdk/transactions';
import { NANOS_PER_IOTA } from '@iota/iota-sdk/utils';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import { insertWallet, getWalletByUser, now } from './db.js';

const rpcUrl = config.iotaRpcUrl || getFullnodeUrl(config.iotaNetwork);
export const client = new IotaClient({ url: rpcUrl });

export { NANOS_PER_IOTA };

/** Erzeugt für einen Nutzer ein Wallet und legt es verschlüsselt ab. */
export function createWalletForUser(userId) {
  const keypair = new Ed25519Keypair();
  const address = keypair.getPublicKey().toIotaAddress();
  const secret = Buffer.from(keypair.getSecretKey(), 'utf8'); // bech32 "iotaprivkey1..."
  insertWallet.run(userId, address, encrypt(secret), 'ed25519', now());
  return { address };
}

/** Lädt das entschlüsselte Keypair eines Nutzers. */
export function loadKeypair(userId) {
  const row = getWalletByUser.get(userId);
  if (!row) return null;
  const secret = decrypt(row.key_ciphertext).toString('utf8');
  return Ed25519Keypair.fromSecretKey(secret);
}

export function getAddress(userId) {
  const row = getWalletByUser.get(userId);
  return row ? row.address : null;
}

/** IOTA-Guthaben (in Nanos) einer Adresse. */
export async function getBalance(address) {
  const bal = await client.getBalance({ owner: address });
  return { coinType: bal.coinType, totalBalance: bal.totalBalance };
}

/** Eigene Objekte (NFTs & Co.) einer Adresse, mit Anzeige-Metadaten. */
export async function getOwnedObjects(address, cursor = null) {
  const page = await client.getOwnedObjects({
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

/** Sendet IOTA (amount in Nanos, als String/BigInt) an eine Adresse. */
export async function sendIota(userId, toAddress, amountNanos) {
  const keypair = loadKeypair(userId);
  if (!keypair) throw new Error('Kein Wallet für diesen Nutzer.');
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [BigInt(amountNanos)]);
  tx.transferObjects([coin], toAddress);
  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: result.digest });
  return { digest: result.digest, status: result.effects?.status?.status || 'unknown' };
}

/** Überträgt ein Objekt (z. B. NFT) an eine Adresse. */
export async function sendObject(userId, objectId, toAddress) {
  const keypair = loadKeypair(userId);
  if (!keypair) throw new Error('Kein Wallet für diesen Nutzer.');
  const tx = new Transaction();
  tx.transferObjects([tx.object(objectId)], toAddress);
  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: result.digest });
  return { digest: result.digest, status: result.effects?.status?.status || 'unknown' };
}

/** Grobe Plausibilitätsprüfung einer IOTA-Adresse (0x + 64 Hex-Zeichen). */
export function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{64}$/.test(addr);
}
