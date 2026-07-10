// Verifiable Credentials als JWT (EdDSA/Ed25519) – Phase-1-Format der
// Identity-Architektur. SD-JWT-Selective-Disclosure und BBS+-Zero-Knowledge
// (unlinkbare Vorlagen) folgen, sobald das IOTA-Identity-Framework für
// Rebased stabil veröffentlicht ist – bis dahin ist dieses schlanke,
// standardnahe JWT-VC-Format die produktive Basis (in Entwicklung: Demo).
import { createHash, randomUUID } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { publicKeyFromDidKey } from './didkey.js';

// noble braucht SHA-512; in Node über node:crypto verdrahten.
ed.etc.sha512Async = async (...msgs) => {
  const h = createHash('sha512');
  for (const m of msgs) h.update(m);
  return new Uint8Array(h.digest());
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uJson = (obj) => b64u(Buffer.from(JSON.stringify(obj), 'utf8'));

export const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Erstellt ein signiertes JWT-VC.
 * @param {object} p
 * @param {import('@iota/iota-sdk/keypairs/ed25519').Ed25519Keypair} p.issuerKeypair
 * @param {string} p.issuerDid    did:key des Ausstellers
 * @param {string} p.subjectDid   did:key des Inhabers
 * @param {string} p.type         z. B. 'AgeCredential'
 * @param {object} p.claims       credentialSubject-Claims (ohne id)
 * @param {number} p.expiresAt    Unix-Sekunden
 * @param {boolean} [p.demo]      Demo-Aussteller-Markierung (ehrlich sichtbar)
 * @returns {Promise<string>} kompaktes JWT
 */
export async function signCredentialJwt({ issuerKeypair, issuerDid, subjectDid, type, claims, expiresAt, demo = false }) {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: `${issuerDid}#key-1` };
  const iat = nowSec();
  const payload = {
    iss: issuerDid,
    sub: subjectDid,
    jti: `urn:uuid:${randomUUID()}`,
    nbf: iat,
    iat,
    exp: expiresAt,
    vc: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', type],
      credentialSubject: { id: subjectDid, ...claims },
      ...(demo ? { demo: true } : {}),
    },
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const signature = await issuerKeypair.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64u(signature)}`;
}

/**
 * Prüft ein JWT-VC: EdDSA-Signatur gegen den did:key des Ausstellers,
 * Zeitfenster (nbf/exp) und Grundstruktur.
 * @returns {Promise<{header:object, payload:object}>} bei Erfolg; wirft sonst.
 */
export async function verifyCredentialJwt(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('Kein kompaktes JWT.');
  const [h64, p64, s64] = parts;
  const header = JSON.parse(Buffer.from(h64, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
  if (header.alg !== 'EdDSA') throw new Error(`Unerwarteter Algorithmus: ${header.alg}`);
  if (!payload.iss || !payload.vc || !payload.vc.credentialSubject) {
    throw new Error('Kein Verifiable Credential.');
  }

  const publicKey = publicKeyFromDidKey(payload.iss);
  const ok = await ed.verifyAsync(
    Uint8Array.from(Buffer.from(s64, 'base64url')),
    new TextEncoder().encode(`${h64}.${p64}`),
    publicKey
  );
  if (!ok) throw new Error('Signatur ungültig.');

  const t = nowSec();
  if (payload.nbf && t < payload.nbf - 60) throw new Error('Credential ist noch nicht gültig.');
  if (payload.exp && t >= payload.exp) throw new Error('Credential ist abgelaufen.');
  return { header, payload };
}

/** SHA-256-Hash eines Nachweises (Audit-Spur ohne personenbezogene Daten). */
export function proofHash(jwt) {
  return createHash('sha256').update(jwt).digest('hex');
}
