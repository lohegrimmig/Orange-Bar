// Passkey-Registrierung & -Login (WebAuthn über @simplewebauthn/server).
// Ablauf jeweils zweistufig: /options liefert die Challenge,
// /verify prüft die Antwort des Authenticators (Face ID, Fingerabdruck …).
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from '../config.js';
import {
  insertUser, getUserByName, getUserById,
  insertCredential, getCredentialById, getCredentialsByUser, updateCredentialCounter,
  insertChallenge, getChallenge, deleteChallenge, now,
} from '../db.js';
import { createWalletForUser, getAddress } from '../wallet.js';
import { createSession, destroySession } from '../session.js';

export const authRouter = Router();

const CHALLENGE_TTL = 300; // 5 Minuten für Registrierung/Login

function storeChallenge(kind, userId, challenge, payload = null) {
  const id = randomUUID();
  insertChallenge.run(id, kind, userId, challenge, payload ? JSON.stringify(payload) : null, now() + CHALLENGE_TTL);
  return id;
}

function takeChallenge(id, kind) {
  const row = getChallenge.get(id);
  if (!row || row.kind !== kind) return null;
  deleteChallenge.run(id); // Einmal-Verwendung
  if (row.expires_at < now()) return null;
  return row;
}

// ---------- Registrierung ----------
authRouter.post('/register/options', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Nutzername: 3–32 Zeichen (a-z, 0-9, . _ -).' });
  }
  if (getUserByName.get(username)) {
    return res.status(409).json({ error: 'Nutzername ist bereits vergeben.' });
  }
  const userId = randomUUID();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: username,
    userDisplayName: username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',        // Passkey (discoverable credential)
      userVerification: 'required',   // Gesicht/Finger/PIN zwingend
    },
  });
  const challengeId = storeChallenge('register', userId, options.challenge, { username });
  res.json({ challengeId, options });
});

authRouter.post('/register/verify', async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = takeChallenge(challengeId, 'register');
  if (!row) return res.status(400).json({ error: 'Challenge abgelaufen – bitte erneut versuchen.' });
  const { username } = JSON.parse(row.payload);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    return res.status(400).json({ error: `Passkey-Prüfung fehlgeschlagen: ${err.message}` });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'Passkey konnte nicht verifiziert werden.' });
  }
  if (getUserByName.get(username)) {
    return res.status(409).json({ error: 'Nutzername ist inzwischen vergeben.' });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const userId = row.user_id;
  insertUser.run(userId, username, username, now());
  insertCredential.run(
    credential.id,
    userId,
    Buffer.from(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports || []),
    credentialDeviceType,
    credentialBackedUp ? 1 : 0,
    now()
  );
  const { address } = createWalletForUser(userId);
  createSession(res, userId);
  res.json({ ok: true, user: { id: userId, username }, address });
});

// ---------- Login ----------
authRouter.post('/login/options', async (req, res) => {
  // Ohne Nutzername: discoverable credential – das Gerät zeigt vorhandene
  // Passkeys an. Mit Nutzername werden dessen Credentials vorgeschlagen.
  const username = String(req.body?.username || '').trim().toLowerCase();
  let allowCredentials;
  if (username) {
    const user = getUserByName.get(username);
    if (!user) return res.status(404).json({ error: 'Unbekannter Nutzername.' });
    allowCredentials = getCredentialsByUser.all(user.id).map((c) => ({
      id: c.id,
      transports: JSON.parse(c.transports || '[]'),
    }));
  }
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials,
  });
  const challengeId = storeChallenge('login', null, options.challenge);
  res.json({ challengeId, options });
});

authRouter.post('/login/verify', async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = takeChallenge(challengeId, 'login');
  if (!row) return res.status(400).json({ error: 'Challenge abgelaufen – bitte erneut versuchen.' });

  const cred = getCredentialById.get(response?.id);
  if (!cred) return res.status(404).json({ error: 'Passkey ist hier nicht registriert.' });

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
  if (!verification.verified) {
    return res.status(401).json({ error: 'Anmeldung fehlgeschlagen.' });
  }
  updateCredentialCounter.run(verification.authenticationInfo.newCounter, cred.id);

  const user = getUserById.get(cred.user_id);
  createSession(res, user.id);
  res.json({ ok: true, user: { id: user.id, username: user.username }, address: getAddress(user.id) });
});

// ---------- Sitzung ----------
authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: { id: req.user.id, username: req.user.username },
    address: getAddress(req.user.id),
  });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});
