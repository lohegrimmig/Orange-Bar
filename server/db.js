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
  // v3: benannte Passkeys (Geräte) – mehrere pro Konto
  `
  ALTER TABLE credentials ADD COLUMN label TEXT;
  `,
  // v4: Web-Push-Abonnements für eingehende-Zahlung-Benachrichtigungen
  `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  -- Zuletzt gesehener Kontostand je Nutzer/Netzwerk, um Eingänge zu erkennen.
  CREATE TABLE IF NOT EXISTS balance_watch (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network       TEXT NOT NULL,
    last_balance  TEXT NOT NULL,
    PRIMARY KEY (user_id, network)
  );
  `,
  // v5: Multi-Tenant "Barkeeper"-Projekte mit eigener Gas Station und
  // Pro-Nutzer-Limit. Jeder eingebundene Betreiber = Barkeeper eines Projekts.
  `
  CREATE TABLE IF NOT EXISTS projects (
    id                    TEXT PRIMARY KEY,       -- öffentliche Projekt-ID (SDK)
    barkeeper_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    secret_hash           TEXT NOT NULL,          -- SHA-256 des Projekt-Secrets
    station_address       TEXT NOT NULL,
    station_key_ciphertext BLOB NOT NULL,
    network               TEXT NOT NULL DEFAULT 'testnet',
    gas_per_grant         TEXT NOT NULL DEFAULT '50000000',  -- 0,05 IOTA
    max_grants_per_user   INTEGER NOT NULL DEFAULT 1,
    allowed_origins       TEXT NOT NULL DEFAULT '[]',        -- JSON-Array; [] = alle
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_grants (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network     TEXT NOT NULL,
    amount      TEXT NOT NULL,
    tx_digest   TEXT,
    status      TEXT NOT NULL,                    -- pending | success | failed
    error       TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pgrants_pu ON project_grants(project_id, user_id, status);
  ALTER TABLE pay_requests ADD COLUMN project_id TEXT;
  `,
  // v6: Self-Custody (non-custodial via WebAuthn-PRF). Der Wallet-Seed liegt dann
  // NICHT mehr serverseitig, sondern nur per PRF verschlüsselt je Passkey.
  `
  ALTER TABLE wallets ADD COLUMN self_custody INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS self_custody_keys (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL,
    wrapped       TEXT NOT NULL,   -- base64(iv||ciphertext), PRF-verschlüsselter Seed
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, credential_id)
  );
  `,
  // v7: Identity Phase 1–2 (siehe docs/IDENTITY_ARCHITECTURE.md).
  // Credential Vault, Alters-Policies je Projekt, Entitlements, Trust-Registry,
  // Verifizierungsanfragen (SDK) und der Instanz-Aussteller (Demo, did:key).
  `
  ALTER TABLE wallets ADD COLUMN public_key BLOB;          -- Ed25519-Pubkey (für did:key)
  ALTER TABLE projects ADD COLUMN age_policy INTEGER NOT NULL DEFAULT 0;  -- 0 | 16 | 18

  -- Vault: verschlüsselte Verifiable Credentials des Nutzers.
  -- ("credentials" ist bereits die WebAuthn-Tabelle, daher eigener Name.)
  CREATE TABLE IF NOT EXISTS credentials_vault (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,            -- z. B. 'AgeCredential'
    issuer_did   TEXT NOT NULL,
    format       TEXT NOT NULL,            -- 'jwt-vc' (SD-JWT/BBS+ folgen mit Framework-Release)
    ciphertext   BLOB NOT NULL,            -- AES-256-GCM-verschlüsseltes VC
    demo         INTEGER NOT NULL DEFAULT 0,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL
  );

  -- Gecachte, datensparsame Prüf-Ergebnisse: KEINE Geburtsdaten/Namen,
  -- nur "Policy erfüllt / von wem / bis wann / Proof-Hash fürs Audit".
  CREATE TABLE IF NOT EXISTS entitlements (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    policy_id    TEXT NOT NULL,            -- 'age16' | 'age18'
    issuer_did   TEXT NOT NULL,
    proof_hash   TEXT NOT NULL,
    verified_at  INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, project_id, policy_id)
  );

  -- Welche Aussteller-DIDs für welchen Credential-Typ akzeptiert werden.
  CREATE TABLE IF NOT EXISTS trusted_issuers (
    scope           TEXT NOT NULL,         -- 'instance' oder eine project_id
    credential_type TEXT NOT NULL,
    issuer_did      TEXT NOT NULL,
    demo            INTEGER NOT NULL DEFAULT 0,  -- Demo-Aussteller: auf Mainnet abgelehnt
    note            TEXT,
    PRIMARY KEY (scope, credential_type, issuer_did)
  );

  -- Verifizierungsanfragen aus dem SDK (Spiegelbild der pay_requests).
  CREATE TABLE IF NOT EXISTS verify_requests (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    policy_id   TEXT NOT NULL,
    origin      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|verified|rejected|expired
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  -- Instanz-Aussteller (Demo): Ed25519-Keypair + did:key, wie die Gas Station verwahrt.
  CREATE TABLE IF NOT EXISTS instance_issuer (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    did            TEXT NOT NULL,
    key_ciphertext BLOB NOT NULL,
    created_at     INTEGER NOT NULL
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
export const countCredentialsByUser = db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?');
export const deleteCredential = db.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?');
export const renameCredential = db.prepare('UPDATE credentials SET label = ? WHERE id = ? AND user_id = ?');

// --- Wallets ---
export const insertWallet = db.prepare(
  'INSERT INTO wallets (user_id, address, key_ciphertext, scheme, created_at) VALUES (?, ?, ?, ?, ?)'
);
export const getWalletByUser = db.prepare('SELECT * FROM wallets WHERE user_id = ?');

// --- Self-Custody (WebAuthn-PRF) ---
export const setWalletSelfCustody = db.prepare(
  'UPDATE wallets SET self_custody = ?, key_ciphertext = ? WHERE user_id = ?'
);
export const upsertSelfCustodyKey = db.prepare(`
  INSERT INTO self_custody_keys (user_id, credential_id, wrapped, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id, credential_id) DO UPDATE SET wrapped = excluded.wrapped`);
export const getSelfCustodyKeys = db.prepare(
  'SELECT credential_id, wrapped FROM self_custody_keys WHERE user_id = ?');
export const getSelfCustodyKey = db.prepare(
  'SELECT wrapped FROM self_custody_keys WHERE user_id = ? AND credential_id = ?');

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
  INSERT INTO pay_requests (id, origin, to_address, amount, memo, status, created_at, expires_at, project_id)
  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`);
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

// --- Web-Push ---
export const insertPushSub = db.prepare(`
  INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
    p256dh = excluded.p256dh, auth = excluded.auth`);
export const getPushSubsByUser = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
export const deletePushSub = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
export const getAllUsersWithPush = db.prepare(
  'SELECT DISTINCT user_id FROM push_subscriptions');

// --- Balance-Watcher ---
export const getBalanceWatch = db.prepare('SELECT * FROM balance_watch WHERE user_id = ? AND network = ?');
export const upsertBalanceWatch = db.prepare(`
  INSERT INTO balance_watch (user_id, network, last_balance) VALUES (?, ?, ?)
  ON CONFLICT(user_id, network) DO UPDATE SET last_balance = excluded.last_balance`);

// --- Barkeeper-Projekte ---
export const insertProject = db.prepare(`
  INSERT INTO projects (id, barkeeper_id, name, secret_hash, station_address,
    station_key_ciphertext, network, gas_per_grant, max_grants_per_user, allowed_origins, enabled, created_at)
  VALUES (@id, @barkeeper_id, @name, @secret_hash, @station_address, @station_key_ciphertext,
    @network, @gas_per_grant, @max_grants_per_user, @allowed_origins, 1, @created_at)`);
export const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
export const getProjectsByBarkeeper = db.prepare(
  'SELECT * FROM projects WHERE barkeeper_id = ? ORDER BY created_at DESC');
export const updateProjectPolicy = db.prepare(`
  UPDATE projects SET gas_per_grant = @gas_per_grant, max_grants_per_user = @max_grants_per_user,
    allowed_origins = @allowed_origins, enabled = @enabled, network = @network,
    age_policy = @age_policy
  WHERE id = @id AND barkeeper_id = @barkeeper_id`);
export const deleteProject = db.prepare('DELETE FROM projects WHERE id = ? AND barkeeper_id = ?');

// Grant-Zählung & -Protokoll (pending zählt mit → race-sicher).
export const countProjectGrantsForUser = db.prepare(
  "SELECT COUNT(*) AS n FROM project_grants WHERE project_id = ? AND user_id = ? AND status IN ('success','pending')");
export const insertProjectGrant = db.prepare(`
  INSERT INTO project_grants (id, project_id, user_id, network, amount, tx_digest, status, error, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export const updateProjectGrant = db.prepare(
  'UPDATE project_grants SET status = ?, tx_digest = ?, error = ? WHERE id = ?');
export const listProjectGrants = db.prepare(`
  SELECT g.*, u.username FROM project_grants g JOIN users u ON u.id = g.user_id
  WHERE g.project_id = ? ORDER BY g.created_at DESC LIMIT 50`);

// --- Identity: Wallet-Pubkey (für did:key) ---
export const setWalletPublicKey = db.prepare('UPDATE wallets SET public_key = ? WHERE user_id = ?');

// --- Identity: Credential Vault ---
export const insertVaultCredential = db.prepare(`
  INSERT INTO credentials_vault (id, user_id, type, issuer_did, format, ciphertext, demo, expires_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export const getVaultCredential = db.prepare('SELECT * FROM credentials_vault WHERE id = ? AND user_id = ?');
export const listVaultCredentials = db.prepare(
  'SELECT id, type, issuer_did, format, demo, expires_at, created_at FROM credentials_vault WHERE user_id = ? ORDER BY created_at DESC');
export const deleteVaultCredential = db.prepare('DELETE FROM credentials_vault WHERE id = ? AND user_id = ?');

// --- Identity: Entitlements ---
export const upsertEntitlement = db.prepare(`
  INSERT INTO entitlements (user_id, project_id, policy_id, issuer_did, proof_hash, verified_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, project_id, policy_id) DO UPDATE SET
    issuer_did = excluded.issuer_did, proof_hash = excluded.proof_hash,
    verified_at = excluded.verified_at, expires_at = excluded.expires_at`);
export const getEntitlement = db.prepare(
  'SELECT * FROM entitlements WHERE user_id = ? AND project_id = ? AND policy_id = ?');
export const listEntitlements = db.prepare(
  'SELECT project_id, policy_id, issuer_did, verified_at, expires_at FROM entitlements WHERE user_id = ?');

// --- Identity: Trust-Registry ---
export const insertTrustedIssuer = db.prepare(`
  INSERT OR IGNORE INTO trusted_issuers (scope, credential_type, issuer_did, demo, note)
  VALUES (?, ?, ?, ?, ?)`);
export const findTrustedIssuer = db.prepare(`
  SELECT * FROM trusted_issuers
  WHERE credential_type = ? AND issuer_did = ? AND scope IN ('instance', ?)`);

// --- Identity: Verifizierungsanfragen (SDK) ---
export const insertVerifyRequest = db.prepare(`
  INSERT INTO verify_requests (id, project_id, policy_id, origin, status, created_at, expires_at)
  VALUES (?, ?, ?, ?, 'pending', ?, ?)`);
export const getVerifyRequest = db.prepare('SELECT * FROM verify_requests WHERE id = ?');
export const updateVerifyRequestStatus = db.prepare('UPDATE verify_requests SET status = ? WHERE id = ?');

// --- Identity: Instanz-Aussteller (Demo) ---
export const getInstanceIssuer = db.prepare('SELECT * FROM instance_issuer WHERE id = 1');
export const insertInstanceIssuer = db.prepare(
  'INSERT INTO instance_issuer (id, did, key_ciphertext, created_at) VALUES (1, ?, ?, ?)');

// --- Identity: Projekt-Policy ---
export const setProjectAgePolicy = db.prepare(
  'UPDATE projects SET age_policy = ? WHERE id = ? AND barkeeper_id = ?');

// Abgelaufene Einträge regelmäßig entsorgen.
export function cleanupExpired() {
  const t = now();
  db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare("UPDATE pay_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(t);
  db.prepare("UPDATE verify_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(t);
  db.prepare('DELETE FROM entitlements WHERE expires_at < ?').run(t);
}
