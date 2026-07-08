import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ob-test-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '22'.repeat(32);

const { createWalletForUser, loadKeypair, getAddress, isValidAddress } = await import('../server/wallet.js');
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
