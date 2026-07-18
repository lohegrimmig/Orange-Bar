import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ob-agent-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '66'.repeat(32);
process.env.ORANGE_CUSTODIAL_MODE = '1';
process.env.ORANGE_DISABLE_WATCHER = '1';

const {
  createAgentToken, listAgentTokens, revokeAgentTokenForUser,
  verifyAgentBearer, agentHasScope, checkPayPolicy, recordAgentPayUsage,
  normalizeTokenOpts,
} = await import('../server/agent.js');
const { insertUser, getAgentTokenByHash, getProject, now } = await import('../server/db.js');
const { createWalletForUser, getAddress } = await import('../server/wallet.js');
const { createProject } = await import('../server/projects.js');

insertUser.run('u-agent', 'agentuser', 'Agent User', now(), 0);
createWalletForUser('u-agent');
const addr = getAddress('u-agent');

describe('agent tokens', () => {
  test('create: Klartext einmalig, nur Hash in DB, Prefix oba_', () => {
    const created = createAgentToken('u-agent', {
      label: 'Cursor',
      scopes: ['read', 'pay_request'],
      ttlSeconds: 3600,
      maxAmountNanos: '500000000',
      allowedTo: [addr],
    });
    assert.match(created.token, /^oba_/);
    assert.equal(created.label, 'Cursor');
    assert.deepEqual(created.scopes, ['read', 'pay_request']);
    assert.equal(created.maxAmountNanos, '500000000');
    assert.equal(created.active, true);

    const hash = createHash('sha256').update(created.token).digest('hex');
    const row = getAgentTokenByHash.get(hash);
    assert.ok(row);
    assert.equal(row.user_id, 'u-agent');
    assert.notEqual(row.token_hash, created.token);
  });

  test('verifyBearer: gültig / ungültig / widerrufen', () => {
    const { token, id } = createAgentToken('u-agent', { label: 'V', scopes: ['read'] });
    const ok = verifyAgentBearer(`Bearer ${token}`);
    assert.ok(ok);
    assert.equal(ok.user.id, 'u-agent');
    assert.equal(agentHasScope(ok, 'read'), true);
    assert.equal(agentHasScope(ok, 'pay_request'), false);

    assert.equal(verifyAgentBearer('Bearer oba_falsch'), null);
    assert.equal(verifyAgentBearer(null), null);

    revokeAgentTokenForUser('u-agent', id);
    assert.equal(verifyAgentBearer(`Bearer ${token}`), null);
  });

  test('list / revoke nur eigener User', () => {
    insertUser.run('u-other', 'other', 'Other', now(), 0);
    const a = createAgentToken('u-agent', { label: 'A' });
    const list = listAgentTokens('u-agent');
    assert.ok(list.some((t) => t.id === a.id));
    assert.equal(revokeAgentTokenForUser('u-other', a.id), null);
    assert.ok(revokeAgentTokenForUser('u-agent', a.id));
  });

  test('ungültige Scopes werden gefiltert; leere → read', () => {
    const c = createAgentToken('u-agent', { scopes: ['sign', 'read', 'evil'] });
    assert.deepEqual(c.scopes, ['read']);
  });
});

describe('pay policy phase 2', () => {
  test('Allowlist und Max-Betrag greifen', () => {
    const { token } = createAgentToken('u-agent', {
      scopes: ['pay_request'],
      maxAmountNanos: '1000',
      allowedTo: ['0x' + 'ab'.repeat(32)],
    });
    const auth = verifyAgentBearer(`Bearer ${token}`);
    const to = '0x' + 'ab'.repeat(32);
    assert.equal(checkPayPolicy(auth, { to, amountNanos: '500' }).ok, true);
    assert.equal(checkPayPolicy(auth, { to, amountNanos: '1001' }).ok, false);
    assert.equal(checkPayPolicy(auth, { to: '0x' + 'cd'.repeat(32), amountNanos: '1' }).ok, false);
  });

  test('Tageslimit zählt Usage', () => {
    const { token, id } = createAgentToken('u-agent', {
      scopes: ['pay_request'],
      dailyLimitNanos: '1000',
    });
    const auth = verifyAgentBearer(`Bearer ${token}`);
    const to = '0x' + '11'.repeat(32);
    assert.equal(checkPayPolicy(auth, { to, amountNanos: '600' }).ok, true);
    recordAgentPayUsage(id, '600');
    assert.equal(checkPayPolicy(auth, { to, amountNanos: '500' }).ok, false);
    assert.equal(checkPayPolicy(auth, { to, amountNanos: '400' }).ok, true);
  });

  test('Netzwerk-Lock und Projekt-Bindung', () => {
    const { id: projectId } = createProject('u-agent', {
      name: 'P', network: 'testnet', allowedOrigins: [],
    });
    const { token } = createAgentToken('u-agent', {
      scopes: ['pay_request'],
      networkLock: 'testnet',
      projectId,
    });
    const auth = verifyAgentBearer(`Bearer ${token}`);
    const to = '0x' + '22'.repeat(32);

    assert.equal(checkPayPolicy(auth, {
      to, amountNanos: '1', userNetwork: 'mainnet',
    }).ok, false);

    const ok = checkPayPolicy(auth, {
      to, amountNanos: '1', userNetwork: 'testnet',
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.projectId, projectId);

    assert.equal(checkPayPolicy(auth, {
      to, amountNanos: '1', userNetwork: 'testnet', projectId: 'proj_other',
    }).ok, false);
  });

  test('normalizeTokenOpts lehnt ungültiges Netzwerk ab', () => {
    assert.throws(() => normalizeTokenOpts({ networkLock: 'fantasie' }), /networkLock/);
  });
});
