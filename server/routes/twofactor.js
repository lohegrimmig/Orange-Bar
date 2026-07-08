// Optionale Zwei-Faktor-Authentifizierung (TOTP): Einrichtung per QR-Code,
// Aktivierung erst nach erfolgreich geprüftem Code, Deaktivierung nur mit Code.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../session.js';
import { generateTotpSecret, verifyTotp, otpauthUrl } from '../totp.js';
import { encrypt, decrypt } from '../crypto.js';
import { insertChallenge, getChallenge, deleteChallenge, setUserTotp, now } from '../db.js';

export const twoFactorRouter = Router();
twoFactorRouter.use(requireAuth);

const SETUP_TTL = 600; // 10 Minuten Zeit zum Scannen

// Schritt 1: Secret erzeugen (noch nicht aktiv), QR-URL zurückgeben.
twoFactorRouter.post('/setup', (req, res) => {
  if (req.user.totp_enabled) return res.status(409).json({ error: '2FA ist bereits aktiv.' });
  const secret = generateTotpSecret();
  const setupId = randomUUID();
  insertChallenge.run(setupId, 'totp-setup', req.user.id, 'totp', JSON.stringify({ secret }), now() + SETUP_TTL);
  res.json({
    setupId,
    secret, // zur manuellen Eingabe
    otpauth: otpauthUrl(secret, req.user.username),
  });
});

// Schritt 2: ersten Code prüfen → 2FA aktivieren.
twoFactorRouter.post('/enable', (req, res) => {
  const { setupId, code } = req.body || {};
  const row = getChallenge.get(String(setupId || ''));
  if (!row || row.kind !== 'totp-setup' || row.user_id !== req.user.id || row.expires_at < now()) {
    return res.status(400).json({ error: 'Einrichtung abgelaufen – bitte neu starten.' });
  }
  const { secret } = JSON.parse(row.payload);
  if (!verifyTotp(secret, code)) {
    return res.status(401).json({ error: 'Falscher Code – bitte erneut versuchen.' });
  }
  deleteChallenge.run(row.id);
  setUserTotp.run(encrypt(Buffer.from(secret, 'utf8')), 1, req.user.id);
  res.json({ ok: true });
});

// Deaktivieren – nur mit gültigem aktuellem Code.
twoFactorRouter.post('/disable', (req, res) => {
  if (!req.user.totp_enabled || !req.user.totp_secret) {
    return res.status(400).json({ error: '2FA ist nicht aktiv.' });
  }
  const secret = decrypt(req.user.totp_secret).toString('utf8');
  if (!verifyTotp(secret, req.body?.code)) {
    return res.status(401).json({ error: 'Falscher Code – 2FA bleibt aktiv.' });
  }
  setUserTotp.run(null, 0, req.user.id);
  res.json({ ok: true });
});
