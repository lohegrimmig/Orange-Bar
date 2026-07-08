// Barkeeper-API: Projekte verwalten (eigene Gas Station, Pro-Nutzer-Limit)
// und Endnutzer-Gas-Bezug. Alles session-gebunden.
import { Router } from 'express';
import { requireAuth } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import {
  getProject, getPayRequest, listProjectGrants,
} from '../db.js';
import {
  createProject, listProjects, updatePolicy, removeProject,
  publicProject, claimGas,
} from '../projects.js';
import { getBalance } from '../wallet.js';

export const projectsRouter = Router();

// ---- Öffentlich: Basis-Infos eines Projekts (fürs SDK/„powered by") ----
projectsRouter.get('/:id/public', (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  res.json({ id: p.id, name: p.name, network: p.network, enabled: !!p.enabled });
});

// ---- Endnutzer zieht Gas – gebunden an eine gültige Zahlungsanfrage ----
// Die Herkunft (Origin) wurde bereits beim Anlegen der Zahlungsanfrage gegen
// die Projekt-Allowlist geprüft; hier genügt daher die Session des Nutzers.
// Rate-Limit + Pro-Nutzer-Limit (race-sicher) verhindern Missbrauch.
projectsRouter.post('/claim-gas',
  rateLimit({ windowMs: 60_000, max: 20, key: (req) => `claim:${req.ip}` }),
  requireAuth,
  async (req, res) => {
    const pr = getPayRequest.get(String(req.body?.payRequestId || ''));
    if (!pr || !pr.project_id) return res.status(400).json({ error: 'Keine gültige Projekt-Zahlungsanfrage.' });
    if (pr.status !== 'pending' || pr.expires_at < Math.floor(Date.now() / 1000)) {
      return res.status(400).json({ error: 'Zahlungsanfrage abgelaufen.' });
    }
    const p = getProject.get(pr.project_id);
    if (!p) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    const result = await claimGas(p, req.user.id);
    if (!result.ok) {
      const status = result.code === 'limit' ? 429 : result.code === 'disabled' ? 403 : 502;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    res.json({ ok: true, digest: result.digest });
  });

// ---- Ab hier: nur der Barkeeper (angemeldeter Eigentümer) ----
projectsRouter.use(requireAuth);

// Projekte des Barkeepers. Antwortet sofort (nur DB-Lesen) – das Guthaben je
// Station wird separat und asynchron über /:id/balance nachgeladen, damit ein
// langsames oder nicht erreichbares RPC-Netzwerk nicht die ganze Liste blockiert.
projectsRouter.get('/', (req, res) => {
  res.json({ projects: listProjects(req.user.id) });
});

// Guthaben einer einzelnen Projekt-Station (on demand, kann langsam sein).
projectsRouter.get('/:id/balance', async (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p || p.barkeeper_id !== req.user.id) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  try {
    const balance = (await getBalance(p.network, p.station_address)).totalBalance;
    res.json({ balance });
  } catch (err) {
    res.json({ balance: null, error: `Netzwerk nicht erreichbar: ${err.message}` });
  }
});

// Projekt anlegen → Barkeeper werden. Secret wird nur EINMAL zurückgegeben.
projectsRouter.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Projektnamen (min. 2 Zeichen) angeben.' });
  const { id, secret, project } = createProject(req.user.id, {
    name,
    network: req.body?.network,
    allowedOrigins: req.body?.allowedOrigins,
  });
  res.json({ ok: true, secret, project: publicProject(project) });
});

// Richtlinien ändern (Gas pro Bezug, Limit pro Nutzer, Origins, Netzwerk, an/aus).
projectsRouter.patch('/:id', (req, res) => {
  try {
    const updated = updatePolicy(req.user.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    res.json({ ok: true, project: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Projekt löschen.
projectsRouter.delete('/:id', (req, res) => {
  if (!removeProject(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  }
  res.json({ ok: true });
});

// Auszahlungs-Protokoll eines Projekts.
projectsRouter.get('/:id/grants', (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p || p.barkeeper_id !== req.user.id) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  res.json({ grants: listProjectGrants.all(p.id) });
});
