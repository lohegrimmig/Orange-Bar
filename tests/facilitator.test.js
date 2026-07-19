import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ob-facilitator-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '99'.repeat(32);
process.env.ORANGE_CUSTODIAL_MODE = '1';
process.env.ORANGE_DISABLE_WATCHER = '1';

const { matchesPayment, verifyPayment, settlePayment } = await import('../server/facilitator.js');
const { insertFacilitatorReceipt, now } = await import('../server/db.js');

const PAY_TO = '0x' + 'ab'.repeat(32);
const OTHER = '0x' + 'cd'.repeat(32);

function fakeTx({ status = 'success', owner = PAY_TO, amount = '10000000', coinType = '0x2::iota::IOTA' } = {}) {
  return {
    effects: { status: { status } },
    balanceChanges: [{ owner: { AddressOwner: owner }, coinType, amount }],
  };
}

describe('facilitator: matchesPayment (rein, ohne Netzwerk)', () => {
  test('passende Gutschrift → ok', () => {
    const r = matchesPayment(fakeTx(), { payTo: PAY_TO, amountNanos: '10000000' });
    assert.equal(r.ok, true);
    assert.equal(r.receivedNanos, '10000000');
  });

  test('Adresse case-insensitive', () => {
    const r = matchesPayment(fakeTx({ owner: PAY_TO.toUpperCase() }), { payTo: PAY_TO, amountNanos: '10000000' });
    assert.equal(r.ok, true);
  });

  test('höhere Gutschrift als gefordert reicht', () => {
    const r = matchesPayment(fakeTx({ amount: '20000000' }), { payTo: PAY_TO, amountNanos: '10000000' });
    assert.equal(r.ok, true);
  });

  test('fehlgeschlagene Tx → status', () => {
    const r = matchesPayment(fakeTx({ status: 'failure' }), { payTo: PAY_TO, amountNanos: '10000000' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'status');
  });

  test('Gutschrift an falsche Adresse → nomatch', () => {
    const r = matchesPayment(fakeTx({ owner: OTHER }), { payTo: PAY_TO, amountNanos: '10000000' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'nomatch');
  });

  test('Gutschrift zu gering → amount', () => {
    const r = matchesPayment(fakeTx({ amount: '5000000' }), { payTo: PAY_TO, amountNanos: '10000000' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'amount');
  });

  test('falscher Coin-Type wird ignoriert → nomatch', () => {
    const r = matchesPayment(fakeTx({ coinType: '0x2::coin::Coin<0xabc::usdc::USDC>' }), {
      payTo: PAY_TO, amountNanos: '10000000',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'nomatch');
  });
});

describe('facilitator: verifyPayment Eingabeprüfung (ohne Netzwerk)', () => {
  test('ungültige payTo-Adresse → address', async () => {
    const r = await verifyPayment({ network: 'testnet', digest: 'x', payTo: 'not-an-address', amountNanos: '1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'address');
  });

  test('amountNanos <= 0 → amount', async () => {
    const r = await verifyPayment({ network: 'testnet', digest: 'x', payTo: PAY_TO, amountNanos: '0' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'amount');
  });
});

describe('facilitator: settlePayment Replay-Schutz', () => {
  test('bereits verbrauchter Digest wird ohne Netzwerkzugriff abgelehnt', async () => {
    const digest = 'dGVzdC1kaWdlc3Qtc2V0dGxl';
    insertFacilitatorReceipt.run(digest, 'testnet', PAY_TO, '10000000', '/demo', now());
    const r = await settlePayment({ network: 'testnet', digest, payTo: PAY_TO, amountNanos: '10000000' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'replay');
  });
});
