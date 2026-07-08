// TOTP (RFC 6238) für die optionale Zwei-Faktor-Authentifizierung –
// kompatibel mit Google Authenticator, Aegis, 1Password usw.
// Bewusst ohne externe Abhängigkeit implementiert.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.toUpperCase().replace(/=+$/, '')) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Ungültiges Base32-Zeichen.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20)); // 160 Bit, Standard für SHA-1-TOTP
}

/** 6-stelliger TOTP-Code für einen Zeit-Schritt (30 s). */
export function totpCode(secretB32, timeStep = Math.floor(Date.now() / 30000)) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(timeStep));
  const hmac = createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Prüft einen Code mit ±1 Zeitfenster-Toleranz (Uhrendrift). */
export function verifyTotp(secretB32, code) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step, step - 1, step + 1]) {
    const expected = totpCode(secretB32, s);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** otpauth://-URL für QR-Code-Einrichtung in Authenticator-Apps. */
export function otpauthUrl(secretB32, username, issuer = 'Orange-Bar') {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}
