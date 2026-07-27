// Testet das PRF-Wrapping (AES-256-GCM über HKDF aus der PRF-Ausgabe).
// Die PRF-Ausgabe wird gemockt; getPrfOutput() selbst braucht einen echten
// Authenticator und wird hier nicht aufgerufen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { wrapSeed, unwrapSeed, interpretPrfCapabilities, likelyApplePrfPlatform } = await import('../public/prf.js');

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

test('interpretPrfCapabilities erkennt extension:prf', () => {
  assert.equal(interpretPrfCapabilities({ 'extension:prf': true }), true);
  assert.equal(interpretPrfCapabilities({ 'extension:prf': false }), false);
  assert.equal(interpretPrfCapabilities({}), null);
  assert.equal(interpretPrfCapabilities(null), null);
});

test('likelyApplePrfPlatform erkennt iOS 18+ und Safari 18+', () => {
  assert.equal(
    likelyApplePrfPlatform(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.5 Mobile/15E148 Safari/604.1',
    ),
    true,
  );
  assert.equal(
    likelyApplePrfPlatform(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    ),
    false,
  );
  assert.equal(
    likelyApplePrfPlatform(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
    ),
    true,
  );
  assert.equal(likelyApplePrfPlatform('Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile'), false);
});

test('prfFromExtensionResults liest first aus results', async () => {
  const { prfFromExtensionResults, withPrfEval, PRF_SALT } = await import('../public/prf.js');
  const bytes = new Uint8Array(32).fill(7);
  assert.deepEqual(prfFromExtensionResults({ prf: { results: { first: bytes } } }), bytes);
  assert.equal(prfFromExtensionResults({ prf: { enabled: true } }), null);
  const opts = withPrfEval({ challenge: 'x' });
  assert.equal(opts.extensions.prf.eval.first, PRF_SALT);
});
