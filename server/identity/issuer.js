// Aussteller-Seite von Identity Phase 1–2.
//
// WICHTIG / EHRLICH: Echte Alters-Aussteller (eID-/eIDAS-Wallets, KYC-Anbieter)
// und die On-Chain-Aussteller-DIDs des IOTA-Identity-Frameworks für Rebased sind
// noch in Entwicklung – sie werden implementiert, sobald sie veröffentlicht sind.
// Bis dahin stellt die Orange-Bar-Instanz ein klar markiertes DEMO-Credential
// aus (Selbstauskunft, "demo: true" im Credential, Demo-Flag in der
// Trust-Registry). Demo-Credentials werden für Mainnet-Projekte ABGELEHNT.
import { randomUUID } from 'node:crypto';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
import { decodeIotaPrivateKey } from '@iota/iota-sdk/cryptography';
import { encrypt, decrypt } from '../crypto.js';
import { didKeyFromPublicKey } from './didkey.js';
import { signCredentialJwt, nowSec } from './vc.js';
import {
  getInstanceIssuer, insertInstanceIssuer, insertTrustedIssuer,
  getWalletByUser, setWalletPublicKey,
  insertVaultCredential, now,
} from '../db.js';
import { loadKeypair } from '../wallet.js';

const DEMO_CREDENTIAL_TTL = 180 * 24 * 3600; // 180 Tage

/** Instanz-Aussteller sicherstellen (Keypair + did:key, wie die Gas Station verwahrt). */
export function ensureInstanceIssuer() {
  let row = getInstanceIssuer.get();
  if (!row) {
    const keypair = new Ed25519Keypair();
    const did = didKeyFromPublicKey(keypair.getPublicKey().toRawBytes());
    insertInstanceIssuer.run(did, encrypt(Buffer.from(keypair.getSecretKey(), 'utf8')), now());
    row = getInstanceIssuer.get();
    console.log(`[orange-bar] Instanz-Aussteller (Demo) angelegt: ${did}`);
  }
  // Trust-Registry: Demo-Aussteller für AgeCredentials (demo=1 → Mainnet lehnt ab).
  insertTrustedIssuer.run('instance', 'AgeCredential', row.did,
    1, 'Demo-Aussteller der Instanz – in Entwicklung: wird durch eID/KYC-Aussteller ersetzt, sobald veröffentlicht');
  return row;
}

function loadInstanceIssuerKeypair() {
  const row = ensureInstanceIssuer();
  return { keypair: Ed25519Keypair.fromSecretKey(decrypt(row.key_ciphertext).toString('utf8')), did: row.did };
}

/**
 * did:key des Nutzers (Off-Chain-Stufe; On-Chain-did:iota folgt mit dem
 * Framework-Release). Der Pubkey wird aus dem Wallet-Datensatz gelesen
 * (Non-Custodial: beim Setup mitgeliefert; Custodial: beim ersten Zugriff
 * aus dem Server-Keypair abgeleitet und gecacht).
 */
export function getUserDid(userId) {
  const row = getWalletByUser.get(userId);
  if (!row) return null;
  if (row.public_key) return didKeyFromPublicKey(new Uint8Array(row.public_key));
  const keypair = loadKeypair(userId);
  if (!keypair) return null;
  const publicKey = keypair.getPublicKey().toRawBytes();
  setWalletPublicKey.run(Buffer.from(publicKey), userId);
  return didKeyFromPublicKey(publicKey);
}

/** Aus einem Geburtsdatum die datensparsamen Alters-Flags berechnen. */
export function ageFlags(birthdateStr, at = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthdateStr || ''));
  if (!m) throw new Error('Geburtsdatum bitte als JJJJ-MM-TT angeben.');
  const birth = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(birth.getTime()) || birth > at) throw new Error('Ungültiges Geburtsdatum.');
  let age = at.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < birth.getUTCMonth() ||
    (at.getUTCMonth() === birth.getUTCMonth() && at.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  if (age > 130) throw new Error('Ungültiges Geburtsdatum.');
  return { ageOver16: age >= 16, ageOver18: age >= 18 };
}

/**
 * DEMO: Alters-Credential per Selbstauskunft ausstellen und im Vault ablegen.
 * Es enthält NUR die booleschen Flags (ageOver16/18) – das Geburtsdatum wird
 * nach der Berechnung verworfen und nirgends gespeichert.
 */
export async function issueDemoAgeCredential(userId, birthdateStr) {
  const subjectDid = getUserDid(userId);
  if (!subjectDid) throw new Error('Für dieses Konto ist noch keine Identity verfügbar (Self-Custody: folgt in Phase 3).');
  const claims = ageFlags(birthdateStr); // Geburtsdatum verlässt diese Funktion nicht
  const { keypair, did } = loadInstanceIssuerKeypair();
  const expiresAt = nowSec() + DEMO_CREDENTIAL_TTL;
  const jwt = await signCredentialJwt({
    issuerKeypair: keypair, issuerDid: did, subjectDid,
    type: 'AgeCredential', claims, expiresAt, demo: true,
  });
  const id = randomUUID();
  insertVaultCredential.run(id, userId, 'AgeCredential', did, 'jwt-vc',
    encrypt(Buffer.from(jwt, 'utf8')), 1, expiresAt, now());
  return { id, type: 'AgeCredential', issuerDid: did, demo: true, expiresAt, claims };
}
