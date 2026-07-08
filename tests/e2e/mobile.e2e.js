// End-to-End-Tests auf emulierten Mobilgeräten (iPhone & Android) mit
// virtuellem Passkey-Authenticator (CDP WebAuthn, User-Verification an –
// entspricht Face ID / Fingerabdruck).
//
// Aufruf:  npm run test:e2e
// Optional: CHROMIUM_PATH=/pfad/zu/chrome  SCREENSHOT_DIR=./shots
//
// Hinweis: Die Emulation nutzt Chromium mit iPhone-/Android-Viewport & -UserAgent.
// Echte Safari-/WebKit-Läufe brauchen einen Mac oder ein installiertes
// Playwright-WebKit ("npx playwright install webkit").
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { totpCode } from '../../server/totp.js';

// ---------- Konfiguration ----------
const PORT = 18787 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SCREENSHOT_DIR || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const DEVICES = {
  iphone: {
    name: 'iPhone 14 Pro (emuliert)',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  android: {
    name: 'Pixel 7 (emuliert)',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.6,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  },
};

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const glob = execSync('ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1')
      .toString().trim();
    if (glob) return glob;
  } catch { /* weiter */ }
  throw new Error('Chromium nicht gefunden – CHROMIUM_PATH setzen.');
}

// ---------- Mini-Testrunner ----------
let passed = 0, failed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✔ ${name}`);
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ✘ ${name}: ${err.message}`);
    console.error(`  ✘ ${name}\n    → ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- Server starten ----------
const dataDir = mkdtempSync(join(tmpdir(), 'ob-e2e-'));
const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    ORANGE_DB_PATH: join(dataDir, 'e2e.db'),
    ORANGE_MASTER_KEY: 'ab'.repeat(32),
    ORANGE_ORIGINS: BASE,
    ORANGE_RP_ID: 'localhost',
    ORANGE_DISABLE_WATCHER: '1', // Balance-Watcher im Test aus (kein Netz)
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

await new Promise((resolve, reject) => {
  const t0 = Date.now();
  (async function poll() {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return resolve();
    } catch { /* noch nicht bereit */ }
    if (Date.now() - t0 > 15000) return reject(new Error('Server startet nicht.'));
    setTimeout(poll, 250);
  })();
});
console.log(`Server läuft auf ${BASE}\n`);

// ---------- Browser-Hilfen ----------
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });

async function newDevice(device) {
  const context = await browser.newContext({ ...device, baseURL: BASE });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return { context, page, cdp };
}

const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }) : null);

async function registerUser(page, username) {
  await page.goto('/');
  await page.waitForSelector('#view-auth:not(.hidden)');
  await page.fill('#username', username);
  await page.click('#btn-register');
  await page.waitForSelector('#view-wallet:not(.hidden)', { timeout: 15000 });
}

// =========================================================================
console.log(`— ${DEVICES.iphone.name} —`);
const ios = await newDevice(DEVICES.iphone);
{
  const { page } = ios;

  await check('Onboarding rendert (Hero, Features, Passkey-Button)', async () => {
    await page.goto('/');
    await page.waitForSelector('#view-auth:not(.hidden)');
    assert(await page.isVisible('.hero-logo'), 'Hero-Logo fehlt');
    assert((await page.$$('.feature')).length === 3, 'Feature-Karten fehlen');
    await shot(page, 'iphone-01-onboarding');
  });

  await check('Kein horizontales Scrollen auf iPhone-Viewport', async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    assert(overflow <= 0, `Seite ${overflow}px zu breit`);
  });

  await check('PWA: Manifest, Icons, iOS-Meta-Tags, Service Worker', async () => {
    const m = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
    assert(m.display === 'standalone', 'display muss standalone sein');
    assert(m.icons.length >= 3, 'Icons fehlen im Manifest');
    for (const meta of ['apple-mobile-web-app-capable', 'apple-mobile-web-app-title']) {
      assert(await page.$(`meta[name="${meta}"]`), `${meta} fehlt`);
    }
    assert(await page.$('link[rel="apple-touch-icon"]'), 'apple-touch-icon fehlt');
    assert((await fetch(`${BASE}/icons/icon-180.png`)).ok, 'icon-180.png fehlt');
    assert((await fetch(`${BASE}/sw.js`)).ok, 'Service Worker fehlt');
    const viewport = await page.getAttribute('meta[name="viewport"]', 'content');
    assert(viewport.includes('viewport-fit=cover'), 'viewport-fit=cover fehlt (iPhone-Notch)');
  });

  await check('Registrierung mit Passkey (Face-ID-Äquivalent) → Wallet', async () => {
    await registerUser(page, 'admin-ios');
    const addr = await page.textContent('#receive-address');
    assert(/^0x[0-9a-f]{64}$/.test(addr), `ungültige Adresse: ${addr}`);
    await shot(page, 'iphone-02-wallet-home');
  });

  await check('Erster Nutzer ist Admin und sieht die Gas Station', async () => {
    await page.click('.nav-btn[data-goto="settings"]');
    await page.waitForSelector('#pane-settings:not(.hidden)');
    assert(await page.isVisible('#admin-panel'), 'Admin-Panel fehlt');
    await page.waitForFunction(() => /^0x[0-9a-f]{64}$/.test(
      document.querySelector('#station-address')?.textContent || ''));
    await shot(page, 'iphone-03-admin-station');
  });

  await check('Gas Station: Auto-Funding aktivieren & Betrag speichern', async () => {
    await page.check('#station-enabled');
    await page.fill('#station-amount', '0.05');
    await page.click('#btn-station-save');
    await page.waitForFunction(() =>
      document.querySelector('#station-msg')?.textContent.includes('Gespeichert'));
  });

  await check('Netzwerk-Umschalter: testnet → devnet → mainnet (mit Warnung)', async () => {
    await page.click('#net-pill');
    await page.waitForSelector('#sheet-network:not(.hidden)');
    await shot(page, 'iphone-04-network-sheet');
    await page.click('.net-opt[data-net="devnet"]');
    await page.waitForFunction(() => document.querySelector('#net-label').textContent === 'devnet');

    let dialogText = '';
    page.once('dialog', (d) => { dialogText = d.message(); d.accept(); });
    await page.click('#net-pill');
    await page.click('.net-opt[data-net="mainnet"]');
    await page.waitForFunction(() => document.querySelector('#net-label').textContent === 'mainnet');
    assert(/ECHTES IOTA/.test(dialogText), 'Mainnet-Warnung fehlt');

    // zurück auf testnet für die weiteren Tests
    await page.click('#net-pill');
    await page.click('.net-opt[data-net="testnet"]');
    await page.waitForFunction(() => document.querySelector('#net-label').textContent === 'testnet');
  });

  await check('Empfangen: QR-Code der eigenen Adresse wird gerendert', async () => {
    await page.click('.nav-btn[data-goto="receive"]');
    await page.waitForSelector('#pane-receive:not(.hidden)');
    assert(await page.$('#receive-qr svg'), 'QR-SVG fehlt');
    await shot(page, 'iphone-05-receive-qr');
  });

  await check('Senden: Passkey-Bestätigung läuft bis zur Netzwerk-Ausführung', async () => {
    await page.click('.nav-btn[data-goto="send"]');
    await page.fill('#send-to', '0x' + 'ab'.repeat(32));
    await page.fill('#send-amount', '0.001');
    await page.click('#btn-send');
    await page.waitForFunction(() => {
      const t = document.querySelector('#send-msg')?.textContent || '';
      return t && !t.includes('bestätigen …') && !t.includes('Wird gesendet');
    }, { timeout: 30000 });
    const msg = await page.textContent('#send-msg');
    // Ohne Internet endet der Flow mit Netzwerkfehler NACH erfolgreicher
    // Passkey-Prüfung; mit Internet mit "Gesendet".
    assert(/Gesendet|Transaktion fehlgeschlagen|Guthaben/.test(msg), `Unerwartet: ${msg}`);
  });

  await check('2FA einrichten: QR + Secret, Code aktiviert die Funktion', async () => {
    await page.click('.nav-btn[data-goto="settings"]');
    await page.check('#totp-toggle');
    await page.waitForSelector('#totp-setup:not(.hidden)');
    assert(await page.$('#totp-qr svg'), '2FA-QR fehlt');
    const secret = (await page.textContent('#totp-secret')).trim();
    assert(/^[A-Z2-7]{16,}$/.test(secret), 'Secret unlesbar');
    await shot(page, 'iphone-06-2fa-setup');
    await page.fill('#totp-code', totpCode(secret));
    await page.click('#btn-totp-enable');
    await page.waitForFunction(() =>
      document.querySelector('#totp-msg')?.textContent.includes('aktiv'));
    ios.totpSecret = secret;
  });

  await check('Login verlangt 2FA-Code; falscher Code wird abgelehnt', async () => {
    await page.click('#btn-logout');
    await page.waitForSelector('#view-auth:not(.hidden)');
    await page.fill('#username', 'admin-ios');
    await page.click('#btn-login');
    await page.waitForSelector('#totp-login:not(.hidden)', { timeout: 15000 });
    await shot(page, 'iphone-07-2fa-login');

    await page.fill('#totp-login-code', '000000');
    await page.click('#btn-totp-login');
    await page.waitForFunction(() =>
      document.querySelector('#totp-login-msg')?.textContent.includes('Falscher Code'));

    await page.fill('#totp-login-code', totpCode(ios.totpSecret));
    await page.click('#btn-totp-login');
    await page.waitForSelector('#view-wallet:not(.hidden)', { timeout: 15000 });
  });

  await check('Geräte-Liste zeigt genau einen Passkey nach Registrierung', async () => {
    await page.click('.nav-btn[data-goto="settings"]');
    await page.waitForSelector('#pane-settings:not(.hidden)');
    await page.waitForFunction(() => document.querySelectorAll('#cred-list .cred-item').length === 1);
  });

  await check('Letzten Passkey entfernen wird serverseitig verweigert (400)', async () => {
    const result = await page.evaluate(async () => {
      const list = await (await fetch('/api/auth/credentials')).json();
      const id = list.credentials[0].id;
      const r = await fetch(`/api/auth/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { status: r.status, body: await r.json() };
    });
    assert(result.status === 400, `Erwartet 400, war ${result.status}`);
    assert(/letzte Passkey/i.test(result.body.error), `Falsche Meldung: ${result.body.error}`);
  });

  await check('Zweites Gerät hinzufügen → Liste zeigt zwei Passkeys', async () => {
    // Zweiter virtueller Authenticator = Backup-Gerät/Sicherheitsschlüssel.
    // Chromium erlaubt nur EINEN internen Authenticator, daher 'usb'.
    await ios.cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', transport: 'usb',
        hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      },
    });
    page.once('dialog', (d) => d.accept('iPad')); // Name-Prompt
    await page.click('#btn-add-passkey');
    await page.waitForFunction(() => document.querySelectorAll('#cred-list .cred-item').length === 2,
      { timeout: 15000 });
    await shot(page, 'iphone-09-devices');
  });

  await check('Eines von zwei Geräten entfernen → Liste zeigt wieder eines', async () => {
    page.once('dialog', (d) => d.accept()); // confirm()
    await page.click('#cred-list .cred-item .cred-del');
    await page.waitForFunction(() => document.querySelectorAll('#cred-list .cred-item').length === 1,
      { timeout: 15000 });
  });
}

// =========================================================================
console.log(`\n— ${DEVICES.android.name} —`);
const android = await newDevice(DEVICES.android);
{
  const { page } = android;

  await check('Registrierung zweiter Nutzer auf Android (Fingerprint-Äquivalent)', async () => {
    await registerUser(page, 'spieler-android');
    await shot(page, 'android-01-wallet-home');
  });

  await check('Zweiter Nutzer ist KEIN Admin (kein Gas-Station-Panel)', async () => {
    await page.click('.nav-btn[data-goto="settings"]');
    await page.waitForSelector('#pane-settings:not(.hidden)');
    assert(!(await page.isVisible('#admin-panel')), 'Admin-Panel darf nicht sichtbar sein');
    const r = await page.evaluate(async () => (await fetch('/api/admin/station')).status);
    assert(r === 403, `Admin-API muss 403 liefern, war ${r}`);
  });

  await check('Kein horizontales Scrollen auf Android-Viewport', async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    assert(overflow <= 0, `Seite ${overflow}px zu breit`);
  });

  await check('In-Game-Zahlungsanfrage füllt das Sendeformular (mit Banner)', async () => {
    const pr = await page.evaluate(async (addr) => {
      const r = await fetch('/api/pay/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: addr, amountNanos: '1500000000', memo: 'Schwert des Feuers' }),
      });
      return r.json();
    }, '0x' + 'cd'.repeat(32));
    await page.goto(`/?pay=${pr.id}`);
    await page.waitForSelector('#pay-banner:not(.hidden)');
    assert((await page.inputValue('#send-amount')) === '1.5', 'Betrag nicht vorausgefüllt');
    assert((await page.inputValue('#send-to')).startsWith('0xcd'), 'Adresse nicht vorausgefüllt');
    await shot(page, 'android-02-pay-request');
  });

  await check('Redirect-Modus: Ablehnen leitet mit ob_status zurück zum Spiel', async () => {
    const pr = await page.evaluate(async (addr) => {
      const r = await fetch('/api/pay/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: addr, amountNanos: '500000000', memo: 'Trank' }),
      });
      return r.json();
    }, '0x' + 'ef'.repeat(32));
    const ret = `${BASE}/demo/game.html`;
    await page.goto(`/?pay=${pr.id}&return=${encodeURIComponent(ret)}`);
    await page.waitForSelector('#btn-pay-reject');
    await page.click('#btn-pay-reject');
    // Erwartung: Rückleitung auf die Spielseite mit ob_pay & ob_status=rejected,
    // die checkReturn() dann liest und aus der URL entfernt.
    await page.waitForURL(/\/demo\/game\.html/, { timeout: 10000 });
    await page.waitForFunction(() =>
      document.querySelector('#status')?.textContent.includes('rejected'), { timeout: 10000 });
    const url = page.url();
    assert(!/ob_pay=/.test(url), `checkReturn hat URL nicht bereinigt: ${url}`);
    await shot(page, 'android-03-redirect-return');
  });

  await check('SDK checkReturn() liefert null ohne ob_pay-Parameter', async () => {
    const r = await page.evaluate(async () => {
      const ob = new OrangeBar(location.origin);
      return ob.checkReturn();
    });
    assert(r === null, `Erwartet null, war ${JSON.stringify(r)}`);
  });

  await check('Auto-Gas-Grant wurde für neuen Nutzer protokolliert', async () => {
    // Station war beim Registrieren aktiviert → Grant-Versuch muss geloggt
    // sein (Status success mit Internet, failed ohne – beides ok).
    const grants = await ios.page.evaluate(async () =>
      (await fetch('/api/admin/grants')).json());
    const grant = grants.grants.find((g) => g.username === 'spieler-android' && g.kind === 'auto');
    assert(grant, 'Kein Auto-Grant protokolliert');
  });
}

// =========================================================================
console.log('\n— Admin: manuelles Gas-Funding (iPhone) —');
{
  const { page } = ios;
  await check('Admin sieht neue Nutzer und kann Gas senden (Station-Flow)', async () => {
    await page.click('.nav-btn[data-goto="settings"]');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.admin-user strong')].some((s) => s.textContent === 'spieler-android'));
    page.once('dialog', (d) => d.accept('0.01'));
    const row = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.admin-user')].find((r) =>
        r.querySelector('strong').textContent === 'spieler-android'));
    await (await row.asElement().$('button')).click();
    await page.waitForFunction(() => {
      const t = document.querySelector('#grant-msg')?.textContent || '';
      return t && !t.startsWith('Sende');
    }, { timeout: 30000 });
    const msg = await page.textContent('#grant-msg');
    // Mit Internet & Guthaben: "gesendet", sonst sauberer Fehler der Station.
    assert(/gesendet|fehlgeschlagen/.test(msg), `Unerwartet: ${msg}`);
    await shot(page, 'iphone-08-admin-grant');
  });
}

// =========================================================================
console.log('\n— Härtetests (API) —');
{
  await check('Rate-Limit greift auf Auth-Endpunkten (429)', async () => {
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${BASE}/api/auth/login/options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (r.status === 429) { limited = true; break; }
    }
    assert(limited, 'Kein 429 nach 40 Versuchen');
  });

  await check('Wallet-API ohne Session liefert 401', async () => {
    const r = await fetch(`${BASE}/api/wallet/summary`);
    assert(r.status === 401, `Erwartet 401, war ${r.status}`);
  });

  await check('Ungültige Zieladresse wird abgelehnt (400)', async () => {
    const r = await ios.page.evaluate(async () => (await fetch('/api/wallet/tx/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'iota', to: 'nicht-hex', amountNanos: '1' }),
    })).status);
    assert(r === 400, `Erwartet 400, war ${r}`);
  });

  await check('Push: VAPID-Key öffentlich, subscribe erfordert Session', async () => {
    const vapid = await ios.page.evaluate(async () => (await fetch('/api/push/vapid')).json());
    assert(/^[A-Za-z0-9_-]{80,90}$/.test(vapid.publicKey), 'VAPID-Key fehlt/ungültig');
    // Ohne Session (frischer fetch aus Node) muss subscribe 401 liefern.
    const r = await fetch(`${BASE}/api/push/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert(r.status === 401, `Erwartet 401, war ${r.status}`);
  });

  await check('Push: Toggle in den Einstellungen sichtbar', async () => {
    await ios.page.click('.nav-btn[data-goto="settings"]');
    await ios.page.waitForSelector('#push-toggle');
    assert(await ios.page.$('#push-toggle'), 'Push-Toggle fehlt');
  });
}

// ---------- Abschluss ----------
await browser.close();
server.kill();

console.log(`\n${'='.repeat(52)}\nE2E-Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);
