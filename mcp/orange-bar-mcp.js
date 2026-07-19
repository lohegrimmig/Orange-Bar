#!/usr/bin/env node
/**
 * Minimaler MCP-Server für Orange-Bar (Propose-only).
 * Spricht JSON-RPC 2.0 über stdin/stdout und ruft die Agent-REST-API auf.
 *
 * Env:
 *   ORANGE_BAR_URL           Basis-URL der Instanz (z. B. https://wallet.example.com)
 *   ORANGE_BAR_AGENT_TOKEN   Bearer-Token (oba_…)
 *
 * Siehe docs/AGENT_ARCHITECTURE.md
 */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.ORANGE_BAR_URL || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.ORANGE_BAR_AGENT_TOKEN || '';

const TOOLS = [
  {
    name: 'get_balance',
    description: 'Liest Adresse, Netzwerk und IOTA-Guthaben der Orange-Bar-Wallet (read-only).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_payment',
    description:
      'Legt eine Zahlungsanfrage an. Der Nutzer muss sie in der Orange-Bar-PWA per Passkey bestätigen. Kein automatisches Signieren.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Zieladresse (0x…)' },
        amountNanos: { type: 'string', description: 'Betrag in Nanos (1 IOTA = 1_000_000_000)' },
        memo: { type: 'string', description: 'Optionaler Vermerk' },
        projectId: { type: 'string', description: 'Optionale Barkeeper-Projekt-ID' },
      },
      required: ['to', 'amountNanos'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_payment_status',
    description: 'Status einer Pay-Request-ID (pending|confirmed|rejected|expired).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pay-Request-UUID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_stations',
    description: 'Listet Agent-Stationen (Hot-Wallet-Float) inkl. Guthaben. Scope: read oder station_spend.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'station_pay',
    description:
      'Zahlt aus der Agent-Station (nicht aus dem User-Passkey-Wallet). Scope station_spend erforderlich. Limits der Station und des Tokens greifen.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Zieladresse (0x…)' },
        amountNanos: { type: 'string', description: 'Betrag in Nanos' },
        stationId: { type: 'string', description: 'Stations-ID (optional wenn Token gebunden)' },
        memo: { type: 'string', description: 'Optionaler Vermerk' },
        idempotencyKey: {
          type: 'string',
          description:
            'Eindeutiger Schlüssel für diesen Zahlungsversuch (frei wählbar, z. B. UUID). ' +
            'Bei Timeout/Fehler denselben Wert erneut senden, statt einen neuen Aufruf zu ' +
            'starten – verhindert eine doppelte Auszahlung durch Retries. Ohne Angabe wird ' +
            'pro Tool-Aufruf ein neuer Schlüssel erzeugt (schützt dann nur diesen einen Call).',
        },
      },
      required: ['to', 'amountNanos'],
      additionalProperties: false,
    },
  },
  {
    name: 'pay_for_resource',
    description:
      'Ruft eine URL auf. Antwortet sie mit 402 Payment Required (x402-artig, IOTA), zahlt der Agent automatisch aus der Agent-Station und ruft die URL erneut mit dem Zahlungsbeweis auf. Scope station_spend erforderlich. So kann ein Agent eigenständig für einen realen Merchant-Endpunkt bezahlen und dessen Ergebnis nutzen.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Geschützte URL (Merchant/Resource-Server)' },
        stationId: { type: 'string', description: 'Stations-ID (optional wenn Token gebunden)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

async function api(method, path, body) {
  if (!TOKEN) throw new Error('ORANGE_BAR_AGENT_TOKEN fehlt.');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

/** x402-artiger Client-Flow: GET → bei 402 aus der Agent-Station zahlen → GET mit Beweis. */
async function payForResource(url, stationId) {
  if (!url) throw new Error('url erforderlich.');
  const first = await fetch(url);
  if (first.status !== 402) {
    return { status: first.status, body: safeJson(await first.text()) };
  }
  const requirements = await first.json();
  const offer = (requirements.accepts || [])[0];
  if (!offer) throw new Error('402-Antwort enthält keine Zahlungsoptionen (accepts[]).');
  const network = String(offer.network || '').replace(/^iota:/, '');

  const pay = await api('POST', '/api/agent/station/pay', {
    to: offer.payTo,
    amountNanos: offer.amountNanos,
    stationId,
    memo: `x402:${url}`,
  });

  const second = await fetch(url, {
    headers: {
      'X-Payment-Digest': pay.digest,
      ...(offer.challengeId ? { 'X-Payment-Challenge': offer.challengeId } : {}),
    },
  });
  return {
    status: second.status,
    network,
    digest: pay.digest,
    body: safeJson(await second.text()),
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'get_balance':
      return api('GET', '/api/agent/wallet/summary');
    case 'create_payment':
      return api('POST', '/api/agent/pay/request', {
        to: args.to,
        amountNanos: args.amountNanos,
        memo: args.memo,
        projectId: args.projectId,
      });
    case 'get_payment_status':
      return api('GET', `/api/agent/pay/request/${encodeURIComponent(args.id)}`);
    case 'list_stations':
      return api('GET', '/api/agent/stations/list');
    case 'station_pay':
      return api('POST', '/api/agent/station/pay', {
        to: args.to,
        amountNanos: args.amountNanos,
        stationId: args.stationId,
        memo: args.memo,
        idempotencyKey: args.idempotencyKey || randomUUID(),
      });
    case 'pay_for_resource':
      return payForResource(args.url, args.stationId);
    default:
      throw new Error(`Unbekanntes Tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;

  // Notifications (kein id) – ignorieren außer logging
  if (id === undefined) return;

  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'orange-bar', version: '1.0.0' },
      });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const result = await callTool(name, args);
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    }
    return fail(id, -32601, `Methode nicht unterstützt: ${method}`);
  } catch (err) {
    if (method === 'tools/call') {
      return ok(id, {
        content: [{ type: 'text', text: String(err.message || err) }],
        isError: true,
      });
    }
    return fail(id, -32000, String(err.message || err));
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg);
});

// stderr nur für Diagnose – stdout ist MCP-framed
if (!TOKEN) {
  console.error('[orange-bar-mcp] Warnung: ORANGE_BAR_AGENT_TOKEN nicht gesetzt.');
}
console.error(`[orange-bar-mcp] Bereit → ${BASE}`);
