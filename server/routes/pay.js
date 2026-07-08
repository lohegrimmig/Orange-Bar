// In-Game-Zahlungsanfragen: Ein Spiel erstellt über das SDK eine Anfrage,
// Orange-Bar zeigt sie dem Nutzer, der sie per Passkey bestätigt.
// Das Spiel pollt den Status (oder bekommt ihn per postMessage vom Popup).
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { insertPayRequest, getPayRequest, updatePayRequestStatus, getProject, now } from '../db.js';
import { isValidAddress } from '../wallet.js';
import { originAllowed } from '../projects.js';

export const payRouter = Router();

const PAY_TTL = 600; // 10 Minuten

// Vom Spiel (cross-origin) aufrufbar: Zahlungsanfrage anlegen.
// Optional an ein Barkeeper-Projekt gebunden (projectId) – dann greift dessen
// Origin-Allowlist als Schutz gegen fremde Einbindungen.
payRouter.post('/request', (req, res) => {
  const { to, amountNanos, memo, projectId } = req.body || {};
  if (!isValidAddress(to)) return res.status(400).json({ error: 'Ungültige Zieladresse.' });
  let amount;
  try { amount = BigInt(amountNanos); } catch { amount = 0n; }
  if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });

  let projId = null;
  if (projectId) {
    const project = getProject.get(String(projectId));
    if (!project) return res.status(404).json({ error: 'Unbekanntes Projekt.' });
    if (!originAllowed(project, req.get('origin'))) {
      return res.status(403).json({ error: 'Diese Herkunft ist für das Projekt nicht freigegeben.' });
    }
    projId = project.id;
  }

  const id = randomUUID();
  const origin = req.get('origin') || 'unbekannt';
  insertPayRequest.run(id, origin, to, amount.toString(), String(memo || '').slice(0, 200), now(), now() + PAY_TTL, projId);
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
    projectId: pr.project_id || null,
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
