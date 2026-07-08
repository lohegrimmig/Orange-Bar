import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ob-test-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '33'.repeat(32);

const { ensureStation } = await import('../server/wallet.js');
const { getStation, updateStationConfig } = await import('../server/db.js');

test('Gas Station wird beim ersten Zugriff angelegt und ist stabil', () => {
  const first = ensureStation();
  assert.match(first.address, /^0x[0-9a-f]{64}$/);
  assert.equal(first.enabled, 0); // standardmäßig aus

  const second = ensureStation();
  assert.equal(second.address, first.address); // kein zweites Wallet
});

test('Stations-Konfiguration lässt sich ändern', () => {
  ensureStation();
  updateStationConfig.run(1, '250000000');
  const st = getStation.get();
  assert.equal(st.enabled, 1);
  assert.equal(st.amount_nanos, '250000000');
});
