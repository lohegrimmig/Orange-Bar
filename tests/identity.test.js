// Identity Phase 1–2 (docs/IDENTITY_ARCHITECTURE.md): did:key, JWT-VC-Signieren
// und -Prüfen, Policy-Engine mit Alters-Gate. Läuft ohne Netzwerk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';

const dir = mkdtempSync(join(tmpdir(), 'ob-test-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '66'.repeat(32);
process.env.ORANGE_CUSTODIAL_MODE = '1';

const { didKeyFromPublicKey, publicKeyFromDidKey, base58btcEncode, base58btcDecode } =
  await import('../server/identity/didkey.js');
const { signCredentialJwt, verifyCredentialJwt, proofHash, nowSec } = await import('../server/identity/vc.js');
const { ageFlags, issueDemoAgeCredential, getUserDid, ensureInstanceIssuer } = await import('../server/identity/issuer.js');
const { evaluateAndGrant, policyCheck, requiredPolicyIds } = await import('../server/identity/policy.js');
const {
  insertUser, getWalletByUser, insertTrustedIssuer, getEntitlement, insertProject, now,
} = await import('../server/db.js');
const { createWalletForUser } = await import('../server/wallet.js');
const { encrypt, decrypt } = await import('../server/crypto.js');

// entitlements.project_id hat eine FOREIGN KEY auf projects(id) – für Tests, die
// evaluateAndGrant() bis zum erfolgreichen Insert durchlaufen, braucht es also
// eine echte Projektzeile (nicht nur ein Plain-Object für die Policy-Prüfung).
function makeProject({ id, network }) {
  insertUser.run(`bk-${id}`, `bk-${id}`, `bk-${id}`, now(), 0);
  insertProject.run({
    id, barkeeper_id: `bk-${id}`, name: id, secret_hash: 'x',
    station_address: '0x0', station_key_ciphertext: encrypt(Buffer.from('dummy')),
    network, gas_per_grant: '50000000', max_grants_per_user: 1, allowed_origins: '[]',
    created_at: now(),
  });
  return { id, network, age_policy: 18 };
}

test('base58btc: Roundtrip für zufällige Bytes', () => {
  for (let i = 0; i < 20; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(1 + Math.floor(Math.random() * 40)));
    assert.deepEqual(base58btcDecode(base58btcEncode(bytes)), bytes);
  }
});

test('did:key: Roundtrip aus einem Ed25519-Pubkey', async () => {
  const kp = new Ed25519Keypair();
  const pub = kp.getPublicKey().toRawBytes();
  const did = didKeyFromPublicKey(pub);
  assert.match(did, /^did:key:z/);
  assert.deepEqual(publicKeyFromDidKey(did), pub);
});

test('JWT-VC: signieren und prüfen ist konsistent (gültige Signatur, Zeitfenster)', async () => {
  const issuer = new Ed25519Keypair();
  const issuerDid = didKeyFromPublicKey(issuer.getPublicKey().toRawBytes());
  const subject = new Ed25519Keypair();
  const subjectDid = didKeyFromPublicKey(subject.getPublicKey().toRawBytes());

  const jwt = await signCredentialJwt({
    issuerKeypair: issuer, issuerDid, subjectDid,
    type: 'AgeCredential', claims: { ageOver18: true }, expiresAt: nowSec() + 3600, demo: true,
  });
  const { payload } = await verifyCredentialJwt(jwt);
  assert.equal(payload.iss, issuerDid);
  assert.equal(payload.sub, subjectDid);
  assert.equal(payload.vc.credentialSubject.ageOver18, true);
  assert.equal(payload.vc.demo, true);
  assert.match(proofHash(jwt), /^[0-9a-f]{64}$/);
});

test('JWT-VC: manipulierte Signatur wird abgelehnt', async () => {
  const issuer = new Ed25519Keypair();
  const issuerDid = didKeyFromPublicKey(issuer.getPublicKey().toRawBytes());
  const jwt = await signCredentialJwt({
    issuerKeypair: issuer, issuerDid, subjectDid: issuerDid,
    type: 'AgeCredential', claims: { ageOver18: true }, expiresAt: nowSec() + 3600,
  });
  const parts = jwt.split('.');
  parts[1] = Buffer.from(JSON.stringify({ iss: issuerDid, vc: { credentialSubject: { ageOver18: true } } })).toString('base64url');
  await assert.rejects(() => verifyCredentialJwt(parts.join('.')));
});

test('JWT-VC: abgelaufenes Credential wird abgelehnt', async () => {
  const issuer = new Ed25519Keypair();
  const issuerDid = didKeyFromPublicKey(issuer.getPublicKey().toRawBytes());
  const jwt = await signCredentialJwt({
    issuerKeypair: issuer, issuerDid, subjectDid: issuerDid,
    type: 'AgeCredential', claims: { ageOver18: true }, expiresAt: nowSec() - 10,
  });
  await assert.rejects(() => verifyCredentialJwt(jwt), /abgelaufen/);
});

test('ageFlags: berechnet ageOver16/18 korrekt und wirft bei ungültigem Datum', () => {
  const at = new Date('2026-07-10T00:00:00Z');
  assert.deepEqual(ageFlags('2008-07-10', at), { ageOver16: true, ageOver18: true }); // genau 18
  assert.deepEqual(ageFlags('2008-07-11', at), { ageOver16: true, ageOver18: false }); // noch nicht 18
  assert.deepEqual(ageFlags('2010-01-01', at), { ageOver16: true, ageOver18: false });
  assert.deepEqual(ageFlags('2012-01-01', at), { ageOver16: false, ageOver18: false });
  assert.throws(() => ageFlags('nicht-valide'));
  assert.throws(() => ageFlags('2099-01-01', at)); // Zukunft
});

test('Demo-Ausstellung: Geburtsdatum wird NICHT gespeichert, nur Flags', async () => {
  insertUser.run('idu-1', 'idtester', 'idtester', now(), 0);
  createWalletForUser('idu-1');
  const meta = await issueDemoAgeCredential('idu-1', '2000-01-01');
  assert.equal(meta.demo, true);
  assert.equal(meta.claims.ageOver18, true);
  assert.ok(!('birthdate' in meta.claims));
  assert.ok(!JSON.stringify(meta).includes('2000-01-01'));
});

test('Policy-Engine: Demo-Aussteller wird für Mainnet-Projekte abgelehnt', async () => {
  insertUser.run('idu-2', 'idtester2', 'idtester2', now(), 0);
  createWalletForUser('idu-2');
  const subjectDid = getUserDid('idu-2');
  const station = ensureInstanceIssuer();

  const issuerRow = (await import('../server/db.js')).getInstanceIssuer.get();
  const { Ed25519Keypair: EK } = await import('@iota/iota-sdk/keypairs/ed25519');
  const kp = EK.fromSecretKey(decrypt(issuerRow.key_ciphertext).toString('utf8'));
  const jwt = await signCredentialJwt({
    issuerKeypair: kp, issuerDid: issuerRow.did, subjectDid,
    type: 'AgeCredential', claims: { ageOver18: true }, expiresAt: nowSec() + 3600, demo: true,
  });
  const { payload } = await verifyCredentialJwt(jwt);

  const mainnetProject = makeProject({ id: 'proj-main', network: 'mainnet' });
  const testnetProject = makeProject({ id: 'proj-test', network: 'testnet' });

  const onMainnet = evaluateAndGrant({ project: mainnetProject, userId: 'idu-2', policyId: 'age18', vcPayload: payload, jwt });
  assert.equal(onMainnet.ok, false);
  assert.equal(onMainnet.code, 'demo-on-mainnet');

  const onTestnet = evaluateAndGrant({ project: testnetProject, userId: 'idu-2', policyId: 'age18', vcPayload: payload, jwt });
  assert.equal(onTestnet.ok, true);
  assert.equal(getEntitlement.get('idu-2', 'proj-test', 'age18').issuer_did, issuerRow.did);
});

test('Policy-Engine: policyCheck meldet fehlende Entitlements und requiredPolicyIds spiegelt age_policy', () => {
  assert.deepEqual(requiredPolicyIds({ age_policy: 18 }), ['age18']);
  assert.deepEqual(requiredPolicyIds({ age_policy: 16 }), ['age16']);
  assert.deepEqual(requiredPolicyIds({ age_policy: 0 }), []);

  const project = { id: 'proj-check', network: 'testnet', age_policy: 18 };
  const check1 = policyCheck(project, 'no-entitlement-user');
  assert.equal(check1.ok, false);
  assert.deepEqual(check1.missing, ['age18']);
});

test('Policy-Engine: falsches Prädikat (ageOver18=false) wird abgelehnt', async () => {
  insertUser.run('idu-3', 'idtester3', 'idtester3', now(), 0);
  createWalletForUser('idu-3');
  const subjectDid = getUserDid('idu-3');
  const issuerRow = (await import('../server/db.js')).getInstanceIssuer.get();
  const kp = Ed25519Keypair.fromSecretKey(decrypt(issuerRow.key_ciphertext).toString('utf8'));
  const jwt = await signCredentialJwt({
    issuerKeypair: kp, issuerDid: issuerRow.did, subjectDid,
    type: 'AgeCredential', claims: { ageOver18: false, ageOver16: true }, expiresAt: nowSec() + 3600, demo: true,
  });
  const { payload } = await verifyCredentialJwt(jwt);
  const project = { id: 'proj-test', network: 'testnet', age_policy: 18 };
  const result = evaluateAndGrant({ project, userId: 'idu-3', policyId: 'age18', vcPayload: payload, jwt });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'predicate-failed');
});

test('Policy-Engine: unbekannter Aussteller (nicht in Trust-Registry) wird abgelehnt', async () => {
  insertUser.run('idu-4', 'idtester4', 'idtester4', now(), 0);
  createWalletForUser('idu-4');
  const subjectDid = getUserDid('idu-4');
  const rogueIssuer = new Ed25519Keypair();
  const rogueDid = didKeyFromPublicKey(rogueIssuer.getPublicKey().toRawBytes());
  const jwt = await signCredentialJwt({
    issuerKeypair: rogueIssuer, issuerDid: rogueDid, subjectDid,
    type: 'AgeCredential', claims: { ageOver18: true }, expiresAt: nowSec() + 3600,
  });
  const { payload } = await verifyCredentialJwt(jwt);
  const project = { id: 'proj-test', network: 'testnet', age_policy: 18 };
  const result = evaluateAndGrant({ project, userId: 'idu-4', policyId: 'age18', vcPayload: payload, jwt });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'untrusted-issuer');
});
