// Testet das PRF-Wrapping (AES-256-GCM über HKDF aus der PRF-Ausgabe).
// Die PRF-Ausgabe wird gemockt; getPrfOutput() selbst braucht einen echten
// Authenticator und wird hier nicht aufgerufen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { wrapSeed, unwrapSeed } = await import('../public/prf.js');

test('wrap/unwrap ist ein Roundtrip mit demselben PRF-Geheimnis', async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await unwrapSeed(await wrapSeed(seed, prf), prf);
  assert.deepEqual(wrapped, seed);
});

test('falsches PRF-Geheimnis kann nicht entschlüsseln', async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const wrappedB64 = await wrapSeed(seed, prf);
  const wrongPrf = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(() => unwrapSeed(wrappedB64, wrongPrf));
});

test('jede Verschlüsselung nutzt eine frische IV (unterschiedliche Ciphertexte)', async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const prf = crypto.getRandomValues(new Uint8Array(32));
  assert.notEqual(await wrapSeed(seed, prf), await wrapSeed(seed, prf));
});
