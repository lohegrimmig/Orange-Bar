import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolierte Test-Umgebung, bevor Module geladen werden.
const dir = mkdtempSync(join(tmpdir(), 'ob-test-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '11'.repeat(32);

const { encrypt, decrypt } = await import('../server/crypto.js');

test('encrypt/decrypt ist ein Roundtrip', () => {
  const secret = Buffer.from('iotaprivkey1qtesttesttest');
  const blob = encrypt(secret);
  assert.notDeepEqual(blob, secret);
  assert.deepEqual(decrypt(blob), secret);
});

test('jede Verschlüsselung nutzt eine frische IV', () => {
  const secret = Buffer.from('gleicher inhalt');
  assert.notDeepEqual(encrypt(secret), encrypt(secret));
});

test('manipulierter Ciphertext wird abgelehnt', () => {
  const blob = encrypt(Buffer.from('geheim'));
  blob[blob.length - 1] ^= 0xff;
  assert.throws(() => decrypt(blob));
});
