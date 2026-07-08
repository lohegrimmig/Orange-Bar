// Clientseitiges IOTA-Signieren für den Self-Custody-Modus.
// Der private Schlüssel verlässt niemals das Gerät im Klartext: er wird per
// Passkey-PRF entschlüsselt (siehe prf.js) und hier lokal zum Signieren genutzt.
// Der Server erhält nur die fertige Signatur und die Transaktions-Bytes.
//
// Das Signaturformat ist byte-identisch zu @iota/iota-sdk
// (Intent „TransactionData" || BCS-Tx → BLAKE2b-256 → Ed25519 → 1+64+32-Byte-
// Signatur mit Flag 0x00), was der Node-Test tests/iota-sign.test.js beweist.
import { blake2b } from './vendor/blake2b.js';
import * as ed from './vendor/noble-ed25519.js';

// Ed25519 (noble) braucht SHA-512. Web Crypto ist überall verfügbar (auch auf
// älteren Geräten) – wir liefern die asynchrone Variante und nutzen signAsync.
ed.etc.sha512Async = async (...msgs) => {
  const total = msgs.reduce((n, m) => n + m.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const m of msgs) { buf.set(m, o); o += m.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-512', buf));
};

// Intent: scope=TransactionData(0), version=V0(0), appId=Iota(0)
const INTENT = new Uint8Array([0, 0, 0]);
const ED25519_FLAG = 0x00;

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** hex → Uint8Array */
export function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/** IOTA-Adresse aus dem 32-Byte-Seed ableiten. Bei Ed25519 hasht IOTA den
 *  Public Key OHNE Flag-Präfix (blake2b256(pubkey)). */
export async function addressFromSeed(secretSeed) {
  const pub = await ed.getPublicKeyAsync(secretSeed);
  return '0x' + [...blake2b(pub, 32)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Signiert BCS-serialisierte Transaktions-Bytes mit einem 32-Byte-Ed25519-Seed.
 * @param {Uint8Array} txBytes  von @iota/iota-sdk gebaute TransactionData
 * @param {Uint8Array} secretSeed  32-Byte-Ed25519-Seed
 * @returns {Promise<string>}  serialisierte Signatur (base64), wie vom SDK erzeugt
 */
export async function signIotaTransactionBytes(txBytes, secretSeed) {
  const intentMsg = new Uint8Array(INTENT.length + txBytes.length);
  intentMsg.set(INTENT, 0);
  intentMsg.set(txBytes, INTENT.length);
  const digest = blake2b(intentMsg, 32);           // BLAKE2b-256 des Intent-Messages
  const signature = await ed.signAsync(digest, secretSeed); // Ed25519 über den 32-Byte-Digest
  const publicKey = await ed.getPublicKeyAsync(secretSeed);

  const serialized = new Uint8Array(1 + signature.length + publicKey.length);
  serialized[0] = ED25519_FLAG;
  serialized.set(signature, 1);
  serialized.set(publicKey, 1 + signature.length);
  return toBase64(serialized);
}
