import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ob-ast-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '77'.repeat(32);
process.env.ORANGE_CUSTODIAL_MODE = '1';
process.env.ORANGE_DISABLE_WATCHER = '1';

const {
  createAgentStation, checkStationPayPolicy, updateStationPolicy,
  removeAgentStation, listAgentStations, MAX_STATIONS_PER_USER,
} = await import('../server/agent-station.js');
const { createAgentToken, verifyAgentBearer, AGENT_SCOPES } = await import('../server/agent.js');
const { insertUser, getAgentStation, now } = await import('../server/db.js');

insertUser.run('u-ast', 'astuser', 'Station User', now(), 0);

describe('agent station', () => {
  test('create: eigene Adresse, getrennt vom User-Wallet', () => {
    const s = createAgentStation('u-ast', {
      label: 'Float',
      network: 'testnet',
      maxAmountNanos: '1000000',
      dailyLimitNanos: '5000000',
      allowedTo: ['0x' + 'aa'.repeat(32)],
    });
    assert.match(s.id, /^ast_/);
    assert.match(s.address, /^0x[0-9a-f]{64}$/);
    assert.equal(s.label, 'Float');
    assert.equal(s.maxAmountNanos, '1000000');
    assert.equal(s.enabled, true);
    const row = getAgentStation.get(s.id);
    assert.ok(row.key_ciphertext?.length);
  });

  test('Max-Stationen-Limit', () => {
    // bereits 1 aus vorherigem Test
    for (let i = 0; i < MAX_STATIONS_PER_USER - 1; i++) {
      createAgentStation('u-ast', { label: `S${i}` });
    }
    assert.throws(() => createAgentStation('u-ast', { label: 'overflow' }), /Maximal/);
  });

  test('Policy: Allowlist, Max, disabled', () => {
    insertUser.run('u-ast2', 'ast2', 'A2', now(), 0);
    const s = createAgentStation('u-ast2', {
      maxAmountNanos: '1000',
      allowedTo: ['0x' + 'bb'.repeat(32)],
    });
    const row = getAgentStation.get(s.id);
    const to = '0x' + 'bb'.repeat(32);
    assert.equal(checkStationPayPolicy({ station: row, to, amountNanos: '500' }).ok, true);
    assert.equal(checkStationPayPolicy({ station: row, to, amountNanos: '1001' }).ok, false);
    assert.equal(checkStationPayPolicy({
      station: row, to: '0x' + 'cc'.repeat(32), amountNanos: '1',
    }).ok, false);

    updateStationPolicy('u-ast2', s.id, { enabled: false, label: s.label, network: 'testnet' });
    const disabled = getAgentStation.get(s.id);
    assert.equal(checkStationPayPolicy({ station: disabled, to, amountNanos: '1' }).ok, false);
  });

  test('Token-Bindung an Station', () => {
    insertUser.run('u-ast3', 'ast3', 'A3', now(), 0);
    const s = createAgentStation('u-ast3', { label: 'Bound' });
    const other = createAgentStation('u-ast3', { label: 'other' });
    const { token } = createAgentToken('u-ast3', {
      scopes: ['station_spend'],
      stationId: s.id,
    });
    const auth = verifyAgentBearer(`Bearer ${token}`);
    assert.equal(auth.token.stationId, s.id);
    assert.ok(AGENT_SCOPES.includes('station_spend'));

    const row = getAgentStation.get(other.id);
    assert.equal(checkStationPayPolicy({
      station: row,
      tokenRow: auth.row,
      to: '0x' + 'dd'.repeat(32),
      amountNanos: '1',
    }).ok, false);

    const okRow = getAgentStation.get(s.id);
    assert.equal(checkStationPayPolicy({
      station: okRow,
      tokenRow: auth.row,
      to: '0x' + 'dd'.repeat(32),
      amountNanos: '1',
    }).ok, true);
  });

  test('löschen', async () => {
    insertUser.run('u-ast4', 'ast4', 'A4', now(), 0);
    const s = createAgentStation('u-ast4', { label: 'bye' });
    assert.equal(removeAgentStation('u-ast4', s.id), true);
    const list = await listAgentStations('u-ast4');
    assert.equal(list.length, 0);
  });
});
