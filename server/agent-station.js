// Agent-Station (Phase 3): separates Hot-Wallet-Float für KI-Agenten.
// Analog Barkeeper-Gas: Schlüssel serverseitig, Adresse ≠ User-Wallet.
// Aufladen nur durch vom Nutzer signierte Transfers an die Stations-Adresse.
// Siehe docs/AGENT_ARCHITECTURE.md.
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';
import { createStationWallet, sendFromSecret, getBalance, isValidAddress } from './wallet.js';
import { config } from './config.js';
import {
  db,
  insertAgentStation, getAgentStation, listAgentStationsByUser,
  countAgentStationsByUser, updateAgentStationPolicy, deleteAgentStation,
  insertAgentStationPayment, updateAgentStationPayment, getAgentStationPaymentByIdemKey,
  listAgentStationPayments,
  getAgentStationUsage, addAgentStationUsage, subAgentStationUsage,
  getAgentUsage, addAgentUsage, subAgentUsage, now,
} from './db.js';

export const MAX_STATIONS_PER_USER = 5;

function parseJsonArray(raw, fallback = []) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
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

export function normalizeStationOpts(opts = {}) {
  const label = String(opts.label || 'Agent-Station').trim().slice(0, 80) || 'Agent-Station';
  const network = config.iotaNetworks.includes(opts.network)
    ? opts.network
    : config.iotaNetwork;
  const maxAmountNanos = parsePositiveNanos(opts.maxAmountNanos, 'maxAmountNanos');
  const dailyLimitNanos = parsePositiveNanos(opts.dailyLimitNanos, 'dailyLimitNanos');
  const allowedTo = Array.isArray(opts.allowedTo)
    ? [...new Set(opts.allowedTo.map((a) => String(a).trim().toLowerCase()).filter(Boolean))]
    : [];
  return { label, network, maxAmountNanos, dailyLimitNanos, allowedTo };
}

export function publicStation(row, extras = {}) {
  if (!row) return null;
  const day = utcDay();
  const usage = getAgentStationUsage.get(row.id, day);
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    network: row.network,
    maxAmountNanos: row.max_amount_nanos ?? null,
    dailyLimitNanos: row.daily_limit_nanos ?? null,
    allowedTo: parseJsonArray(row.allowed_to),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    todayUsedNanos: usage?.amount_nanos || '0',
    todayRequestCount: usage?.request_count || 0,
    ...extras,
  };
}

export function createAgentStation(userId, opts = {}) {
  const n = countAgentStationsByUser.get(userId)?.n || 0;
  if (n >= MAX_STATIONS_PER_USER) {
    throw new Error(`Maximal ${MAX_STATIONS_PER_USER} Agent-Stationen pro Konto.`);
  }
  const o = normalizeStationOpts(opts);
  const wallet = createStationWallet();
  const id = `ast_${randomBytes(9).toString('base64url')}`;
  insertAgentStation.run(
    id,
    userId,
    o.label,
    wallet.address,
    encrypt(wallet.secret),
    o.network,
    o.maxAmountNanos,
    o.dailyLimitNanos,
    JSON.stringify(o.allowedTo),
    now(),
  );
  return publicStation(getAgentStation.get(id));
}

export async function listAgentStations(userId, { withBalance = false } = {}) {
  const rows = listAgentStationsByUser.all(userId);
  const out = [];
  for (const row of rows) {
    let balance = null;
    let networkError = null;
    if (withBalance) {
      try {
        balance = await getBalance(row.network, row.address);
      } catch (err) {
        networkError = err.message;
      }
    }
    out.push(publicStation(row, { balance, networkError }));
  }
  return out;
}

export function getStationForUser(userId, stationId) {
  const row = getAgentStation.get(stationId);
  if (!row || row.user_id !== userId) return null;
  return row;
}

export function updateStationPolicy(userId, stationId, patch = {}) {
  const row = getStationForUser(userId, stationId);
  if (!row) return null;
  const o = normalizeStationOpts({
    label: patch.label ?? row.label,
    network: patch.network ?? row.network,
    maxAmountNanos: patch.maxAmountNanos !== undefined ? patch.maxAmountNanos : row.max_amount_nanos,
    dailyLimitNanos: patch.dailyLimitNanos !== undefined ? patch.dailyLimitNanos : row.daily_limit_nanos,
    allowedTo: patch.allowedTo !== undefined ? patch.allowedTo : parseJsonArray(row.allowed_to),
  });
  const enabled = patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0);
  updateAgentStationPolicy.run(
    o.label,
    o.network,
    o.maxAmountNanos,
    o.dailyLimitNanos,
    JSON.stringify(o.allowedTo),
    enabled ? 1 : 0,
    stationId,
    userId,
  );
  return publicStation(getAgentStation.get(stationId));
}

export function removeAgentStation(userId, stationId) {
  return deleteAgentStation.run(stationId, userId).changes > 0;
}

export function listStationPayments(userId, stationId) {
  const row = getStationForUser(userId, stationId);
  if (!row) return null;
  return listAgentStationPayments.all(stationId).map((p) => ({
    id: p.id,
    to: p.to_address,
    amountNanos: p.amount,
    memo: p.memo,
    txDigest: p.tx_digest,
    status: p.status,
    error: p.error,
    tokenId: p.token_id,
    createdAt: p.created_at,
  }));
}

/**
 * Policy für Stations-Zahlung (Station + optionale Token-Limits).
 * @returns {{ ok: true, station } | { ok: false, error: string, code?: string }}
 */
export function checkStationPayPolicy({ station, tokenRow, to, amountNanos }) {
  if (!station.enabled) {
    return { ok: false, error: 'Agent-Station ist deaktiviert.', code: 'disabled' };
  }
  if (!isValidAddress(to)) {
    return { ok: false, error: 'Ungültige Zieladresse.', code: 'address' };
  }

  let amount;
  try { amount = BigInt(amountNanos); } catch { amount = 0n; }
  if (amount <= 0n) return { ok: false, error: 'Betrag muss größer als 0 sein.', code: 'amount' };

  const allowed = parseJsonArray(station.allowed_to);
  if (allowed.length) {
    const target = String(to).trim().toLowerCase();
    if (!allowed.includes(target)) {
      return { ok: false, error: 'Zieladresse ist für diese Station nicht freigegeben.', code: 'policy' };
    }
  }

  if (station.max_amount_nanos != null && amount > BigInt(station.max_amount_nanos)) {
    return {
      ok: false,
      error: `Betrag überschreitet Stations-Limit (${station.max_amount_nanos} Nanos).`,
      code: 'policy',
    };
  }

  if (station.daily_limit_nanos != null) {
    const usage = getAgentStationUsage.get(station.id, utcDay());
    const used = BigInt(usage?.amount_nanos || '0');
    if (used + amount > BigInt(station.daily_limit_nanos)) {
      return {
        ok: false,
        error: `Stations-Tageslimit überschritten (${station.daily_limit_nanos} Nanos/Tag).`,
        code: 'policy',
      };
    }
  }

  // Token-Bindung und Token-Limits (zusätzlich)
  if (tokenRow) {
    if (tokenRow.station_id && tokenRow.station_id !== station.id) {
      return { ok: false, error: 'Agent-Token ist an eine andere Station gebunden.', code: 'policy' };
    }
    if (tokenRow.network_lock && tokenRow.network_lock !== station.network) {
      return {
        ok: false,
        error: `Token-Netzwerk (${tokenRow.network_lock}) ≠ nicht zur Station (${station.network}).`,
        code: 'policy',
      };
    }
    if (tokenRow.max_amount_nanos != null && amount > BigInt(tokenRow.max_amount_nanos)) {
      return {
        ok: false,
        error: `Betrag überschreitet Token-Limit (${tokenRow.max_amount_nanos} Nanos).`,
        code: 'policy',
      };
    }
    // Token-Tageslimit: race-sicher erst in reserveStationSpend geprüft/gebucht
    // (Usage-Reservierung muss atomar mit der Prüfung sein, siehe payFromStation).
    const tokenAllowed = parseJsonArray(tokenRow.allowed_to);
    if (tokenAllowed.length) {
      const target = String(to).trim().toLowerCase();
      if (!tokenAllowed.includes(target)) {
        return { ok: false, error: 'Zieladresse ist für diesen Agent-Token nicht freigegeben.', code: 'policy' };
      }
    }
  }

  return { ok: true, station, amount: amount.toString() };
}

/**
 * Reserviert eine Stations-Zahlung race-sicher: Idempotenz-Check,
 * Tageslimit-Prüfung (Station + ggf. Token) und Usage-Buchung laufen in
 * EINER synchronen SQLite-Transaktion, bevor die (langsame, async)
 * On-Chain-Sendung überhaupt beginnt. Node.js schaltet zwischen den
 * synchronen Statements nicht auf einen anderen Request um, daher können
 * zwei parallele Requests dasselbe Tageslimit nicht gemeinsam überschreiten
 * (anders als vorher, wo Lesen der Usage und spätere Buchung durch den
 * langsamen Chain-Call auseinanderklafften).
 * @returns {{ok:true,duplicate:boolean,payment?:object}|{ok:false,error:string}}
 */
function reserveStationSpend({
  paymentId, station, tokenId, tokenRow, to, amountNanos, memo, day, idempotencyKey,
}) {
  return db.transaction(() => {
    if (idempotencyKey) {
      const existing = getAgentStationPaymentByIdemKey.get(station.id, idempotencyKey);
      if (existing) return { ok: true, duplicate: true, payment: existing };
    }

    if (station.daily_limit_nanos != null) {
      const usage = getAgentStationUsage.get(station.id, day);
      const used = BigInt(usage?.amount_nanos || '0');
      if (used + BigInt(amountNanos) > BigInt(station.daily_limit_nanos)) {
        return {
          ok: false,
          error: `Stations-Tageslimit überschritten (${station.daily_limit_nanos} Nanos/Tag).`,
        };
      }
    }
    if (tokenRow?.daily_limit_nanos != null) {
      const usage = getAgentUsage.get(tokenId, day);
      const used = BigInt(usage?.amount_nanos || '0');
      if (used + BigInt(amountNanos) > BigInt(tokenRow.daily_limit_nanos)) {
        return {
          ok: false,
          error: `Token-Tageslimit überschritten (${tokenRow.daily_limit_nanos} Nanos/Tag).`,
        };
      }
    }

    insertAgentStationPayment.run(
      paymentId, station.id, tokenId || null, to, amountNanos, memo,
      null, 'pending', null, now(), idempotencyKey || null,
    );
    addAgentStationUsage(station.id, day, amountNanos);
    if (tokenId) addAgentUsage(tokenId, day, amountNanos);
    return { ok: true, duplicate: false };
  })();
}

/**
 * Zahlt aus der Station (Server-Signatur mit Stations-Key).
 *
 * `idempotencyKey` (vom Agent frei wählbar, z. B. UUID pro Zahlungsabsicht):
 * ein Retry mit demselben Key nach Timeout/Netzwerkfehler löst KEINE zweite
 * On-Chain-Zahlung aus, sondern liefert das Ergebnis des ersten Versuchs.
 * @returns {Promise<{ok:true,digest,paymentId,replay?:boolean}|{ok:false,error,code}>}
 */
export async function payFromStation({
  userId, stationId, tokenId = null, tokenRow = null, to, amountNanos, memo = '', idempotencyKey = null,
}) {
  const station = getStationForUser(userId, stationId);
  if (!station) return { ok: false, code: 'notfound', error: 'Station nicht gefunden.' };

  const policy = checkStationPayPolicy({
    station,
    tokenRow,
    to,
    amountNanos,
  });
  if (!policy.ok) return policy;

  const paymentId = `asp_${randomBytes(10).toString('base64url')}`;
  const day = utcDay();
  const cleanMemo = String(memo || '').slice(0, 200);
  const idemKey = idempotencyKey ? (String(idempotencyKey).trim().slice(0, 120) || null) : null;

  const reservation = reserveStationSpend({
    paymentId, station, tokenId, tokenRow, to, amountNanos: policy.amount, memo: cleanMemo, day, idempotencyKey: idemKey,
  });
  if (!reservation.ok) {
    return { ok: false, code: 'policy', error: reservation.error };
  }
  if (reservation.duplicate) {
    const p = reservation.payment;
    if (p.status === 'success') {
      return { ok: true, digest: p.tx_digest, paymentId: p.id, stationId: station.id, replay: true };
    }
    if (p.status === 'pending') {
      return { ok: false, code: 'pending', error: 'Zahlung mit diesem Idempotency-Key läuft bereits.', paymentId: p.id };
    }
    return { ok: false, code: 'chain', error: p.error || 'Zahlung mit diesem Idempotency-Key ist zuvor fehlgeschlagen.', paymentId: p.id };
  }

  try {
    const secret = decrypt(station.key_ciphertext);
    const result = await sendFromSecret(station.network, secret, to, policy.amount);
    updateAgentStationPayment.run('success', result.digest, null, paymentId);
    return { ok: true, digest: result.digest, paymentId, stationId: station.id };
  } catch (err) {
    updateAgentStationPayment.run('failed', null, err.message, paymentId);
    subAgentStationUsage(station.id, day, policy.amount);
    if (tokenId) subAgentUsage(tokenId, day, policy.amount);
    return { ok: false, code: 'chain', error: `Stations-Zahlung fehlgeschlagen: ${err.message}`, paymentId };
  }
}
