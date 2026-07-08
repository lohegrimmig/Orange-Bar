// SQLite-Persistenz: Nutzer, Passkey-Credentials, Sessions, Challenges,
// ausstehende Transaktionen, Zahlungsanfragen (In-Game-SDK) und Gas Station.
// Schema-Migrationen laufen über PRAGMA user_version.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Migrationen ----------
const MIGRATIONS = [
  // v1: Grundschema
  `
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
    device_type     TEXT,
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
  CREATE TABLE IF NOT EXISTS challenges (
    id          TEXT PRIMARY KEY,            -- UUID
    kind        TEXT NOT NULL,               -- register | login | tx | 2fa | totp-setup
    user_id     TEXT,
    challenge   TEXT NOT NULL,
    payload     TEXT,                        -- JSON
    expires_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pay_requests (
    id          TEXT PRIMARY KEY,
    origin      TEXT NOT NULL,
    to_address  TEXT NOT NULL,
    amount      TEXT NOT NULL,               -- Nanos als String
    memo        TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    tx_digest   TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,
  // v2: Admin, Netzwerk-Präferenz, 2FA, Gas Station
  `
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet';
  ALTER TABLE users ADD COLUMN totp_secret BLOB;                -- verschlüsselt
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS gas_station (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    address         TEXT NOT NULL,
    key_ciphertext  BLOB NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 0,
    amount_nanos    TEXT NOT NULL DEFAULT '100000000',          -- 0,1 IOTA Startgas
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gas_grants (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network     TEXT NOT NULL,
    amount      TEXT NOT NULL,
    kind        TEXT NOT NULL,               -- auto | manual
    tx_digest   TEXT,
    status      TEXT NOT NULL,               -- success | failed
    error       TEXT,
    created_at  INTEGER NOT NULL
  );
  `,
];

function migrate() {
  let version = db.pragma('user_version', { simple: true });
  while (version < MIGRATIONS.length) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
    version++;
  }
}
migrate();

export const now = () => Math.floor(Date.now() / 1000);

// --- Nutzer ---
export const insertUser = db.prepare(
  'INSERT INTO users (id, username, display_name, created_at, is_admin) VALUES (?, ?, ?, ?, ?)'
);
export const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
export const getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
export const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
export const listUsers = db.prepare(`
  SELECT u.id, u.username, u.is_admin, u.network, u.totp_enabled, u.created_at, w.address
  FROM users u LEFT JOIN wallets w ON w.user_id = u.id
  ORDER BY u.created_at DESC LIMIT 200`);
export const setUserNetwork = db.prepare('UPDATE users SET network = ? WHERE id = ?');
export const setUserTotp = db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?');

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

// --- Gas Station ---
export const getStation = db.prepare('SELECT * FROM gas_station WHERE id = 1');
export const insertStation = db.prepare(
  'INSERT INTO gas_station (id, address, key_ciphertext, enabled, amount_nanos, created_at) VALUES (1, ?, ?, 0, ?, ?)'
);
export const updateStationConfig = db.prepare(
  'UPDATE gas_station SET enabled = ?, amount_nanos = ? WHERE id = 1'
);
export const insertGasGrant = db.prepare(`
  INSERT INTO gas_grants (id, user_id, network, amount, kind, tx_digest, status, error, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export const listGasGrants = db.prepare(`
  SELECT g.*, u.username FROM gas_grants g JOIN users u ON u.id = g.user_id
  ORDER BY g.created_at DESC LIMIT 50`);

// Abgelaufene Einträge regelmäßig entsorgen.
export function cleanupExpired() {
  const t = now();
  db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare("UPDATE pay_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(t);
}
