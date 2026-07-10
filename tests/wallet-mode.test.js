// Wallet-Modus: Non-Custodial (Standard) vs. Custodial (ORANGE_CUSTODIAL_MODE=1).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'ob-mode-'));
process.env.ORANGE_DB_PATH = join(dataDir, 'mode.db');
process.env.ORANGE_MASTER_KEY = 'cd'.repeat(32);

// Module nach Env laden.
const { config } = await import('../server/config.js');
const {
  initSelfCustodyWallet, isSelfCustody, loadKeypair, getAddress,
} = await import('../server/wallet.js');
const { insertUser, insertCredential, now } = await import('../server/db.js');

before(() => {
  insertUser.run('u-nc', 'noncust', 'noncust', now(), 0);
  insertCredential.run('cred-1', 'u-nc', Buffer.alloc(32, 1), 0, '[]', 'singleDevice', 0, now());
});

after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('wallet mode config', () => {
  test('default is non-custodial', () => {
    assert.equal(config.custodialMode, false);
    assert.equal(config.walletMode, 'non-custodial');
  });
});

describe('non-custodial wallet init', () => {
  test('initSelfCustodyWallet stores address without server key', () => {
    const address = '0x' + 'ab'.repeat(32);
    const pub = Buffer.alloc(32, 2);
    initSelfCustodyWallet('u-nc', {
      address, publicKey: pub, credentialId: 'cred-1', wrapped: 'dGVzdC13cmFwcGVkLXNlZWQ=',
    });
    assert.equal(getAddress('u-nc'), address);
    assert.equal(isSelfCustody('u-nc'), true);
    assert.equal(loadKeypair('u-nc'), null);
  });

  test('isSelfCustody ist false ohne Wallet', () => {
    assert.equal(isSelfCustody('u-no-wallet'), false);
  });
});
