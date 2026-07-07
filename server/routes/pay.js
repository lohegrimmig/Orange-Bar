// In-Game-Zahlungsanfragen: Ein Spiel erstellt über das SDK eine Anfrage,
// Orange-Bar zeigt sie dem Nutzer, der sie per Passkey bestätigt.
// Das Spiel pollt den Status (oder bekommt ihn per postMessage vom Popup).
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { insertPayRequest, getPayRequest, updatePayRequestStatus, now } from '../db.js';
import { isValidAddress } from '../wallet.js';

export const payRouter = Router();

const PAY_TTL = 600; // 10 Minuten

// Vom Spiel (cross-origin) aufrufbar: Zahlungsanfrage anlegen.
payRouter.post('/request', (req, res) => {
  const { to, amountNanos, memo } = req.body || {};
  if (!isValidAddress(to)) return res.status(400).json({ error: 'Ungültige Zieladresse.' });
  let amount;
  try { amount = BigInt(amountNanos); } catch { amount = 0n; }
  if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });

  const id = randomUUID();
  const origin = req.get('origin') || 'unbekannt';
  insertPayRequest.run(id, origin, to, amount.toString(), String(memo || '').slice(0, 200), now(), now() + PAY_TTL);
  res.json({ id, expiresIn: PAY_TTL });
});

// Status einer Anfrage (fürs Spiel-Polling und die Bestätigungsseite).
payRouter.get('/request/:id', (req, res) => {
  const pr = getPayRequest.get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
  const expired = pr.status === 'pending' && pr.expires_at < now();
  res.json({
    id: pr.id,
    origin: pr.origin,
    to: pr.to_address,
    amountNanos: pr.amount,
    memo: pr.memo,
    status: expired ? 'expired' : pr.status,
    txDigest: pr.tx_digest,
  });
});

// Nutzer lehnt eine Anfrage ab.
payRouter.post('/request/:id/reject', (req, res) => {
  const pr = getPayRequest.get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
  if (pr.status === 'pending') updatePayRequestStatus.run('rejected', null, pr.id);
  res.json({ ok: true });
});
