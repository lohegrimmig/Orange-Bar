// Beweist, dass das clientseitige Signieren (public/iota-sign.js, wie im Browser
// im Self-Custody-Modus) byte-identische Signaturen erzeugt wie @iota/iota-sdk.
// Läuft in Node ohne Netzwerk – das ist der Korrektheitsanker für Non-Custodial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// Web Crypto für die vendored noble/SHA-512-Verdrahtung bereitstellen.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { signIotaTransactionBytes, addressFromSeed } = await import('../public/iota-sign.js');
const { Ed25519Keypair } = await import('@iota/iota-sdk/keypairs/ed25519');
const { decodeIotaPrivateKey } = await import('@iota/iota-sdk/cryptography');

function seedOf(kp) {
  return new Uint8Array(decodeIotaPrivateKey(kp.getSecretKey()).secretKey);
}

test('Signatur ist byte-identisch zum SDK (viele zufällige Tx-Bytes)', async () => {
  for (let i = 0; i < 25; i++) {
    const kp = new Ed25519Keypair();
    const seed = seedOf(kp);
    const len = 1 + Math.floor(Math.random() * 400);
    const txBytes = new Uint8Array(len);
    globalThis.crypto.getRandomValues(txBytes);

    const mine = await signIotaTransactionBytes(txBytes, seed);
    const sdk = (await kp.signTransaction(txBytes)).signature;
    assert.equal(mine, sdk, `Signatur weicht ab bei Iteration ${i} (len ${len})`);
  }
});

test('Adresse aus Seed stimmt mit der SDK-Adresse überein', async () => {
  for (let i = 0; i < 10; i++) {
    const kp = new Ed25519Keypair();
    const mine = await addressFromSeed(seedOf(kp));
    assert.equal(mine, kp.getPublicKey().toIotaAddress());
  }
});

test('Signatur hat das erwartete Format (Flag 0x00 || 64 Sig || 32 PubKey)', async () => {
  const kp = new Ed25519Keypair();
  const sig = await signIotaTransactionBytes(new Uint8Array([1, 2, 3]), seedOf(kp));
  const raw = Buffer.from(sig, 'base64');
  assert.equal(raw.length, 97);
  assert.equal(raw[0], 0x00);
});
