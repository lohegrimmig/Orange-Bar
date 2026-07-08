import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode, base32Decode, generateTotpSecret, totpCode, verifyTotp, otpauthUrl,
} from '../server/totp.js';

test('Base32-Roundtrip', () => {
  const buf = Buffer.from('orange-bar-test-1234');
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
});

test('TOTP entspricht RFC-6238-Testvektor', () => {
  // RFC 6238, SHA-1, Secret "12345678901234567890", T=59s → Schritt 1, Code 94287082 → 6-stellig: 287082
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpCode(secret, 1), '287082');
  assert.equal(totpCode(secret, 37037036), '081804'); // T=1111111109
});

test('verifyTotp akzeptiert aktuellen Code und ±1 Fenster', () => {
  const secret = generateTotpSecret();
  const step = Math.floor(Date.now() / 30000);
  assert.equal(verifyTotp(secret, totpCode(secret, step)), true);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1)), true);
  assert.equal(verifyTotp(secret, totpCode(secret, step + 5)), false);
  assert.equal(verifyTotp(secret, 'abc123'), false);
  assert.equal(verifyTotp(secret, ''), false);
});

test('otpauth-URL enthält Secret, Issuer und Nutzer', () => {
  const url = otpauthUrl('ABC234', 'lohe');
  assert.match(url, /^otpauth:\/\/totp\/Orange-Bar%3Alohe\?secret=ABC234&issuer=Orange-Bar/);
});
