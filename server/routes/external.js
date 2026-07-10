// Externe App-Anbindung: Mintly Lab Login & Auszahlungs-Adresse freigeben.
// Ablauf: App leitet mit ?app_login=… hierher → Passkey-Bestätigung → Signatur/Adresse zurück.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from '../config.js';
import {
  getCredentialById, getCredentialsByUser, updateCredentialCounter,
  insertChallenge, getChallenge, deleteChallenge, now,
} from '../db.js';
import { getAddress, signPersonalMessageForUser, isSelfCustody } from '../wallet.js';
import { requireAuth } from '../session.js';

export const externalRouter = Router();
externalRouter.use(requireAuth);

function parseOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isTrustedAppOrigin(origin) {
  return origin && config.trustedAppOrigins.includes(origin);
}

function normalizeApiBase(apiBase) {
  return String(apiBase || '').trim().replace(/\/+$/, '');
}

function apiOrigin(apiBase) {
  const base = normalizeApiBase(apiBase);
  if (!base) return null;
  try {
    return new URL(base.endsWith('/api') ? base : `${base}/api`).origin;
  } catch {
    return null;
  }
}

function validateAppRequest(appApiBase, appReturnUrl) {
  const returnOrigin = parseOrigin(appReturnUrl);
  if (!returnOrigin || !isTrustedAppOrigin(returnOrigin)) {
    return { error: 'Rückleitungs-URL nicht erlaubt.' };
  }
  const origin = apiOrigin(appApiBase);
  if (!origin || !isTrustedAppOrigin(origin)) {
    return { error: 'App-API nicht erlaubt.' };
  }
  return { returnOrigin, apiBase: normalizeApiBase(appApiBase) };
}

async function fetchMintlyChallenge(apiBase, address) {
  const url = `${apiBase}/auth/wallet/challenge`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  if (!data.challenge || !data.nonce) throw new Error('Ungültige Challenge-Antwort.');
  return data;
}

// Schritt 1: Mintly-Challenge holen + Passkey-Challenge erzeugen.
externalRouter.post('/login/prepare', async (req, res) => {
  const { appApiBase, appReturnUrl, mode } = req.body || {};
  const check = validateAppRequest(appApiBase, appReturnUrl);
  if (check.error) return res.status(403).json({ error: check.error });

  const address = getAddress(req.user.id);
  if (!address) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });

  const flowMode = mode === 'payout' ? 'payout' : 'login';
  let mintly;
  if (flowMode === 'login') {
    try {
      mintly = await fetchMintlyChallenge(check.apiBase, address);
    } catch (err) {
      return res.status(502).json({ error: `Challenge konnte nicht geladen werden: ${err.message}` });
    }
  }

  const allowCredentials = getCredentialsByUser.all(req.user.id).map((c) => ({
    id: c.id,
    transports: JSON.parse(c.transports || '[]'),
  }));
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials,
  });

  const challengeId = randomUUID();
  insertChallenge.run(
    challengeId,
    'app-login',
    req.user.id,
    options.challenge,
    JSON.stringify({
      appReturnUrl,
      appApiBase: check.apiBase,
      address,
      mode: flowMode,
      nonce: mintly?.nonce ?? null,
      mintlyChallenge: mintly?.challenge ?? null,
    }),
    now() + config.txChallengeTtlSeconds,
  );

  res.json({
    challengeId,
    options,
    address: `${address.slice(0, 10)}…${address.slice(-6)}`,
    mode: flowMode,
  });
});

// Schritt 2: Passkey bestätigen, ggf. Mintly-Challenge signieren, Redirect-Parameter liefern.
externalRouter.post('/login/confirm', async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = getChallenge.get(String(challengeId || ''));
  if (!row || row.kind !== 'app-login' || row.user_id !== req.user.id) {
    return res.status(400).json({ error: 'Unbekannte Login-Challenge.' });
  }
  deleteChallenge.run(row.id);
  if (row.expires_at < now()) {
    return res.status(400).json({ error: 'Bestätigung abgelaufen – bitte erneut versuchen.' });
  }

  const cred = getCredentialById.get(response?.id);
  if (!cred || cred.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Passkey gehört nicht zu diesem Konto.' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: cred.public_key,
        counter: cred.counter,
        transports: JSON.parse(cred.transports || '[]'),
      },
    });
  } catch (err) {
    return res.status(400).json({ error: `Passkey-Prüfung fehlgeschlagen: ${err.message}` });
  }
  if (!verification.verified) return res.status(401).json({ error: 'Bestätigung fehlgeschlagen.' });
  updateCredentialCounter.run(verification.authenticationInfo.newCounter, cred.id);

  const payload = JSON.parse(row.payload || '{}');
  const { appReturnUrl, address, mode, nonce, mintlyChallenge } = payload;

  if (mode === 'payout') {
    return res.json({
      ok: true,
      mode: 'payout',
      address,
      redirect: buildRedirect(appReturnUrl, { ob_payout: '1', ob_address: address }),
    });
  }

  if (!mintlyChallenge || !nonce) {
    return res.status(400).json({ error: 'Login-Challenge unvollständig.' });
  }

  if (isSelfCustody(req.user.id)) {
    return res.status(503).json({
      error: 'Signierter Wallet-Login ist im Non-Custodial-Modus nicht verfügbar. Nutze den Payout-Modus (Adresse) oder ORANGE_CUSTODIAL_MODE=1 (siehe docs/CUSTODIAL.md).',
      code: 'non-custodial-login',
    });
  }

  try {
    const { signature } = await signPersonalMessageForUser(req.user.id, mintlyChallenge);
    res.json({
      ok: true,
      mode: 'login',
      address,
      nonce,
      signature,
      redirect: buildRedirect(appReturnUrl, {
        ob_login: '1',
        ob_address: address,
        ob_nonce: nonce,
        ob_signature: signature,
      }),
    });
  } catch (err) {
    res.status(502).json({ error: `Signatur fehlgeschlagen: ${err.message}` });
  }
});

function buildRedirect(returnUrl, params) {
  try {
    const url = new URL(returnUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, v);
    }
    return url.toString();
  } catch {
    return null;
  }
}
