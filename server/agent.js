// KI-Agent-Tokens: scoped Bearer (oba_…), nur Hash in DB.
// Propose-only – kein Signing, keine User-Keys. Siehe docs/AGENT_ARCHITECTURE.md.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import {
  insertAgentToken, getAgentTokenByHash, getAgentTokenById,
  listAgentTokensByUser, revokeAgentToken, touchAgentToken,
  getAgentUsage, addAgentUsage,
  getUserById, getProject, getAgentStation, now,
} from './db.js';
import { config } from './config.js';

export const AGENT_SCOPES = Object.freeze(['read', 'pay_request', 'station_spend']);
const DEFAULT_TTL = 30 * 24 * 3600; // 30 Tage
const MAX_TTL = 365 * 24 * 3600;

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

function parseJsonArray(raw, fallback = []) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function parsePositiveNanos(value, fieldName) {
  if (value == null || value === '') return null;
  try {
    const n = BigInt(value);
    if (n <= 0n) throw new Error(`${fieldName} muss größer als 0 sein.`);
    return n.toString();
  } catch (err) {
    if (err.message?.includes(fieldName)) throw err;
    throw new Error(`Ungültiges ${fieldName}.`);
  }
}

/** Normalisiert und validiert Token-Optionen (für prepare + create). */
export function normalizeTokenOpts(opts = {}, userId = null) {
  const label = String(opts.label || 'Agent').trim().slice(0, 80) || 'Agent';
  let scopes = Array.isArray(opts.scopes) ? opts.scopes.map(String) : [...AGENT_SCOPES];
  scopes = [...new Set(scopes.filter((s) => AGENT_SCOPES.includes(s)))];
  if (!scopes.length) scopes = ['read'];

  let ttl = Number(opts.ttlSeconds ?? DEFAULT_TTL);
  if (!Number.isFinite(ttl) || ttl < 60) ttl = 60;
  if (ttl > MAX_TTL) ttl = MAX_TTL;

  const maxAmount = parsePositiveNanos(opts.maxAmountNanos, 'maxAmountNanos');
  const dailyLimit = parsePositiveNanos(opts.dailyLimitNanos, 'dailyLimitNanos');

  const allowedTo = Array.isArray(opts.allowedTo)
    ? [...new Set(opts.allowedTo.map((a) => String(a).trim().toLowerCase()).filter(Boolean))]
    : [];

  let projectId = null;
  if (opts.projectId != null && String(opts.projectId).trim()) {
    projectId = String(opts.projectId).trim();
    const project = getProject.get(projectId);
    if (!project) throw new Error('Unbekanntes Projekt.');
  }

  let networkLock = null;
  if (opts.networkLock != null && String(opts.networkLock).trim()) {
    networkLock = String(opts.networkLock).trim();
    if (!config.iotaNetworks.includes(networkLock)) {
      throw new Error(`networkLock muss eines von ${config.iotaNetworks.join(', ')} sein.`);
    }
  }

  let stationId = null;
  if (opts.stationId != null && String(opts.stationId).trim()) {
    stationId = String(opts.stationId).trim();
    const st = getAgentStation.get(stationId);
    if (!st) throw new Error('Unbekannte Agent-Station.');
    if (userId && st.user_id !== userId) throw new Error('Agent-Station gehört nicht zu diesem Konto.');
    if (scopes.includes('station_spend') === false) {
      // Station-Bindung ohne Scope ist ok (nur Doku), aber station_spend braucht Station oft
    }
  }
  if (scopes.includes('station_spend') && !stationId) {
    // Erlaubt: Agent darf jede Station des Users nutzen, wenn nicht gebunden
  }

  return {
    label,
    scopes,
    ttlSeconds: ttl,
    maxAmountNanos: maxAmount,
    dailyLimitNanos: dailyLimit,
    allowedTo,
    projectId,
    networkLock,
    stationId,
  };
}

function publicTokenRow(row) {
  if (!row) return null;
  const day = utcDay();
  const usage = getAgentUsage.get(row.id, day);
  return {
    id: row.id,
    label: row.label,
    scopes: parseJsonArray(row.scopes),
    maxAmountNanos: row.max_amount_nanos ?? null,
    dailyLimitNanos: row.daily_limit_nanos ?? null,
    allowedTo: parseJsonArray(row.allowed_to),
    projectId: row.project_id ?? null,
    networkLock: row.network_lock ?? null,
    stationId: row.station_id ?? null,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
    todayUsedNanos: usage?.amount_nanos || '0',
    todayRequestCount: usage?.request_count || 0,
    active: !row.revoked_at && row.expires_at > now(),
  };
}

/** Token anlegen. Klartext nur im Rückgabewert – nie erneut lesbar. */
export function createAgentToken(userId, opts = {}) {
  const n = normalizeTokenOpts(opts, userId);
  const id = `agt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const raw = `oba_${randomBytes(32).toString('base64url')}`;
  const created = now();
  const expiresAt = created + n.ttlSeconds;

  insertAgentToken.run(
    id,
    userId,
    hashToken(raw),
    n.label,
    JSON.stringify(n.scopes),
    n.maxAmountNanos,
    JSON.stringify(n.allowedTo),
    expiresAt,
    created,
    n.dailyLimitNanos,
    n.projectId,
    n.networkLock,
    n.stationId,
  );

  return {
    token: raw,
    ...publicTokenRow(getAgentTokenById.get(id)),
  };
}

export function listAgentTokens(userId) {
  return listAgentTokensByUser.all(userId).map(publicTokenRow);
}

export function revokeAgentTokenForUser(userId, tokenId) {
  const row = getAgentTokenById.get(tokenId);
  if (!row || row.user_id !== userId) return null;
  if (row.revoked_at) return publicTokenRow(row);
  revokeAgentToken.run(now(), tokenId, userId);
  return publicTokenRow(getAgentTokenById.get(tokenId));
}

/**
 * Bearer verifizieren. Gibt { user, token, scopes, row } oder null.
 * Aktualisiert last_used_at (max. alle 30s, um Write-Last zu dämpfen).
 */
export function verifyAgentBearer(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') return null;
  const m = authorizationHeader.match(/^Bearer\s+(\S+)/i);
  if (!m) return null;
  const raw = m[1];
  if (!raw.startsWith('oba_')) return null;

  const row = getAgentTokenByHash.get(hashToken(raw));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at <= now()) return null;

  const user = getUserById.get(row.user_id);
  if (!user) return null;

  const touchFloor = (row.last_used_at || 0) + 30;
  if (now() >= touchFloor) touchAgentToken.run(now(), row.id);

  return {
    user,
    token: publicTokenRow(row),
    scopes: parseJsonArray(row.scopes),
    row,
  };
}

export function agentHasScope(auth, scope) {
  return !!auth?.scopes?.includes(scope);
}

export function recordAgentPayUsage(tokenId, amountNanos) {
  addAgentUsage(tokenId, utcDay(), String(amountNanos));
}

/**
 * Policy für Pay-Requests: Betrag, Empfänger, Tageslimit, Netzwerk, Projekt.
 * @returns {{ ok: true, projectId: string|null } | { ok: false, error: string }}
 */
export function checkPayPolicy(auth, { to, amountNanos, projectId, userNetwork }) {
  const row = auth.row;
  const allowed = parseJsonArray(row.allowed_to);
  if (allowed.length) {
    const target = String(to || '').trim().toLowerCase();
    if (!allowed.includes(target)) {
      return { ok: false, error: 'Zieladresse ist für diesen Agent-Token nicht freigegeben.' };
    }
  }

  let amount;
  try { amount = BigInt(amountNanos); } catch { amount = 0n; }

  if (row.max_amount_nanos != null && amount > BigInt(row.max_amount_nanos)) {
    return {
      ok: false,
      error: `Betrag überschreitet Agent-Limit (${row.max_amount_nanos} Nanos).`,
    };
  }

  if (row.daily_limit_nanos != null) {
    const usage = getAgentUsage.get(row.id, utcDay());
    const used = BigInt(usage?.amount_nanos || '0');
    if (used + amount > BigInt(row.daily_limit_nanos)) {
      return {
        ok: false,
        error: `Tageslimit überschritten (${row.daily_limit_nanos} Nanos/Tag).`,
      };
    }
  }

  if (row.network_lock) {
    const net = userNetwork || auth.user?.network || config.iotaNetwork;
    if (net !== row.network_lock) {
      return {
        ok: false,
        error: `Agent-Token ist auf Netzwerk „${row.network_lock}“ beschränkt (aktuell: ${net}).`,
      };
    }
  }

  let resolvedProject = projectId ? String(projectId) : null;
  if (row.project_id) {
    if (resolvedProject && resolvedProject !== row.project_id) {
      return { ok: false, error: 'Agent-Token ist an ein anderes Projekt gebunden.' };
    }
    resolvedProject = row.project_id;
  }

  return { ok: true, projectId: resolvedProject };
}
