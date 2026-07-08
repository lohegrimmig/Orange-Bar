import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ob-test-'));
process.env.ORANGE_DB_PATH = join(dir, 'test.db');
process.env.ORANGE_MASTER_KEY = '44'.repeat(32);

const { vapidPublicKey } = await import('../server/push.js');
const {
  insertUser, insertPushSub, getPushSubsByUser, deletePushSub, now,
} = await import('../server/db.js');

test('VAPID-Public-Key wird bereitgestellt (Base64URL, ~87 Zeichen)', () => {
  assert.match(vapidPublicKey, /^[A-Za-z0-9_-]{80,90}$/);
});

test('Push-Abo speichern, lesen, per Endpoint entfernen', () => {
  insertUser.run('pu-1', 'pushuser', 'pushuser', now(), 0);
  insertPushSub.run('https://push.example/abc', 'pu-1', 'p256dh-key', 'auth-key', now());
  let subs = getPushSubsByUser.all('pu-1');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].endpoint, 'https://push.example/abc');

  // Upsert: gleicher Endpoint aktualisiert statt zu duplizieren.
  insertPushSub.run('https://push.example/abc', 'pu-1', 'p256dh-neu', 'auth-neu', now());
  subs = getPushSubsByUser.all('pu-1');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].p256dh, 'p256dh-neu');

  deletePushSub.run('https://push.example/abc');
  assert.equal(getPushSubsByUser.all('pu-1').length, 0);
});
