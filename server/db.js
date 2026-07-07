// SQLite-Persistenz: Nutzer, Passkey-Credentials, Sessions, Challenges,
// ausstehende Transaktionen und Zahlungsanfragen (In-Game-SDK).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- UUID
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id              TEXT PRIMARY KEY,        -- Credential-ID (base64url)
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      BLOB NOT NULL,           -- COSE Public Key
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,                    -- JSON-Array
  device_type     TEXT,                    -- singleDevice | multiDevice
  backed_up       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address         TEXT NOT NULL UNIQUE,
  key_ciphertext  BLOB NOT NULL,           -- AES-256-GCM: iv || tag || ciphertext
  scheme          TEXT NOT NULL DEFAULT 'ed25519',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

-- Kurzlebige WebAuthn-Challenges (Registrierung/Login/Tx-Bestätigung).
CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,            -- UUID
  kind        TEXT NOT NULL,               -- register | login | tx
  user_id     TEXT,                        -- bei register/tx gesetzt
  challenge   TEXT NOT NULL,               -- base64url
  payload     TEXT,                        -- JSON (z. B. Tx-Details)
  expires_at  INTEGER NOT NULL
);

-- Zahlungsanfragen aus dem In-Game-SDK.
CREATE TABLE IF NOT EXISTS pay_requests (
  id          TEXT PRIMARY KEY,            -- UUID
  origin      TEXT NOT NULL,               -- anfragende Spiel-Origin
  to_address  TEXT NOT NULL,
  amount      TEXT NOT NULL,               -- Nanos als String
  memo        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|rejected|expired
  tx_digest   TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
`);

export const now = () => Math.floor(Date.now() / 1000);

// --- Nutzer ---
export const insertUser = db.prepare(
  'INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)'
);
export const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
export const getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');

// --- Credentials ---
export const insertCredential = db.prepare(`
  INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
export const getCredentialById = db.prepare('SELECT * FROM credentials WHERE id = ?');
export const getCredentialsByUser = db.prepare('SELECT * FROM credentials WHERE user_id = ?');
export const updateCredentialCounter = db.prepare('UPDATE credentials SET counter = ? WHERE id = ?');

// --- Wallets ---
export const insertWallet = db.prepare(
  'INSERT INTO wallets (user_id, address, key_ciphertext, scheme, created_at) VALUES (?, ?, ?, ?, ?)'
);
export const getWalletByUser = db.prepare('SELECT * FROM wallets WHERE user_id = ?');

// --- Sessions ---
export const insertSession = db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)');
export const getSession = db.prepare('SELECT * FROM sessions WHERE token = ?');
export const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');

// --- Challenges ---
export const insertChallenge = db.prepare(
  'INSERT INTO challenges (id, kind, user_id, challenge, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
);
export const getChallenge = db.prepare('SELECT * FROM challenges WHERE id = ?');
export const deleteChallenge = db.prepare('DELETE FROM challenges WHERE id = ?');

// --- Zahlungsanfragen ---
export const insertPayRequest = db.prepare(`
  INSERT INTO pay_requests (id, origin, to_address, amount, memo, status, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`);
export const getPayRequest = db.prepare('SELECT * FROM pay_requests WHERE id = ?');
export const updatePayRequestStatus = db.prepare(
  'UPDATE pay_requests SET status = ?, tx_digest = ? WHERE id = ?'
);

// Abgelaufene Einträge regelmäßig entsorgen.
export function cleanupExpired() {
  const t = now();
  db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare("UPDATE pay_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(t);
}
