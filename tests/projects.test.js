import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ob-test-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '55'.repeat(32);

const {
  createProject, updatePolicy, originAllowed, normalizeOrigin, verifyProjectSecret, claimGas,
} = await import('../server/projects.js');
const { insertUser, getProject, countProjectGrantsForUser, now } = await import('../server/db.js');
const { createWalletForUser } = await import('../server/wallet.js');

insertUser.run('bk-1', 'barkeeper', 'barkeeper', now(), 0);
insertUser.run('pl-1', 'player', 'player', now(), 0);
createWalletForUser('pl-1');

test('Projekt erstellen: eigene Station, Secret nur einmalig, Hash gespeichert', () => {
  const { id, secret, project } = createProject('bk-1', { name: 'Spiel', network: 'testnet', allowedOrigins: [] });
  assert.match(id, /^proj_/);
  assert.match(secret, /^obk_/);
  assert.match(project.station_address, /^0x[0-9a-f]{64}$/);
  assert.notEqual(project.secret_hash, secret); // im Klartext nirgends gespeichert
  assert.equal(verifyProjectSecret(project, secret), true);
  assert.equal(verifyProjectSecret(project, 'obk_falsch'), false);
});

test('normalizeOrigin / originAllowed: nur http(s), Allowlist greift', () => {
  assert.equal(normalizeOrigin('https://a.example/pfad?x=1'), 'https://a.example');
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
  const { project } = createProject('bk-1', {
    name: 'S', network: 'testnet', allowedOrigins: ['https://ok.example'],
  });
  assert.equal(originAllowed(project, 'https://ok.example'), true);
  assert.equal(originAllowed(project, 'https://evil.example'), false);
  assert.equal(originAllowed(project, undefined), false);
  // Leere Allowlist = alle erlaubt.
  const open = createProject('bk-1', { name: 'O', network: 'testnet', allowedOrigins: [] }).project;
  assert.equal(originAllowed(open, 'https://irgendwas.example'), true);
});

test('updatePolicy: nur der Barkeeper darf ändern; Limit/Beträge validiert', () => {
  const { id } = createProject('bk-1', { name: 'P', network: 'testnet', allowedOrigins: [] });
  assert.equal(updatePolicy('fremd', id, { gasPerGrant: '1', maxGrantsPerUser: 5 }), null);
  const upd = updatePolicy('bk-1', id, {
    gasPerGrant: '20000000', maxGrantsPerUser: 3, allowedOrigins: ['https://x.example'], enabled: true, network: 'devnet',
  });
  assert.equal(upd.maxGrantsPerUser, 3);
  assert.equal(upd.network, 'devnet');
  assert.throws(() => updatePolicy('bk-1', id, { gasPerGrant: '0', maxGrantsPerUser: 1 }), /größer als 0/);
});

test('claimGas: Pro-Nutzer-Limit 0 blockt ohne Reservierung', async () => {
  const { id } = createProject('bk-1', { name: 'L', network: 'testnet', allowedOrigins: [] });
  updatePolicy('bk-1', id, { gasPerGrant: '1000', maxGrantsPerUser: 0, allowedOrigins: [], enabled: true, network: 'testnet' });
  const project = getProject.get(id);
  const r = await claimGas(project, 'pl-1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'limit');
  assert.equal(countProjectGrantsForUser.get(id, 'pl-1').n, 0); // keine Phantom-Reservierung
});

test('claimGas: deaktiviertes Projekt liefert Fehler', async () => {
  const { id } = createProject('bk-1', { name: 'D', network: 'testnet', allowedOrigins: [] });
  updatePolicy('bk-1', id, { gasPerGrant: '1000', maxGrantsPerUser: 1, allowedOrigins: [], enabled: false, network: 'testnet' });
  const r = await claimGas(getProject.get(id), 'pl-1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'disabled');
});
