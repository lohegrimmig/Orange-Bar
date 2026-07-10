// Web-Push für Benachrichtigungen bei eingehenden Zahlungen.
// VAPID-Schlüssel kommen aus ORANGE_VAPID_PUBLIC/PRIVATE oder werden beim
// ersten Start erzeugt und unter data/vapid.json abgelegt.
import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import {
  getPushSubsByUser, deletePushSub, getAllUsersWithPush,
  getBalanceWatch, upsertBalanceWatch, getWalletByUser, getUserById,
} from './db.js';
import { getBalance } from './wallet.js';

const VAPID_FILE = fileURLToPath(new URL('../data/vapid.json', import.meta.url));

function loadVapid() {
  if (process.env.ORANGE_VAPID_PUBLIC && process.env.ORANGE_VAPID_PRIVATE) {
    return { publicKey: process.env.ORANGE_VAPID_PUBLIC, privateKey: process.env.ORANGE_VAPID_PRIVATE };
  }
  if (existsSync(VAPID_FILE)) return JSON.parse(readFileSync(VAPID_FILE, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dirname(VAPID_FILE), { recursive: true });
  writeFileSync(VAPID_FILE, JSON.stringify(keys), { mode: 0o600 });
  console.log('[orange-bar] VAPID-Schlüssel erzeugt: data/vapid.json');
  return keys;
}

const vapid = loadVapid();
webpush.setVapidDetails(
  process.env.ORANGE_VAPID_SUBJECT || 'mailto:admin@orange-bar.local',
  vapid.publicKey, vapid.privateKey
);

export const vapidPublicKey = vapid.publicKey;

/** Schickt eine Benachrichtigung an alle Geräte eines Nutzers. */
export async function pushToUser(userId, payload) {
  const subs = getPushSubsByUser.all(userId);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
    } catch (err) {
      // 404/410 = Abo ist tot → entfernen
      if (err.statusCode === 404 || err.statusCode === 410) deletePushSub.run(s.endpoint);
    }
  }));
}

/**
 * Pollt periodisch die Guthaben aller Nutzer mit Push-Abo (auf ihrem aktuellen
 * Netzwerk) und benachrichtigt bei einem Anstieg = eingegangene Zahlung.
 */
let watching = false;
export function startBalanceWatcher(intervalMs = 30_000) {
  if (watching) return;
  watching = true;
  const tick = async () => {
    try {
      const userIds = getAllUsersWithPush.all().map((r) => r.user_id);
      for (const userId of userIds) {
        const wallet = getWalletByUser.get(userId);
        if (!wallet) continue;
        // Nur das vom Nutzer gewählte Netzwerk beobachten (spart RPC-Last).
        const user = getUserById.get(userId);
        const network = user?.network || config.iotaNetwork;
        let balance;
        try {
          balance = (await getBalance(network, wallet.address)).totalBalance;
        } catch { continue; } // Netzwerk nicht erreichbar
        const prev = getBalanceWatch.get(userId, network);
        upsertBalanceWatch.run(userId, network, balance);
        if (prev && BigInt(balance) > BigInt(prev.last_balance)) {
          const delta = BigInt(balance) - BigInt(prev.last_balance);
          await pushToUser(userId, {
            title: 'Zahlung erhalten 🟠',
            body: `+${formatIota(delta)} IOTA auf ${network}`,
            tag: 'orange-bar-incoming',
          });
        }
      }
    } catch (err) {
      console.warn('[balance-watcher]', err.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
}

function formatIota(nanos) {
  const whole = nanos / 1_000_000_000n;
  const frac = (nanos % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '').slice(0, 4);
  return frac ? `${whole},${frac}` : `${whole}`;
}
