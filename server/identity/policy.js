// Policy-Engine (Identity Phase 2): wertet Projekt-Policies gegen Credentials
// aus und cached die Ergebnisse als datensparsame "Entitlements".
// Aktuell umgesetzt: Alters-Policies (age16/age18). Weitere Policy-Typen
// (Region, KYC-Stufe, Mitgliedschaft, Kindersicherung – siehe Architektur-Doku)
// folgen auf denselben Primitiven (in Entwicklung: wird implementiert, sobald
// die zugehörigen Aussteller/Framework-Teile veröffentlicht sind).
import {
  findTrustedIssuer, upsertEntitlement, getEntitlement, now,
} from '../db.js';
import { proofHash, nowSec } from './vc.js';

// Entitlement-Laufzeit: höchstens 180 Tage, nie länger als das Credential gilt.
const ENTITLEMENT_MAX_TTL = 180 * 24 * 3600;

/** Welche Policy-IDs ein Projekt verlangt (aus projects.age_policy). */
export function requiredPolicyIds(project) {
  if (!project) return [];
  if (project.age_policy === 18) return ['age18'];
  if (project.age_policy === 16) return ['age16'];
  return [];
}

/** Prüft, ob ein Nutzer alle Policies eines Projekts erfüllt (O(1)-Lookup). */
export function policyCheck(project, userId) {
  const missing = [];
  for (const policyId of requiredPolicyIds(project)) {
    const e = getEntitlement.get(userId, project.id, policyId);
    if (!e || e.expires_at <= now()) missing.push(policyId);
  }
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}

/** Welcher Credential-Typ und welches Claim-Prädikat zu einer Policy gehören. */
export function policyRequirement(policyId) {
  const map = {
    age16: { credentialType: 'AgeCredential', claim: 'ageOver16' },
    age18: { credentialType: 'AgeCredential', claim: 'ageOver18' },
  };
  return map[policyId] || null;
}

/**
 * Wertet ein verifiziertes Credential (JWT-Payload) gegen eine Policy aus und
 * schreibt bei Erfolg das Entitlement. Vertrauens-Regeln:
 *  - Aussteller muss in der Trust-Registry stehen (Scope 'instance' oder Projekt).
 *  - Demo-Aussteller werden für Mainnet-Projekte ABGELEHNT (Demo-Phase, bis
 *    echte Aussteller veröffentlicht sind).
 * @returns {{ok:true, entitlement:object}|{ok:false, error:string, code:string}}
 */
export function evaluateAndGrant({ project, userId, policyId, vcPayload, jwt }) {
  const req = policyRequirement(policyId);
  if (!req) return { ok: false, code: 'unknown-policy', error: `Unbekannte Policy: ${policyId}` };

  const vcTypes = vcPayload.vc?.type || [];
  if (!vcTypes.includes(req.credentialType)) {
    return { ok: false, code: 'wrong-type', error: `Policy ${policyId} erwartet ein ${req.credentialType}.` };
  }

  const issuerDid = vcPayload.iss;
  const trust = findTrustedIssuer.get(req.credentialType, issuerDid, project.id);
  if (!trust) {
    return { ok: false, code: 'untrusted-issuer', error: 'Aussteller ist nicht in der Trust-Registry.' };
  }
  if (trust.demo && project.network === 'mainnet') {
    return {
      ok: false, code: 'demo-on-mainnet',
      error: 'Demo-Nachweise gelten nicht für Mainnet-Projekte. Echte Aussteller (eID/KYC) sind in Entwicklung und werden implementiert, sobald veröffentlicht.',
    };
  }

  if (vcPayload.vc.credentialSubject?.[req.claim] !== true) {
    return { ok: false, code: 'predicate-failed', error: 'Der Nachweis erfüllt die Anforderung nicht.' };
  }

  const expiresAt = Math.min(vcPayload.exp || Infinity, nowSec() + ENTITLEMENT_MAX_TTL);
  upsertEntitlement.run(userId, project.id, policyId, issuerDid, proofHash(jwt), now(), expiresAt);
  return {
    ok: true,
    entitlement: { projectId: project.id, policyId, issuerDid, expiresAt, demo: !!trust.demo },
  };
}
