// Agent-Gateway: Session-Verwaltung der Tokens + Bearer-API (Propose-only).
// Phase 2: Token-Mint nur nach WebAuthn (prepare/confirm).
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { requireAuth } from '../session.js';
import {
  createAgentToken, listAgentTokens, revokeAgentTokenForUser,
  verifyAgentBearer, agentHasScope, checkPayPolicy, recordAgentPayUsage,
  normalizeTokenOpts, AGENT_SCOPES,
} from '../agent.js';
import {
  createAgentStation, listAgentStations, updateStationPolicy, removeAgentStation,
  listStationPayments, payFromStation, normalizeStationOpts,
  MAX_STATIONS_PER_USER,
} from '../agent-station.js';
import {
  insertPayRequest, getPayRequest, getProject, now,
  getCredentialById, getCredentialsByUser, updateCredentialCounter,
  insertChallenge, getChallenge, deleteChallenge, getAgentUsage,
} from '../db.js';
import { getAddress, getBalance, isValidAddress, NANOS_PER_IOTA } from '../wallet.js';
import { config } from '../config.js';
import { rateLimit } from '../ratelimit.js';
import { pushToUser } from '../push.js';

export const agentRouter = Router();

const PAY_TTL = 600;
const AGENT_CHALLENGE_TTL = 120;

function requireAgent(scope) {
  return (req, res, next) => {
    const auth = verifyAgentBearer(req.get('authorization'));
    if (!auth) return res.status(401).json({ error: 'Ungültiger oder abgelaufener Agent-Token.' });
    if (scope && !agentHasScope(auth, scope)) {
      return res.status(403).json({ error: `Scope „${scope}“ fehlt.`, code: 'scope' });
    }
    req.agentAuth = auth;
    req.user = auth.user;
    next();
  };
}

function requireAgentAnyScope(...scopes) {
  return (req, res, next) => {
    const auth = verifyAgentBearer(req.get('authorization'));
    if (!auth) return res.status(401).json({ error: 'Ungültiger oder abgelaufener Agent-Token.' });
    if (!scopes.some((s) => agentHasScope(auth, s))) {
      return res.status(403).json({ error: 'Erforderlicher Scope fehlt.', code: 'scope' });
    }
    req.agentAuth = auth;
    req.user = auth.user;
    next();
  };
}

function allowCredentialsFor(userId) {
  return getCredentialsByUser.all(userId).map((c) => ({
    id: c.id,
    transports: JSON.parse(c.transports || '[]'),
  }));
}

async function verifyUserPasskey(userId, challengeRow, response) {
  const cred = getCredentialById.get(response?.id);
  if (!cred || cred.user_id !== userId) {
    return { ok: false, status: 403, error: 'Passkey gehört nicht zu diesem Konto.' };
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeRow.challenge,
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
    return { ok: false, status: 400, error: `Passkey-Prüfung fehlgeschlagen: ${err.message}` };
  }
  if (!verification.verified) {
    return { ok: false, status: 401, error: 'Bestätigung fehlgeschlagen.' };
  }
  updateCredentialCounter.run(verification.authenticationInfo.newCounter, cred.id);
  return { ok: true };
}

function fmtIotaRough(nanos) {
  try {
    const n = BigInt(nanos);
    const whole = n / NANOS_PER_IOTA;
    const frac = (n % NANOS_PER_IOTA).toString().padStart(9, '0').replace(/0+$/, '').slice(0, 4);
    return `${whole}${frac ? '.' + frac : ''}`;
  } catch {
    return String(nanos);
  }
}

// --- Session: Token-Verwaltung (Phase 2: WebAuthn) ---

agentRouter.post('/tokens/prepare', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  let opts;
  try {
    opts = normalizeTokenOpts(req.body || {}, req.user.id);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Ungültige Token-Optionen.' });
  }
  const creds = allowCredentialsFor(req.user.id);
  if (!creds.length) return res.status(400).json({ error: 'Kein Passkey hinterlegt.' });

  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials: creds,
  });
  const challengeId = randomUUID();
  insertChallenge.run(
    challengeId,
    'agent-token',
    req.user.id,
    options.challenge,
    JSON.stringify(opts),
    now() + AGENT_CHALLENGE_TTL,
  );
  res.json({ challengeId, options, preview: opts, availableScopes: AGENT_SCOPES });
});

agentRouter.post('/tokens/confirm', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = getChallenge.get(String(challengeId || ''));
  if (!row || row.kind !== 'agent-token' || row.user_id !== req.user.id) {
    return res.status(400).json({ error: 'Unbekannte Agent-Token-Challenge.' });
  }
  deleteChallenge.run(row.id);
  if (row.expires_at < now()) {
    return res.status(400).json({ error: 'Bestätigung abgelaufen – bitte erneut starten.' });
  }

  const verified = await verifyUserPasskey(req.user.id, row, response);
  if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

  try {
    const opts = JSON.parse(row.payload || '{}');
    const created = createAgentToken(req.user.id, {
      ...opts,
      ttlSeconds: opts.ttlSeconds,
      maxAmountNanos: opts.maxAmountNanos,
      dailyLimitNanos: opts.dailyLimitNanos,
      allowedTo: opts.allowedTo,
      projectId: opts.projectId,
      networkLock: opts.networkLock,
      stationId: opts.stationId,
      scopes: opts.scopes,
      label: opts.label,
    });
    res.status(201).json({
      ...created,
      hint: 'Token nur einmal sichtbar speichern. Widerruf über DELETE /api/agent/tokens/:id.',
      availableScopes: AGENT_SCOPES,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Token konnte nicht erzeugt werden.' });
  }
});

// Legacy: ohne Passkey nicht mehr erlaubt (Phase 2).
agentRouter.post('/tokens', requireAuth, (_req, res) => {
  res.status(400).json({
    error: 'Token-Erstellung erfordert Passkey-Bestätigung.',
    code: 'passkey-required',
    hint: 'Nutze POST /api/agent/tokens/prepare und /confirm.',
  });
});

agentRouter.get('/tokens', requireAuth, (req, res) => {
  res.json({ tokens: listAgentTokens(req.user.id), availableScopes: AGENT_SCOPES });
});

agentRouter.delete('/tokens/:id', requireAuth, (req, res) => {
  const row = revokeAgentTokenForUser(req.user.id, req.params.id);
  if (!row) return res.status(404).json({ error: 'Token nicht gefunden.' });
  res.json({ ok: true, token: row });
});

// --- Bearer: Read + Pay-Request ---

agentRouter.get('/wallet/summary', requireAgent('read'), async (req, res) => {
  const address = getAddress(req.user.id);
  if (!address) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });
  const network = req.user.network || config.iotaNetwork;
  if (req.agentAuth.row.network_lock && network !== req.agentAuth.row.network_lock) {
    return res.status(403).json({
      error: `Agent-Token ist auf Netzwerk „${req.agentAuth.row.network_lock}“ beschränkt.`,
      code: 'policy',
    });
  }
  try {
    const balance = await getBalance(network, address);
    res.json({
      address,
      network,
      networks: config.iotaNetworks,
      balance,
      nanosPerIota: String(NANOS_PER_IOTA),
      agent: { id: req.agentAuth.token.id, label: req.agentAuth.token.label },
    });
  } catch (err) {
    res.json({
      address,
      network,
      networks: config.iotaNetworks,
      balance: null,
      nanosPerIota: String(NANOS_PER_IOTA),
      networkError: `IOTA-Netzwerk nicht erreichbar: ${err.message}`,
      agent: { id: req.agentAuth.token.id, label: req.agentAuth.token.label },
    });
  }
});

agentRouter.post(
  '/pay/request',
  rateLimit({ windowMs: 60_000, max: 60 }),
  requireAgent('pay_request'),
  (req, res) => {
    const { to, amountNanos, memo, projectId } = req.body || {};
    if (!isValidAddress(to)) return res.status(400).json({ error: 'Ungültige Zieladresse.' });
    let amount;
    try { amount = BigInt(amountNanos); } catch { amount = 0n; }
    if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });

    const userNetwork = req.user.network || config.iotaNetwork;
    const policy = checkPayPolicy(req.agentAuth, {
      to,
      amountNanos: amount.toString(),
      projectId,
      userNetwork,
    });
    if (!policy.ok) return res.status(403).json({ error: policy.error, code: 'policy' });

    let projId = policy.projectId;
    if (projId) {
      const project = getProject.get(projId);
      if (!project) return res.status(404).json({ error: 'Unbekanntes Projekt.' });
      if (!project.enabled) return res.status(403).json({ error: 'Projekt ist deaktiviert.' });
    }

    const id = randomUUID();
    const origin = req.get('origin') || `agent:${req.agentAuth.token.id}`;
    const agentMemo = String(memo || '').slice(0, 160);
    const tagged = agentMemo
      ? `[agent:${req.agentAuth.token.label}] ${agentMemo}`.slice(0, 200)
      : `[agent:${req.agentAuth.token.label}]`.slice(0, 200);

    insertPayRequest.run(id, origin, to, amount.toString(), tagged, now(), now() + PAY_TTL, projId);
    recordAgentPayUsage(req.agentAuth.token.id, amount.toString());

    // Push (best effort) – Nutzer soll in der PWA bestätigen.
    const iota = fmtIotaRough(amount.toString());
    pushToUser(req.user.id, {
      title: 'Orange-Bar',
      body: `Agent „${req.agentAuth.token.label}“ will ${iota} IOTA senden`,
      url: `/?pay=${encodeURIComponent(id)}`,
    }).catch(() => {});

    res.status(201).json({
      id,
      expiresIn: PAY_TTL,
      status: 'pending',
      confirmUrl: `/?pay=${encodeURIComponent(id)}`,
      hint: 'Nutzer muss in der Orange-Bar-PWA per Passkey bestätigen.',
    });
  },
);

agentRouter.get('/pay/request/:id', requireAgentAnyScope('read', 'pay_request'), (req, res) => {
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

// --- Session: Agent-Stationen (Phase 3) ---

agentRouter.post('/stations/prepare', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  let opts;
  try {
    opts = normalizeStationOpts(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Ungültige Stations-Optionen.' });
  }
  const creds = allowCredentialsFor(req.user.id);
  if (!creds.length) return res.status(400).json({ error: 'Kein Passkey hinterlegt.' });

  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials: creds,
  });
  const challengeId = randomUUID();
  insertChallenge.run(
    challengeId,
    'agent-station',
    req.user.id,
    options.challenge,
    JSON.stringify(opts),
    now() + AGENT_CHALLENGE_TTL,
  );
  res.json({
    challengeId,
    options,
    preview: opts,
    maxStations: MAX_STATIONS_PER_USER,
    notice: 'Stations-Float ist ein separates Hot-Wallet. Nur kleine Beträge aufladen. Schlüssel liegen auf dem Server (wie Barkeeper-Gas).',
  });
});

agentRouter.post('/stations/confirm', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = getChallenge.get(String(challengeId || ''));
  if (!row || row.kind !== 'agent-station' || row.user_id !== req.user.id) {
    return res.status(400).json({ error: 'Unbekannte Agent-Station-Challenge.' });
  }
  deleteChallenge.run(row.id);
  if (row.expires_at < now()) {
    return res.status(400).json({ error: 'Bestätigung abgelaufen – bitte erneut starten.' });
  }
  const verified = await verifyUserPasskey(req.user.id, row, response);
  if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

  try {
    const opts = JSON.parse(row.payload || '{}');
    const station = createAgentStation(req.user.id, opts);
    res.status(201).json({
      station,
      hint: 'Lade die Station mit einer normalen Wallet-Überweisung an diese Adresse auf. Agenten mit Scope station_spend können daraus zahlen.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Station konnte nicht erzeugt werden.' });
  }
});

agentRouter.get('/stations', requireAuth, async (req, res) => {
  const stations = await listAgentStations(req.user.id, { withBalance: true });
  res.json({ stations, maxStations: MAX_STATIONS_PER_USER });
});

agentRouter.patch('/stations/:id', requireAuth, (req, res) => {
  try {
    const updated = updateStationPolicy(req.user.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Station nicht gefunden.' });
    res.json({ station: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

agentRouter.delete('/stations/:id', requireAuth, (req, res) => {
  if (!removeAgentStation(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Station nicht gefunden.' });
  }
  res.json({ ok: true });
});

agentRouter.get('/stations/:id/payments', requireAuth, (req, res) => {
  const list = listStationPayments(req.user.id, req.params.id);
  if (!list) return res.status(404).json({ error: 'Station nicht gefunden.' });
  res.json({ payments: list });
});

// --- Bearer: Station lesen / zahlen ---

agentRouter.get('/stations/list', requireAgentAnyScope('read', 'station_spend'), async (req, res) => {
  const stations = await listAgentStations(req.user.id, { withBalance: true });
  // Wenn Token an Station gebunden: nur diese
  const bound = req.agentAuth.row.station_id;
  const filtered = bound ? stations.filter((s) => s.id === bound) : stations;
  res.json({ stations: filtered });
});

agentRouter.post(
  '/station/pay',
  rateLimit({ windowMs: 60_000, max: 30 }),
  requireAgent('station_spend'),
  async (req, res) => {
    const { to, amountNanos, memo, stationId } = req.body || {};
    const bound = req.agentAuth.row.station_id;
    const sid = bound || stationId;
    if (!sid) {
      return res.status(400).json({
        error: 'stationId erforderlich (oder Token an eine Station binden).',
        code: 'station',
      });
    }
    if (bound && stationId && stationId !== bound) {
      return res.status(403).json({ error: 'Agent-Token ist an eine andere Station gebunden.', code: 'policy' });
    }

    // Token-Tageslimit vorab prüfen
    if (req.agentAuth.row.daily_limit_nanos != null) {
      let amount;
      try { amount = BigInt(amountNanos); } catch { amount = 0n; }
      const day = new Date().toISOString().slice(0, 10);
      const usage = getAgentUsage.get(req.agentAuth.token.id, day);
      const used = BigInt(usage?.amount_nanos || '0');
      if (used + amount > BigInt(req.agentAuth.row.daily_limit_nanos)) {
        return res.status(403).json({
          error: `Token-Tageslimit überschritten (${req.agentAuth.row.daily_limit_nanos} Nanos/Tag).`,
          code: 'policy',
        });
      }
    }

    const result = await payFromStation({
      userId: req.user.id,
      stationId: sid,
      tokenId: req.agentAuth.token.id,
      tokenRow: req.agentAuth.row,
      to,
      amountNanos,
      memo,
    });
    if (!result.ok) {
      const status = result.code === 'notfound' ? 404 : result.code === 'chain' ? 502 : 403;
      return res.status(status).json({ error: result.error, code: result.code, paymentId: result.paymentId });
    }

    recordAgentPayUsage(req.agentAuth.token.id, String(amountNanos));

    pushToUser(req.user.id, {
      title: 'Orange-Bar',
      body: `Agent „${req.agentAuth.token.label}“ hat aus der Station gezahlt`,
      url: '/?goto=settings',
    }).catch(() => {});

    res.status(201).json({
      ok: true,
      digest: result.digest,
      paymentId: result.paymentId,
      stationId: result.stationId,
      hint: 'Zahlung aus Agent-Station (nicht aus User-Wallet).',
    });
  },
);
