import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ob-test-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '22'.repeat(32);
process.env.ORANGE_CUSTODIAL_MODE = '1';

const { createWalletForUser, loadKeypair, getAddress, isValidAddress, payRequestStatusFromChain, txStatusFromResponse } = await import('../server/wallet.js');
const { insertUser, now } = await import('../server/db.js');

test('Wallet wird erzeugt und Keypair lässt sich wieder laden', () => {
  insertUser.run('user-1', 'tester', 'tester', now(), 0);
  const { address } = createWalletForUser('user-1');
  assert.match(address, /^0x[0-9a-f]{64}$/);
  assert.equal(getAddress('user-1'), address);

  const keypair = loadKeypair('user-1');
  assert.equal(keypair.getPublicKey().toIotaAddress(), address);
});

test('isValidAddress erkennt gültige und ungültige Adressen', () => {
  assert.equal(isValidAddress('0x' + 'ab'.repeat(32)), true);
  assert.equal(isValidAddress('0x1234'), false);
  assert.equal(isValidAddress('kein-hex'), false);
  assert.equal(isValidAddress(null), false);
});

test('payRequestStatusFromChain mappt Chain-Status', () => {
  assert.equal(payRequestStatusFromChain('success'), 'confirmed');
  assert.equal(payRequestStatusFromChain('failure'), 'failed');
  assert.equal(payRequestStatusFromChain('unknown'), 'pending');
  assert.equal(payRequestStatusFromChain('unknown', 'digest123'), 'confirmed');
  assert.equal(txStatusFromResponse({ effects: { status: { status: 'success' } } }), 'success');
});

test('displayFromObject nutzt Display oder Move-Felder (Mintly ForgeCard)', async () => {
  const { displayFromObject } = await import('../server/wallet.js');
  assert.equal(displayFromObject({ display: { data: { name: 'A', image_url: 'https://x/a.png' } } }).name, 'A');
  const mintly = displayFromObject({
    display: { data: null },
    content: {
      dataType: 'moveObject',
      fields: { name: 'Artefakt 13', image_url: 'https://mintlylab.com/x.png', rarity: 'common' },
    },
  });
  assert.equal(mintly.name, 'Artefakt 13');
  assert.equal(mintly.image_url, 'https://mintlylab.com/x.png');
  assert.equal(mintly.description, 'common');
});
