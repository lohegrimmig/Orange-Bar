// Barkeeper-Projekte: Multi-Tenant-Modell. Jeder eingebundene Betreiber
// erstellt ein Projekt und wird dessen "Barkeeper". Ein Projekt hat eine
// eigene Gas Station (Wallet), die der Barkeeper von außen auflädt, sowie
// ein Pro-Nutzer-Limit, wie oft ein Endnutzer daraus Gas ziehen darf.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import { createStationWallet, sendFromSecret, getAddress } from './wallet.js';
import {
  db, insertProject, getProject, getProjectsByBarkeeper, updateProjectPolicy, deleteProject,
  countProjectGrantsForUser, insertProjectGrant, updateProjectGrant, now,
} from './db.js';

const hashSecret = (s) => createHash('sha256').update(s).digest('hex');

/** Normalisiert eine Origin auf "scheme://host[:port]" (ohne Pfad). */
export function normalizeOrigin(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin;
  } catch { return null; }
}

/** Erstellt ein Projekt inkl. eigener Gas Station. Secret wird nur hier
 *  im Klartext zurückgegeben (danach nur noch der Hash gespeichert). */
export function createProject(barkeeperId, { name, network, allowedOrigins }) {
  const net = config.iotaNetworks.includes(network) ? network : config.iotaNetwork;
  const station = createStationWallet();
  const secret = 'obk_' + randomBytes(24).toString('base64url');
  const id = 'proj_' + randomBytes(9).toString('base64url');
  const origins = (Array.isArray(allowedOrigins) ? allowedOrigins : [])
    .map(normalizeOrigin).filter(Boolean).slice(0, 20);

  insertProject.run({
    id,
    barkeeper_id: barkeeperId,
    name: String(name || 'Projekt').slice(0, 60),
    secret_hash: hashSecret(secret),
    station_address: station.address,
    station_key_ciphertext: encrypt(station.secret),
    network: net,
    gas_per_grant: '50000000',
    max_grants_per_user: 1,
    allowed_origins: JSON.stringify(origins),
    created_at: now(),
  });
  return { id, secret, project: getProject.get(id) };
}

export function publicProject(p) {
  return {
    id: p.id,
    name: p.name,
    network: p.network,
    stationAddress: p.station_address,
    gasPerGrant: p.gas_per_grant,
    maxGrantsPerUser: p.max_grants_per_user,
    allowedOrigins: JSON.parse(p.allowed_origins || '[]'),
    enabled: !!p.enabled,
    createdAt: p.created_at,
  };
}

export function listProjects(barkeeperId) {
  return getProjectsByBarkeeper.all(barkeeperId).map(publicProject);
}

export function updatePolicy(barkeeperId, id, patch) {
  const p = getProject.get(id);
  if (!p || p.barkeeper_id !== barkeeperId) return null;
  let gas;
  try { gas = BigInt(patch.gasPerGrant); } catch { gas = 0n; }
  if (gas <= 0n) throw new Error('Gas-Betrag muss größer als 0 sein.');
  const maxPer = Math.max(0, Math.min(1000, parseInt(patch.maxGrantsPerUser, 10) || 0));
  const net = config.iotaNetworks.includes(patch.network) ? patch.network : p.network;
  const origins = (Array.isArray(patch.allowedOrigins) ? patch.allowedOrigins : [])
    .map(normalizeOrigin).filter(Boolean).slice(0, 20);
  updateProjectPolicy.run({
    id, barkeeper_id: barkeeperId,
    gas_per_grant: gas.toString(),
    max_grants_per_user: maxPer,
    allowed_origins: JSON.stringify(origins),
    enabled: patch.enabled ? 1 : 0,
    network: net,
  });
  return publicProject(getProject.get(id));
}

export function removeProject(barkeeperId, id) {
  return deleteProject.run(id, barkeeperId).changes > 0;
}

/** Prüft, ob eine Origin für ein Projekt erlaubt ist ([] = alle erlaubt). */
export function originAllowed(project, origin) {
  const list = JSON.parse(project.allowed_origins || '[]');
  if (list.length === 0) return true;
  const norm = normalizeOrigin(origin || '');
  return !!norm && list.includes(norm);
}

/**
 * Ein Endnutzer zieht Gas aus der Projekt-Station. Race-sicher: die Zählung
 * inkl. eines sofort eingefügten "pending"-Eintrags läuft in einer Transaktion,
 * BEVOR die (langsame) On-Chain-Überweisung startet. So kann das Pro-Nutzer-
 * Limit nicht durch parallele Anfragen überschritten werden.
 * @returns {Promise<{ok:true,digest}|{ok:false,error,code}>}
 */
export async function claimGas(project, userId) {
  if (!project.enabled) return { ok: false, code: 'disabled', error: 'Projekt ist deaktiviert.' };

  const reserve = db.transaction(() => {
    const used = countProjectGrantsForUser.get(project.id, userId).n;
    if (used >= project.max_grants_per_user) return null;
    const grantId = randomUUID();
    insertProjectGrant.run(grantId, project.id, userId, project.network,
      project.gas_per_grant, null, 'pending', null, now());
    return grantId;
  });

  const grantId = reserve();
  if (!grantId) return { ok: false, code: 'limit', error: 'Dein Gas-Limit für dieses Projekt ist erreicht.' };

  const to = getAddress(userId);
  if (!to) {
    updateProjectGrant.run('failed', null, 'Nutzer hat kein Wallet.', grantId);
    return { ok: false, code: 'nowallet', error: 'Nutzer hat kein Wallet.' };
  }
  try {
    const secret = decrypt(project.station_key_ciphertext);
    const result = await sendFromSecret(project.network, secret, to, project.gas_per_grant);
    updateProjectGrant.run('success', result.digest, null, grantId);
    return { ok: true, digest: result.digest };
  } catch (err) {
    // Fehlgeschlagen → zählt nicht mehr gegen das Limit (Retry möglich,
    // Rate-Limit auf dem Endpoint bremst Missbrauch).
    updateProjectGrant.run('failed', null, err.message, grantId);
    return { ok: false, code: 'chain', error: `Gas-Auszahlung fehlgeschlagen: ${err.message}` };
  }
}

export function verifyProjectSecret(project, secret) {
  return !!secret && hashSecret(secret) === project.secret_hash;
}
