// Identity-API (Phase 1–2): Credential Vault, Demo-Aussteller, Passkey-
// bestätigte Nachweis-Vorlage ("present") und Verifizierungsanfragen fürs SDK.
//
// Hinweis zur Demo-Phase: On-Chain-DIDs (did:iota-Identity-Objekte), SD-JWT/BBS+
// und externe eID-/KYC-Aussteller sind in Entwicklung und werden implementiert,
// sobald das IOTA-Identity-Framework für Rebased bzw. die Aussteller
// veröffentlicht sind. Bis dahin: did:key + instanzsignierte Demo-Credentials,
// die auf Mainnet-Projekten abgelehnt werden.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from '../config.js';
import { requireAuth } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import {
  getCredentialById, getCredentialsByUser, updateCredentialCounter,
  insertChallenge, getChallenge, deleteChallenge,
  listVaultCredentials, getVaultCredential, deleteVaultCredential,
  listEntitlements, getProject,
  insertVerifyRequest, getVerifyRequest, updateVerifyRequestStatus, now,
} from '../db.js';
import { decrypt } from '../crypto.js';
import { getUserDid, issueDemoAgeCredential, ensureInstanceIssuer } from '../identity/issuer.js';
import { verifyCredentialJwt } from '../identity/vc.js';
import { evaluateAndGrant, policyCheck, requiredPolicyIds, policyRequirement } from '../identity/policy.js';
import { originAllowed } from '../projects.js';

export const identityRouter = Router();
export const verifyRouter = Router();

const VERIFY_TTL = 600; // 10 Minuten, wie Zahlungsanfragen

// ================= Verifizierungsanfragen (SDK, CORS-offen) =================

// Spiel erstellt eine Verifizierungsanfrage (Origin-geprüft wie bei Zahlungen).
verifyRouter.post('/request', (req, res) => {
  const project = getProject.get(String(req.body?.projectId || ''));
  if (!project) return res.status(404).json({ error: 'Unbekanntes Projekt.' });
  if (!originAllowed(project, req.get('origin'))) {
    return res.status(403).json({ error: 'Diese Herkunft ist für das Projekt nicht freigegeben.' });
  }
  const policyId = String(req.body?.policy || requiredPolicyIds(project)[0] || '');
  if (!policyRequirement(policyId)) {
    return res.status(400).json({ error: 'Keine gültige Policy angegeben (z. B. age18).' });
  }
  const id = randomUUID();
  insertVerifyRequest.run(id, project.id, policyId, req.get('origin') || 'unbekannt', now(), now() + VERIFY_TTL);
  res.json({ id, policy: policyId, expiresIn: VERIFY_TTL });
});

// Status (Spiel-Polling und Wallet-UI).
verifyRouter.get('/request/:id', (req, res) => {
  const vr = getVerifyRequest.get(req.params.id);
  if (!vr) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
  const expired = vr.status === 'pending' && vr.expires_at < now();
  res.json({
    id: vr.id, projectId: vr.project_id, policy: vr.policy_id,
    origin: vr.origin, status: expired ? 'expired' : vr.status,
  });
});

// Nutzer lehnt ab.
verifyRouter.post('/request/:id/reject', (req, res) => {
  const vr = getVerifyRequest.get(req.params.id);
  if (!vr) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
  if (vr.status === 'pending') updateVerifyRequestStatus.run('rejected', vr.id);
  res.json({ ok: true });
});

// ================= Identity (session-gebunden) =================

identityRouter.use(requireAuth);

// Überblick: eigene DID, Vault-Inhalt, Entitlements, Demo-Status-Infos.
identityRouter.get('/me', (req, res) => {
  ensureInstanceIssuer();
  res.json({
    did: getUserDid(req.user.id), // null bei Self-Custody-Konten (Phase 3)
    didStage: 'did:key', // On-Chain did:iota: in Entwicklung, kommt mit Framework-Release
    credentials: listVaultCredentials.all(req.user.id).map((c) => ({
      id: c.id, type: c.type, issuerDid: c.issuer_did, format: c.format,
      demo: !!c.demo, expiresAt: c.expires_at, createdAt: c.created_at,
    })),
    entitlements: listEntitlements.all(req.user.id),
  });
});

// DEMO-Aussteller: Alters-Credential per Selbstauskunft (Geburtsdatum wird
// NICHT gespeichert – nur die booleschen Flags landen im Credential).
identityRouter.post('/demo-issue',
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `demo-issue:${req.ip}` }),
  async (req, res) => {
    try {
      const meta = await issueDemoAgeCredential(req.user.id, req.body?.birthdate);
      res.json({ ok: true, credential: meta });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

identityRouter.delete('/credentials/:id', (req, res) => {
  const changed = deleteVaultCredential.run(req.params.id, req.user.id).changes;
  if (!changed) return res.status(404).json({ error: 'Credential nicht gefunden.' });
  res.json({ ok: true });
});

// Entitlement-Status für ein Projekt (Wallet-UI entscheidet, ob verifiziert werden muss).
identityRouter.get('/status/:projectId', (req, res) => {
  const project = getProject.get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  const check = policyCheck(project, req.user.id);
  res.json({ required: requiredPolicyIds(project), ...check });
});

// ---------- Nachweis vorlegen: Schritt 1 (Passkey-Challenge) ----------
// Die Vorlage eines Credentials ist eine bewusste Einwilligung des Nutzers und
// wird deshalb – wie Transaktionen – mit einer frischen Passkey-Bestätigung
// (Face ID/Finger/Geräte-Code) autorisiert und an genau diese Daten gebunden.
identityRouter.post('/present/options', async (req, res) => {
  const { credentialId, projectId, policyId, verifyRequestId } = req.body || {};

  let project, policy;
  if (verifyRequestId) {
    const vr = getVerifyRequest.get(String(verifyRequestId));
    if (!vr || vr.status !== 'pending' || vr.expires_at < now()) {
      return res.status(400).json({ error: 'Verifizierungsanfrage ungültig oder abgelaufen.' });
    }
    project = getProject.get(vr.project_id);
    policy = vr.policy_id;
  } else {
    project = getProject.get(String(projectId || ''));
    policy = String(policyId || '');
  }
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  if (!policyRequirement(policy)) return res.status(400).json({ error: 'Unbekannte Policy.' });

  const cred = getVaultCredential.get(String(credentialId || ''), req.user.id);
  if (!cred) return res.status(404).json({ error: 'Credential nicht im Vault gefunden.' });

  const allowCredentials = getCredentialsByUser.all(req.user.id).map((c) => ({
    id: c.id, transports: JSON.parse(c.transports || '[]'),
  }));
  const options = await generateAuthenticationOptions({
    rpID: config.rpId, userVerification: 'required', allowCredentials,
  });
  const challengeId = randomUUID();
  insertChallenge.run(challengeId, 'present', req.user.id, options.challenge,
    JSON.stringify({ credentialId: cred.id, projectId: project.id, policyId: policy, verifyRequestId: verifyRequestId || null }),
    now() + 120);
  res.json({ challengeId, options });
});

// ---------- Nachweis vorlegen: Schritt 2 (prüfen & Entitlement) ----------
identityRouter.post('/present/confirm', async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = getChallenge.get(String(challengeId || ''));
  if (!row || row.kind !== 'present' || row.user_id !== req.user.id) {
    return res.status(400).json({ error: 'Unbekannte Challenge.' });
  }
  deleteChallenge.run(row.id); // Einmal-Verwendung
  if (row.expires_at < now()) return res.status(400).json({ error: 'Challenge abgelaufen.' });

  const passkey = getCredentialById.get(response?.id);
  if (!passkey || passkey.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Passkey gehört nicht zu diesem Konto.' });
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: row.challenge, expectedOrigin: config.origins,
      expectedRPID: config.rpId, requireUserVerification: true,
      credential: {
        id: passkey.id, publicKey: passkey.public_key, counter: passkey.counter,
        transports: JSON.parse(passkey.transports || '[]'),
      },
    });
  } catch (err) {
    return res.status(400).json({ error: `Passkey-Prüfung fehlgeschlagen: ${err.message}` });
  }
  if (!verification.verified) return res.status(401).json({ error: 'Bestätigung fehlgeschlagen.' });
  updateCredentialCounter.run(verification.authenticationInfo.newCounter, passkey.id);

  const { credentialId, projectId, policyId, verifyRequestId } = JSON.parse(row.payload);
  const cred = getVaultCredential.get(credentialId, req.user.id);
  const project = getProject.get(projectId);
  if (!cred || !project) return res.status(404).json({ error: 'Credential oder Projekt nicht mehr vorhanden.' });

  // Credential kryptografisch prüfen (Signatur, Ablauf) …
  const jwt = decrypt(cred.ciphertext).toString('utf8');
  let payload;
  try {
    ({ payload } = await verifyCredentialJwt(jwt));
  } catch (err) {
    return res.status(400).json({ error: `Credential ungültig: ${err.message}` });
  }
  // Inhaber-Bindung: das Credential muss auf die DID dieses Kontos lauten.
  if (payload.sub !== getUserDid(req.user.id)) {
    return res.status(403).json({ error: 'Credential gehört nicht zu diesem Konto.' });
  }

  // … und gegen die Policy auswerten (Trust-Registry, Demo-Mainnet-Sperre, Prädikat).
  const result = evaluateAndGrant({ project, userId: req.user.id, policyId, vcPayload: payload, jwt });
  if (!result.ok) return res.status(403).json({ error: result.error, code: result.code });

  if (verifyRequestId) updateVerifyRequestStatus.run('verified', verifyRequestId);
  res.json({ ok: true, entitlement: result.entitlement });
});

// Bereits verifiziert? Dann genügt fürs Teilen mit dem Spiel eine bewusste
// Bestätigung ohne erneuten Passkey (das Entitlement existiert schon).
identityRouter.post('/share/:verifyRequestId', (req, res) => {
  const vr = getVerifyRequest.get(req.params.verifyRequestId);
  if (!vr || vr.status !== 'pending' || vr.expires_at < now()) {
    return res.status(400).json({ error: 'Verifizierungsanfrage ungültig oder abgelaufen.' });
  }
  const project = getProject.get(vr.project_id);
  const check = policyCheck(project, req.user.id);
  if (!check.ok) return res.status(403).json({ error: 'Policy noch nicht erfüllt.', missing: check.missing });
  updateVerifyRequestStatus.run('verified', vr.id);
  res.json({ ok: true });
});
