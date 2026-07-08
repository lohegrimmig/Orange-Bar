// Verschlüsselung der Wallet-Schlüssel (AES-256-GCM) mit einem Master-Key.
// Der Master-Key kommt aus ORANGE_MASTER_KEY oder wird beim ersten Start
// erzeugt und unter data/master.key abgelegt (nur für Entwicklung – in
// Produktion den Key als Umgebungsvariable/Secret bereitstellen!).
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const KEY_FILE = new URL('../data/master.key', import.meta.url).pathname;

function loadMasterKey() {
  if (config.masterKeyHex) {
    const key = Buffer.from(config.masterKeyHex, 'hex');
    if (key.length !== 32) throw new Error('ORANGE_MASTER_KEY muss 32 Byte hex sein (64 Zeichen).');
    return key;
  }
  if (existsSync(KEY_FILE)) {
    return Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  }
  const key = randomBytes(32);
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  console.warn('[orange-bar] Neuer Master-Key erzeugt: data/master.key – sicher aufbewahren!');
  return key;
}

const MASTER_KEY = loadMasterKey();

/** Verschlüsselt Bytes → Buffer(iv || authTag || ciphertext). */
export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Entschlüsselt Buffer(iv || authTag || ciphertext) → Bytes. */
export function decrypt(blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
