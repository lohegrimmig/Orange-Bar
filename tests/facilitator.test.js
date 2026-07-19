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

const {
  matchesPayment, verifyPayment, settlePayment, createPaymentChallenge, settleChallenge,
} = await import('../server/facilitator.js');
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

describe('facilitator: createPaymentChallenge (Anti-Front-Running)', () => {
  test('ungültige Eingaben werfen', () => {
    assert.throws(() => createPaymentChallenge({ network: 'testnet', payTo: 'not-an-address', baseAmountNanos: '10000000' }));
    assert.throws(() => createPaymentChallenge({ network: 'testnet', payTo: PAY_TO, baseAmountNanos: '0' }));
  });

  test('Betrag bekommt einen kleinen, positiven Mikro-Aufschlag über dem Grundpreis', () => {
    const base = 10_000_000n;
    const c = createPaymentChallenge({ network: 'testnet', payTo: PAY_TO, baseAmountNanos: base.toString(), resource: '/paid' });
    assert.match(c.challengeId, /^pc_/);
    const amount = BigInt(c.amountNanos);
    assert.ok(amount >= base, 'amount darf Grundpreis nie unterschreiten');
    assert.ok(amount <= base + 999_999n, 'Jitter ist auf < 0.001 IOTA begrenzt');
    assert.equal(c.resource, '/paid');
    assert.ok(c.expiresAt > Date.now());
  });

  test('zwei Challenges zum selben Grundpreis bekommen (praktisch immer) unterschiedliche exakte Beträge', () => {
    const amounts = new Set();
    for (let i = 0; i < 20; i++) {
      const c = createPaymentChallenge({ network: 'testnet', payTo: PAY_TO, baseAmountNanos: '5000000' });
      amounts.add(c.amountNanos);
    }
    // Mit 20 Ziehungen aus ~1e6 Werten ist eine Kollision astronomisch unwahrscheinlich;
    // schlägt dieser Test doch fehl, ist es ein Hinweis auf einen kaputten Zufallsgenerator.
    assert.ok(amounts.size > 1);
  });
});

describe('facilitator: settleChallenge (bindet den Beweis an die konkrete Anfrage)', () => {
  test('unbekannte challengeId → "challenge", ohne Netzwerkzugriff', async () => {
    const r = await settleChallenge({ challengeId: 'pc_does-not-exist', digest: 'whatever' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'challenge');
  });

  test('abgelaufene Challenge wird abgelehnt, ohne Netzwerkzugriff', async () => {
    const c = createPaymentChallenge({ network: 'testnet', payTo: PAY_TO, baseAmountNanos: '1000000', ttlMs: -1 });
    const r = await settleChallenge({ challengeId: c.challengeId, digest: 'whatever' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'expired');
  });

  test('bereits verbrauchte Challenge wird abgelehnt, ohne erneuten Netzwerkzugriff', async () => {
    const c = createPaymentChallenge({ network: 'testnet', payTo: PAY_TO, baseAmountNanos: '1000000' });
    // Simuliert eine bereits erfolgreich eingelöste Challenge, ohne echten Chain-Call.
    insertFacilitatorReceipt.run('already-settled-digest', 'testnet', PAY_TO, c.amountNanos, null, Date.now());
    const { consumeFacilitatorChallenge } = await import('../server/db.js');
    consumeFacilitatorChallenge.run(Date.now(), 'already-settled-digest', c.challengeId, Date.now());

    // Ein Dritter, der denselben (bereits verbrauchten) Digest kennt, kommt nicht mehr durch –
    // genau das Szenario, das die Challenge-Bindung gegen Digest-Front-Running verhindert.
    const r = await settleChallenge({ challengeId: c.challengeId, digest: 'already-settled-digest' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'replay');
  });
});
