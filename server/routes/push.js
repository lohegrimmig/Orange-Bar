// Push-Abonnements verwalten (angemeldet). Der öffentliche VAPID-Key ist
// bewusst offen abrufbar – er wird im Browser zum Abonnieren gebraucht.
import { Router } from 'express';
import { requireAuth } from '../session.js';
import { insertPushSub, deletePushSub, now } from '../db.js';
import { vapidPublicKey } from '../push.js';

export const pushRouter = Router();

// Öffentlicher VAPID-Key fürs Frontend.
pushRouter.get('/vapid', (_req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

pushRouter.use(requireAuth);

// Gerät für Push registrieren.
pushRouter.post('/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Ungültiges Push-Abo.' });
  }
  insertPushSub.run(sub.endpoint, req.user.id, sub.keys.p256dh, sub.keys.auth, now());
  res.json({ ok: true });
});

// Abmelden.
pushRouter.post('/unsubscribe', (req, res) => {
  if (req.body?.endpoint) deletePushSub.run(String(req.body.endpoint));
  res.json({ ok: true });
});
