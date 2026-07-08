// Passkey-Registrierung & -Login (WebAuthn über @simplewebauthn/server).
// Ablauf jeweils zweistufig: /options liefert die Challenge,
// /verify prüft die Antwort des Authenticators (Face ID, Fingerabdruck …).
// Optional folgt nach dem Passkey-Login ein TOTP-Schritt (2FA).
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
  db, insertUser, getUserByName, getUserById, countUsers,
  insertCredential, getCredentialById, getCredentialsByUser, updateCredentialCounter,
  countCredentialsByUser, deleteCredential, renameCredential,
  insertChallenge, getChallenge, deleteChallenge, now,
} from '../db.js';
import { createWalletForUser, getAddress } from '../wallet.js';
import { createSession, destroySession, requireAuth } from '../session.js';
import { verifyTotp } from '../totp.js';
import { decrypt } from '../crypto.js';

export const authRouter = Router();

const CHALLENGE_TTL = 300; // 5 Minuten für Registrierung/Login

function storeChallenge(kind, userId, challenge, payload = null, ttl = CHALLENGE_TTL) {
  const id = randomUUID();
  insertChallenge.run(id, kind, userId, challenge, payload ? JSON.stringify(payload) : null, now() + ttl);
  return id;
}

function takeChallenge(id, kind) {
  const row = getChallenge.get(String(id || ''));
  if (!row || row.kind !== kind) return null;
  deleteChallenge.run(row.id); // Einmal-Verwendung
  if (row.expires_at < now()) return null;
  return row;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    network: user.network || 'testnet',
    totpEnabled: !!user.totp_enabled,
  };
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

  // Der allererste Nutzer der Instanz wird Admin, ebenso Namen aus ORANGE_ADMIN_USERS.
  const isAdmin = countUsers.get().n === 0 || config.adminUsers.includes(username) ? 1 : 0;

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const userId = row.user_id;
  insertUser.run(userId, username, username, now(), isAdmin);
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

  // Gas kommt bedarfsweise aus dem Projekt eines Barkeepers (siehe /api/projects),
  // sobald der Nutzer ein eingebundenes Spiel/Projekt nutzt.

  const user = getUserById.get(userId);
  res.json({ ok: true, user: publicUser(user), address });
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

  // 2FA aktiv? Dann noch keine Session – erst den TOTP-Code verlangen.
  if (user.totp_enabled) {
    const ticket = storeChallenge('2fa', user.id, 'totp', null, 120);
    return res.json({ twoFactorRequired: true, ticket });
  }

  createSession(res, user.id);
  res.json({ ok: true, user: publicUser(user), address: getAddress(user.id) });
});

// Zweiter Login-Schritt bei aktivierter 2FA: TOTP-Code prüfen.
// Ein falscher Code verbraucht das Ticket NICHT (max. 5 Versuche),
// damit Tippfehler nicht den kompletten Login neu starten.
authRouter.post('/login/2fa', (req, res) => {
  const { ticket, code } = req.body || {};
  const row = getChallenge.get(String(ticket || ''));
  if (!row || row.kind !== '2fa' || row.expires_at < now()) {
    if (row) deleteChallenge.run(row.id);
    return res.status(400).json({ error: '2FA-Ticket abgelaufen – bitte neu anmelden.' });
  }

  const user = getUserById.get(row.user_id);
  if (!user?.totp_enabled || !user.totp_secret) {
    deleteChallenge.run(row.id);
    return res.status(400).json({ error: '2FA ist für dieses Konto nicht aktiv.' });
  }
  const secret = decrypt(user.totp_secret).toString('utf8');
  if (!verifyTotp(secret, code)) {
    const attempts = (JSON.parse(row.payload || '{}').attempts || 0) + 1;
    if (attempts >= 5) {
      deleteChallenge.run(row.id);
      return res.status(401).json({ error: 'Zu viele Fehlversuche – bitte neu anmelden.' });
    }
    db.prepare('UPDATE challenges SET payload = ? WHERE id = ?')
      .run(JSON.stringify({ attempts }), row.id);
    return res.status(401).json({ error: 'Falscher Code – bitte erneut versuchen.' });
  }
  deleteChallenge.run(row.id);
  createSession(res, user.id);
  res.json({ ok: true, user: publicUser(user), address: getAddress(user.id) });
});

// ---------- Sitzung ----------
authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: publicUser(req.user),
    address: getAddress(req.user.id),
    networks: config.iotaNetworks,
  });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---------- Passkeys / Geräte verwalten ----------
// Erlaubt, weitere Passkeys (z. B. iPad, Ersatzgerät) zum Konto hinzuzufügen,
// damit man beim Geräteverlust nicht ausgesperrt ist.

function credentialLabel(row) {
  if (row.label) return row.label;
  return row.backed_up ? 'Synchronisierter Passkey' : 'Dieses Gerät';
}

// Liste der registrierten Passkeys des angemeldeten Nutzers.
authRouter.get('/credentials', requireAuth, (req, res) => {
  const creds = getCredentialsByUser.all(req.user.id).map((c) => ({
    id: c.id,
    label: credentialLabel(c),
    deviceType: c.device_type,
    backedUp: !!c.backed_up,
    createdAt: c.created_at,
  }));
  res.json({ credentials: creds });
});

// Schritt 1: Optionen für einen zusätzlichen Passkey (angemeldet).
authRouter.post('/credentials/add/options', requireAuth, async (req, res) => {
  // Bereits registrierte Credentials ausschließen, damit dasselbe Gerät
  // nicht doppelt hinterlegt wird.
  const existing = getCredentialsByUser.all(req.user.id).map((c) => ({
    id: c.id,
    transports: JSON.parse(c.transports || '[]'),
  }));
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: req.user.username,
    userDisplayName: req.user.username,
    attestationType: 'none',
    excludeCredentials: existing,
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  const label = String(req.body?.label || '').trim().slice(0, 40) || null;
  const challengeId = storeChallenge('add-cred', req.user.id, options.challenge, { label });
  res.json({ challengeId, options });
});

// Schritt 2: neuen Passkey verifizieren und dem Konto hinzufügen.
authRouter.post('/credentials/add/verify', requireAuth, async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = getChallenge.get(String(challengeId || ''));
  if (!row || row.kind !== 'add-cred' || row.user_id !== req.user.id) {
    return res.status(400).json({ error: 'Unbekannte Challenge.' });
  }
  deleteChallenge.run(row.id);
  if (row.expires_at < now()) {
    return res.status(400).json({ error: 'Challenge abgelaufen – bitte erneut versuchen.' });
  }

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
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  if (getCredentialById.get(credential.id)) {
    return res.status(409).json({ error: 'Dieser Passkey ist bereits hinterlegt.' });
  }
  const { label } = JSON.parse(row.payload || '{}');
  insertCredential.run(
    credential.id, req.user.id, Buffer.from(credential.publicKey), credential.counter,
    JSON.stringify(credential.transports || []), credentialDeviceType,
    credentialBackedUp ? 1 : 0, now()
  );
  if (label) renameCredential.run(label, credential.id, req.user.id);
  res.json({ ok: true });
});

// Passkey umbenennen.
authRouter.post('/credentials/:id/rename', requireAuth, (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 40);
  if (!label) return res.status(400).json({ error: 'Name darf nicht leer sein.' });
  const cred = getCredentialById.get(req.params.id);
  if (!cred || cred.user_id !== req.user.id) return res.status(404).json({ error: 'Passkey nicht gefunden.' });
  renameCredential.run(label, req.params.id, req.user.id);
  res.json({ ok: true });
});

// Passkey entfernen – der letzte verbleibende darf nicht gelöscht werden,
// sonst wäre das Konto unzugänglich.
authRouter.delete('/credentials/:id', requireAuth, (req, res) => {
  const cred = getCredentialById.get(req.params.id);
  if (!cred || cred.user_id !== req.user.id) return res.status(404).json({ error: 'Passkey nicht gefunden.' });
  if (countCredentialsByUser.get(req.user.id).n <= 1) {
    return res.status(400).json({ error: 'Der letzte Passkey kann nicht entfernt werden – füge zuerst ein weiteres Gerät hinzu.' });
  }
  deleteCredential.run(req.params.id, req.user.id);
  res.json({ ok: true });
});
