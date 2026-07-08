// Admin-API: Nutzerübersicht und Gas Station. Der Admin lädt das
// Station-Wallet von außen auf; die Station versorgt neue Nutzer
// automatisch mit Startgas und erlaubt manuelles Funding.
import { Router } from 'express';
import { config } from '../config.js';
import {
  listUsers, getUserById, updateStationConfig, listGasGrants,
} from '../db.js';
import { ensureStation, grantGas, getBalance } from '../wallet.js';
import { requireAuth } from '../session.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);
adminRouter.use((req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Nur für Admins.' });
  next();
});

// Überblick: Station-Adresse, Guthaben auf allen Netzwerken, Konfiguration.
adminRouter.get('/station', async (_req, res) => {
  const station = ensureStation();
  const balances = {};
  await Promise.all(config.iotaNetworks.map(async (net) => {
    try {
      balances[net] = (await getBalance(net, station.address)).totalBalance;
    } catch {
      balances[net] = null; // Netzwerk nicht erreichbar
    }
  }));
  res.json({
    address: station.address,
    enabled: !!station.enabled,
    amountNanos: station.amount_nanos,
    balances,
    defaultNetwork: config.iotaNetwork,
  });
});

// Konfiguration: Auto-Funding an/aus und Betrag pro neuem Nutzer.
adminRouter.post('/station/config', (req, res) => {
  ensureStation();
  const enabled = req.body?.enabled ? 1 : 0;
  let amount;
  try { amount = BigInt(req.body?.amountNanos); } catch { amount = 0n; }
  if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });
  updateStationConfig.run(enabled, amount.toString(), );
  res.json({ ok: true, enabled: !!enabled, amountNanos: amount.toString() });
});

// Nutzerliste mit Adressen (für manuelles Funding).
adminRouter.get('/users', (_req, res) => {
  res.json({ users: listUsers.all() });
});

// Manuelles Funding eines Nutzers aus der Station.
adminRouter.post('/grant', async (req, res) => {
  const { userId, amountNanos, network } = req.body || {};
  const target = getUserById.get(String(userId || ''));
  if (!target) return res.status(404).json({ error: 'Nutzer nicht gefunden.' });
  const net = config.iotaNetworks.includes(network) ? network : config.iotaNetwork;
  let amount;
  try { amount = BigInt(amountNanos); } catch { amount = 0n; }
  if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });

  const result = await grantGas(net, target.id, amount.toString(), 'manual');
  if (!result.ok) return res.status(502).json({ error: `Funding fehlgeschlagen: ${result.error}` });
  res.json({ ok: true, digest: result.digest });
});

// Protokoll der letzten Gas-Zuweisungen.
adminRouter.get('/grants', (_req, res) => {
  res.json({ grants: listGasGrants.all() });
});
