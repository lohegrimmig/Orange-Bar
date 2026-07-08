// Orange-Bar App-Logik: Passkey-Auth (+ optionale 2FA), Wallet, Senden mit
// Passkey-Bestätigung, NFTs, Aktivität, Netzwerk-Umschalter, Admin-Gas-Station
// und In-Game-Zahlungsanfragen (?pay=…).
import { passkeySupported, createPasskey, getPasskeyAssertion } from '/webauthn-client.js';
import { LANGS, detectLang, setLang, getLang, t, applyI18n } from '/i18n.js';
import { getPrfOutput, wrapSeed, unwrapSeed, prfMaybeSupported } from '/prf.js';
import { signIotaTransactionBytes, hexToBytes } from '/iota-sign.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const show = (el, on = true) => el.classList.toggle('hidden', !on);

const NANOS = 1_000_000_000n;

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function fmtIota(nanosStr) {
  const nanos = BigInt(nanosStr);
  const sign = nanos < 0n ? '-' : '';
  const abs = nanos < 0n ? -nanos : nanos;
  const whole = abs / NANOS;
  const frac = (abs % NANOS).toString().padStart(9, '0').replace(/0+$/, '').slice(0, 4);
  return `${sign}${whole}${frac ? ',' + frac : ''}`;
}

function parseIotaToNanos(text) {
  const t = String(text).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,9})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return (BigInt(w) * NANOS + BigInt(f.padEnd(9, '0'))).toString();
}

function setMsg(el, text, ok = false) {
  el.textContent = text || '';
  el.className = el.className.replace(/\b(ok|err)\b/g, '').trim();
  if (text) el.classList.add(ok ? 'ok' : 'err');
}

const short = (a) => (a && a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || '');
const buzz = (ms = 12) => navigator.vibrate?.(ms);

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  show(el, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(el, false), 2600);
}

function renderQr(el, text) {
  try {
    const qr = window.qrcode(0, 'M'); // Version automatisch
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    el.innerHTML = `<code class="wrap small">${text}</code>`;
  }
}

// ---------- Zustand ----------
const state = { user: null, address: null, network: 'testnet', networks: ['testnet', 'devnet', 'mainnet'], selfCustody: false };

// ---------- Auth ----------
async function register() {
  const username = $('#username').value.trim();
  setMsg($('#auth-msg'), '');
  try {
    const { challengeId, options } = await api('/api/auth/register/options', { username });
    const response = await createPasskey(options);
    const result = await api('/api/auth/register/verify', { challengeId, response });
    buzz(20);
    enterWallet(result);
  } catch (err) {
    setMsg($('#auth-msg'), err.name === 'NotAllowedError' ? 'Abgebrochen.' : err.message);
  }
}

async function login() {
  const username = $('#username').value.trim();
  setMsg($('#auth-msg'), '');
  try {
    const { challengeId, options } = await api('/api/auth/login/options', { username });
    const response = await getPasskeyAssertion(options);
    const result = await api('/api/auth/login/verify', { challengeId, response });
    if (result.twoFactorRequired) {
      // Zweiter Schritt: TOTP-Code
      sessionStorage.setItem('ob_2fa_ticket', result.ticket);
      show($('#totp-login'), true);
      $('#totp-login-code').focus();
      return;
    }
    buzz(20);
    enterWallet(result);
  } catch (err) {
    setMsg($('#auth-msg'), err.name === 'NotAllowedError' ? 'Abgebrochen.' : err.message);
  }
}

async function submitLoginTotp() {
  const ticket = sessionStorage.getItem('ob_2fa_ticket');
  try {
    const result = await api('/api/auth/login/2fa', { ticket, code: $('#totp-login-code').value });
    sessionStorage.removeItem('ob_2fa_ticket');
    show($('#totp-login'), false);
    buzz(20);
    enterWallet(result);
  } catch (err) {
    setMsg($('#totp-login-msg'), err.message);
  }
}

async function logout() {
  await api('/api/auth/logout', {});
  location.href = '/';
}

// ---------- Wallet ----------
function enterWallet({ address, user, networks }) {
  state.address = address;
  state.user = user;
  state.network = user.network || 'testnet';
  if (networks) state.networks = networks;

  show($('#view-auth'), false);
  show($('#view-wallet'), true);
  show($('#net-pill'), true);
  $('#address').textContent = short(address);
  $('#receive-address').textContent = address;
  $('#me-name').textContent = user.username;
  renderQr($('#receive-qr'), address);
  applyNetworkUi();
  renderSettings();
  goto('home');
  maybeHandlePayRequest();
}

function applyNetworkUi() {
  document.body.dataset.network = state.network;
  $('#net-label').textContent = state.network;
  $$('#network-choice button').forEach((b) => b.classList.toggle('active', b.dataset.net === state.network));
  $$('.net-opt').forEach((b) => b.classList.toggle('active', b.dataset.net === state.network));
}

async function refreshHome() {
  try {
    const s = await api('/api/wallet/summary');
    $('#balance').classList.remove('skeleton');
    if (s.balance) {
      $('#balance').textContent = `${fmtIota(s.balance.totalBalance)} IOTA`;
      show($('#net-warn'), false);
    } else {
      $('#balance').textContent = '0 IOTA';
      $('#net-warn').textContent = s.networkError || 'Netzwerk nicht erreichbar.';
      show($('#net-warn'), true);
    }
  } catch (err) {
    $('#balance').classList.remove('skeleton');
    $('#net-warn').textContent = err.message;
    show($('#net-warn'), true);
  }
  loadActivity();
}

async function loadActivity() {
  const box = $('#activity');
  try {
    const { items } = await api('/api/wallet/activity');
    if (!items.length) {
      box.innerHTML = '<p class="muted small">Noch keine Transaktionen auf diesem Netzwerk.</p>';
      return;
    }
    box.innerHTML = '';
    for (const it of items) {
      const incoming = it.amountNanos != null && BigInt(it.amountNanos) > 0n;
      const div = document.createElement('div');
      div.className = 'act-item';
      div.innerHTML = `
        <div class="act-ico ${incoming ? 'in' : ''}">${incoming ? '↙' : '↗'}</div>
        <div class="act-main">
          <div>${incoming ? 'Empfangen' : 'Gesendet'}${it.status !== 'success' ? ' · fehlgeschlagen' : ''}</div>
          <div class="act-digest">${it.digest}</div>
        </div>
        <div class="act-amount ${incoming ? 'in' : ''}">
          ${it.amountNanos != null ? `${incoming ? '+' : ''}${fmtIota(it.amountNanos)}` : '–'}
        </div>`;
      box.appendChild(div);
    }
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

// ---------- Netzwerk wechseln ----------
async function switchNetwork(network) {
  if (network === state.network) return closeSheet();
  if (network === 'mainnet' &&
      !confirm('Mainnet verwendet ECHTES IOTA mit echtem Wert.\nWirklich umschalten?')) {
    return closeSheet();
  }
  try {
    await api('/api/wallet/network', { network });
    state.network = network;
    applyNetworkUi();
    closeSheet();
    toast(`Netzwerk: ${network}`);
    buzz();
    $('#balance').classList.add('skeleton');
    refreshHome();
  } catch (err) {
    toast(err.message);
  }
}
const closeSheet = () => show($('#sheet-network'), false);

// ---------- Senden ----------
async function confirmAndSend(prepareBody, msgEl) {
  const { challengeId, options, tx } = await api('/api/wallet/tx/prepare', prepareBody);
  setMsg(msgEl, 'Bitte mit Gesicht/Finger bestätigen …', true);
  const response = await getPasskeyAssertion(options);
  setMsg(msgEl, 'Wird gesendet …', true);
  const result = await api('/api/wallet/tx/confirm', { challengeId, response });
  return { ...result, tx };
}

const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function sendIota() {
  const msgEl = $('#send-msg');
  setMsg(msgEl, '');
  const to = $('#send-to').value.trim();
  const amountNanos = parseIotaToNanos($('#send-amount').value);
  if (!amountNanos) return setMsg(msgEl, 'Ungültiger Betrag.');
  try {
    const payRequestId = sessionStorage.getItem('ob_pay_request') || undefined;
    let result;
    if (state.selfCustody) {
      result = await sendIotaSelfCustody(to, amountNanos, msgEl);
    } else {
      result = await confirmAndSend({ kind: 'iota', to, amountNanos, payRequestId }, msgEl);
      if (payRequestId) finishPayRequest(result);
    }
    buzz(25);
    setMsg(msgEl, `✅ Gesendet! Digest: ${short(result.digest)}`, true);
    toast('Transaktion bestätigt');
    refreshHome();
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? 'Bestätigung abgebrochen.' : err.message);
  }
}

// Self-Custody: Server baut Tx-Bytes, der Client entschlüsselt den Seed per
// Passkey-PRF und signiert LOKAL; nur die Signatur geht zurück an den Server.
async function sendIotaSelfCustody(to, amountNanos, msgEl) {
  setMsg(msgEl, t('sc.building'), true);
  const { txBytesB64 } = await api('/api/wallet/tx/build', { to, amountNanos });
  const { keys } = await api('/api/wallet/custody');
  setMsg(msgEl, t('pay.check'), true);
  const out = await getPrfOutput(keys.map((k) => k.credential_id));
  if (!out) throw new Error(t('sc.noprf'));
  const row = keys.find((k) => k.credential_id === out.credentialId);
  if (!row) throw new Error(t('sc.nokey'));
  const seed = await unwrapSeed(row.wrapped, out.prf);
  const signatureB64 = await signIotaTransactionBytes(b64ToU8(txBytesB64), seed);
  seed.fill(0); // Seed sofort aus dem Speicher wischen
  setMsg(msgEl, t('sc.submitting'), true);
  return api('/api/wallet/tx/submit', { txBytesB64, signatureB64 });
}

// ---------- NFTs ----------
let selectedNft = null;

async function loadNfts() {
  const list = $('#nft-list');
  list.innerHTML = '<p class="muted small">Lade NFTs …</p>';
  try {
    const { objects } = await api('/api/wallet/nfts');
    if (!objects.length) {
      list.innerHTML = '<p class="muted small">Noch keine NFTs. Lass dir welche an deine Empfangsadresse senden!</p>';
      return;
    }
    list.innerHTML = '';
    for (const o of objects) {
      const div = document.createElement('button');
      div.className = 'nft';
      const name = o.display?.name || o.type?.split('::').pop() || 'Objekt';
      const img = o.display?.image_url;
      div.innerHTML = `${img ? `<img src="${img}" alt="" loading="lazy" />` : '<div class="nft-ph">🖼️</div>'}
        <div class="nft-name"></div><div class="nft-id muted"></div>`;
      div.querySelector('.nft-name').textContent = name;
      div.querySelector('.nft-id').textContent = short(o.objectId);
      div.addEventListener('click', () => {
        selectedNft = o;
        $$('.nft').forEach((n) => n.classList.remove('sel'));
        div.classList.add('sel');
        show($('#nft-send-form'), true);
        buzz();
      });
      list.appendChild(div);
    }
  } catch (err) {
    list.innerHTML = `<p class="warn">${err.message}</p>`;
  }
}

async function sendNft() {
  const msgEl = $('#nft-msg');
  setMsg(msgEl, '');
  if (!selectedNft) return setMsg(msgEl, 'Bitte zuerst ein NFT auswählen.');
  const to = $('#nft-to').value.trim();
  try {
    const result = await confirmAndSend({ kind: 'nft', to, objectId: selectedNft.objectId }, msgEl);
    buzz(25);
    setMsg(msgEl, `✅ NFT gesendet! Digest: ${short(result.digest)}`, true);
    selectedNft = null;
    show($('#nft-send-form'), false);
    loadNfts();
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? 'Bestätigung abgebrochen.' : err.message);
  }
}

// ---------- 2FA (Einstellungen) ----------
function renderSettings() {
  const seg = $('#network-choice');
  seg.innerHTML = '';
  for (const net of state.networks) {
    const b = document.createElement('button');
    b.dataset.net = net;
    b.innerHTML = `<span class="net-dot ${net}"></span>${net}`;
    b.addEventListener('click', () => switchNetwork(net));
    seg.appendChild(b);
  }
  $('#totp-toggle').checked = !!state.user.totpEnabled;
  applyNetworkUi();
  loadCredentials();
  refreshPushToggle();
  refreshSelfCustody();
}

// ---------- Self-Custody (WebAuthn-PRF) ----------
async function refreshSelfCustody() {
  const toggle = $('#sc-toggle');
  try {
    const c = await api('/api/wallet/custody');
    state.selfCustody = c.selfCustody;
    state.credentials = c.credentials || [];
    toggle.checked = c.selfCustody;
    toggle.disabled = c.selfCustody; // aktiv = einseitig, nicht zurückschaltbar
    show($('#sc-info'), c.selfCustody);
    show($('#sc-seed-box'), false);
  } catch { /* egal */ }
}

async function onSelfCustodyToggle() {
  const toggle = $('#sc-toggle');
  setMsg($('#sc-msg'), '');
  if (!toggle.checked) return;
  if (!prfMaybeSupported()) {
    toggle.checked = false;
    return setMsg($('#sc-msg'), t('sc.noprf'));
  }
  if (!confirm(t('sc.confirm'))) { toggle.checked = false; return; }
  try {
    // 1) Seed per Passkey-Bestätigung exportieren (nur solange custodial).
    setMsg($('#sc-msg'), t('sc.exporting'), true);
    const { challengeId, options } = await api('/api/wallet/custody/export/options', {});
    const assertion = await getPasskeyAssertion(options);
    const { seedHex } = await api('/api/wallet/custody/export/verify', { challengeId, response: assertion });

    // 2) PRF-Geheimnis vom Passkey holen und Seed damit verschlüsseln.
    setMsg($('#sc-msg'), t('sc.wrapping'), true);
    const out = await getPrfOutput(state.credentials?.map((c) => c.id) || []);
    if (!out) { toggle.checked = false; return setMsg($('#sc-msg'), t('sc.noprf')); }
    const seed = hexToBytes(seedHex);
    const wrapped = await wrapSeed(seed, out.prf);

    // 3) Aktivieren: Server löscht seinen Schlüssel.
    await api('/api/wallet/custody/enable', { credentialId: out.credentialId, wrapped });
    seed.fill(0);
    state.selfCustody = true;
    toggle.disabled = true;
    show($('#sc-info'), true);
    // Backup-Seed einmalig anzeigen.
    $('#sc-seed').textContent = seedHex;
    show($('#sc-seed-box'), true);
    setMsg($('#sc-msg'), '✅ ' + t('sc.enabled'), true);
    toast(t('sc.enabled'));
    buzz(25);
  } catch (err) {
    toggle.checked = false;
    setMsg($('#sc-msg'), err.name === 'NotAllowedError' ? t('pay.reject') : err.message);
  }
}

// ---------- Push-Benachrichtigungen ----------
const urlBase64ToUint8Array = (base64) => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function refreshPushToggle() {
  const toggle = $('#push-toggle');
  if (!pushSupported()) {
    toggle.disabled = true;
    setMsg($('#push-msg'), 'Dieses Gerät unterstützt keine Push-Benachrichtigungen.');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    toggle.checked = !!sub;
  } catch { /* egal */ }
}

async function onPushToggle() {
  const toggle = $('#push-toggle');
  setMsg($('#push-msg'), '');
  try {
    const reg = await navigator.serviceWorker.ready;
    if (toggle.checked) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toggle.checked = false;
        return setMsg($('#push-msg'), 'Benachrichtigungen wurden nicht erlaubt.');
      }
      const { publicKey } = await api('/api/push/vapid');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api('/api/push/subscribe', { subscription: sub });
      setMsg($('#push-msg'), '✅ Benachrichtigungen aktiv.', true);
      buzz(15);
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setMsg($('#push-msg'), 'Benachrichtigungen deaktiviert.', true);
    }
  } catch (err) {
    toggle.checked = !toggle.checked;
    setMsg($('#push-msg'), err.message);
  }
}

// ---------- Passkeys / Geräte ----------
async function loadCredentials() {
  const box = $('#cred-list');
  try {
    const { credentials } = await api('/api/auth/credentials');
    box.innerHTML = '';
    for (const c of credentials) {
      const div = document.createElement('div');
      div.className = 'cred-item';
      const date = new Date(c.createdAt * 1000).toLocaleDateString('de-DE');
      div.innerHTML = `
        <div class="cred-ico">${c.backedUp ? '☁️' : '📱'}</div>
        <div class="cred-main">
          <div class="cred-label"></div>
          <div class="muted small">${c.backedUp ? 'Synchronisiert · ' : ''}seit ${date}</div>
        </div>
        <button class="cred-del ghost small" title="Entfernen">✕</button>`;
      div.querySelector('.cred-label').textContent = c.label;
      div.querySelector('.cred-del').addEventListener('click', () => removeCredential(c));
      box.appendChild(div);
    }
    if (!credentials.length) box.innerHTML = '<p class="muted small">Keine Passkeys.</p>';
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

async function addPasskey() {
  setMsg($('#cred-msg'), '');
  const label = prompt('Name für dieses Gerät (optional):', '') || undefined;
  try {
    const { challengeId, options } = await api('/api/auth/credentials/add/options', { label });
    const response = await createPasskey(options);
    await api('/api/auth/credentials/add/verify', { challengeId, response });
    buzz(20);
    toast('Gerät hinzugefügt');
    loadCredentials();
  } catch (err) {
    if (err.name === 'NotAllowedError') return setMsg($('#cred-msg'), 'Abgebrochen.');
    setMsg($('#cred-msg'), err.message);
  }
}

async function removeCredential(cred) {
  if (!confirm(`Passkey „${cred.label}" wirklich entfernen?`)) return;
  try {
    await api(`/api/auth/credentials/${encodeURIComponent(cred.id)}`, undefined, 'DELETE');
    toast('Gerät entfernt');
    loadCredentials();
  } catch (err) {
    setMsg($('#cred-msg'), err.message);
  }
}

async function onTotpToggle() {
  const checked = $('#totp-toggle').checked;
  setMsg($('#totp-msg'), '');
  if (checked && !state.user.totpEnabled) {
    // Einrichtung starten
    try {
      const { setupId, secret, otpauth } = await api('/api/2fa/setup', {});
      sessionStorage.setItem('ob_totp_setup', setupId);
      $('#totp-secret').textContent = secret;
      renderQr($('#totp-qr'), otpauth);
      show($('#totp-setup'), true);
      show($('#totp-disable'), false);
    } catch (err) {
      $('#totp-toggle').checked = false;
      setMsg($('#totp-msg'), err.message);
    }
  } else if (!checked && state.user.totpEnabled) {
    // Deaktivierung anbieten (Code nötig) – Haken bleibt bis dahin gesetzt
    $('#totp-toggle').checked = true;
    show($('#totp-disable'), true);
    show($('#totp-setup'), false);
    $('#totp-disable-code').focus();
  } else {
    show($('#totp-setup'), false);
    show($('#totp-disable'), false);
  }
}

async function enableTotp() {
  try {
    await api('/api/2fa/enable', {
      setupId: sessionStorage.getItem('ob_totp_setup'),
      code: $('#totp-code').value,
    });
    sessionStorage.removeItem('ob_totp_setup');
    state.user.totpEnabled = true;
    show($('#totp-setup'), false);
    $('#totp-code').value = '';
    setMsg($('#totp-msg'), '✅ 2FA ist jetzt aktiv.', true);
    toast('2FA aktiviert');
    buzz(20);
  } catch (err) {
    setMsg($('#totp-msg'), err.message);
  }
}

async function disableTotp() {
  try {
    await api('/api/2fa/disable', { code: $('#totp-disable-code').value });
    state.user.totpEnabled = false;
    $('#totp-toggle').checked = false;
    show($('#totp-disable'), false);
    $('#totp-disable-code').value = '';
    setMsg($('#totp-msg'), '2FA wurde deaktiviert.', true);
  } catch (err) {
    setMsg($('#totp-msg'), err.message);
  }
}

// ---------- Barkeeper: eigene Projekte & Gas Station ----------
function fillNetworkSelect(sel) {
  sel.innerHTML = '';
  for (const net of state.networks) {
    const o = document.createElement('option');
    o.value = net; o.textContent = net;
    sel.appendChild(o);
  }
}

async function loadProjects() {
  const box = $('#project-list');
  fillNetworkSelect($('#np-network'));
  try {
    const { projects } = await api('/api/projects');
    box.innerHTML = '';
    if (!projects.length) {
      box.innerHTML = `<p class="muted small" data-i18n="bk.none">Noch kein Projekt. Erstelle eines, um Barkeeper zu werden.</p>`;
    }
    for (const p of projects) box.appendChild(renderProject(p));
    applyI18n(box);
  } catch (err) {
    box.innerHTML = `<p class="warn small">${err.message}</p>`;
  }
}

function renderProject(p) {
  const el = document.createElement('div');
  el.className = 'project';
  el.innerHTML = `
    <div class="project-head">
      <strong class="p-name"></strong>
      <span class="net-dot ${p.network}"></span><span class="small muted p-net"></span>
    </div>
    <div class="p-row"><span class="muted small" data-i18n="bk.id">Projekt-ID</span>
      <code class="p-id"></code></div>
    <div class="p-row"><span class="muted small" data-i18n="bk.station">Station-Adresse</span>
      <code class="p-station" title="Zum Aufladen hierhin IOTA senden"></code></div>
    <div class="p-row"><span class="muted small" data-i18n="bk.balance">Station-Guthaben</span>
      <strong class="p-balance"></strong></div>
    <div class="field"><label data-i18n="bk.gasper">Gas pro Bezug (IOTA)</label>
      <input class="p-gas" type="text" inputmode="decimal" /></div>
    <div class="field"><label data-i18n="bk.maxper">Max. Bezüge pro Nutzer</label>
      <input class="p-max" type="number" min="0" max="1000" step="1" /></div>
    <div class="field"><label data-i18n="bk.origins">Erlaubte Herkünfte (eine pro Zeile, leer = alle)</label>
      <textarea class="p-origins" rows="2"></textarea></div>
    <label class="toggle-row"><div><strong data-i18n="bk.enabled">Aktiv</strong></div>
      <input type="checkbox" class="switch p-enabled" /></label>
    <div class="btn-row">
      <button class="primary p-save" data-i18n="bk.save">Speichern</button>
      <button class="secondary p-log" data-i18n="bk.log">Protokoll</button>
      <button class="danger p-del" data-i18n="bk.delete">Löschen</button>
    </div>
    <div class="p-grants small muted"></div>
    <p class="msg p-msg" role="status"></p>`;

  el.querySelector('.p-name').textContent = p.name;
  el.querySelector('.p-net').textContent = p.network;
  el.querySelector('.p-id').textContent = p.id;
  el.querySelector('.p-station').textContent = p.stationAddress;
  el.querySelector('.p-balance').textContent =
    p.stationBalance == null ? '—' : `${fmtIota(p.stationBalance)} IOTA`;
  el.querySelector('.p-gas').value = fmtIota(p.gasPerGrant).replace(',', '.');
  el.querySelector('.p-max').value = p.maxGrantsPerUser;
  el.querySelector('.p-origins').value = (p.allowedOrigins || []).join('\n');
  el.querySelector('.p-enabled').checked = p.enabled;

  const pmsg = el.querySelector('.p-msg');
  el.querySelector('.p-station').addEventListener('click', () => {
    navigator.clipboard?.writeText(p.stationAddress); toast(t('copied'));
  });
  el.querySelector('.p-save').addEventListener('click', async () => {
    const gasPerGrant = parseIotaToNanos(el.querySelector('.p-gas').value);
    if (!gasPerGrant) return setMsg(pmsg, t('bk.badgas'));
    try {
      await api(`/api/projects/${encodeURIComponent(p.id)}`, {
        gasPerGrant,
        maxGrantsPerUser: Number(el.querySelector('.p-max').value),
        allowedOrigins: el.querySelector('.p-origins').value.split('\n').map((s) => s.trim()).filter(Boolean),
        enabled: el.querySelector('.p-enabled').checked,
        network: p.network,
      }, 'PATCH');
      setMsg(pmsg, '✅ ' + t('saved'), true);
      toast(t('saved'));
    } catch (err) { setMsg(pmsg, err.message); }
  });
  el.querySelector('.p-log').addEventListener('click', async () => {
    const box = el.querySelector('.p-grants');
    try {
      const { grants } = await api(`/api/projects/${encodeURIComponent(p.id)}/grants`);
      box.innerHTML = grants.length
        ? grants.map((g) => `${g.username}: ${fmtIota(g.amount)} · ${g.status}`).join('<br>')
        : t('bk.nolog');
    } catch (err) { box.textContent = err.message; }
  });
  el.querySelector('.p-del').addEventListener('click', async () => {
    if (!confirm(t('bk.delconfirm'))) return;
    try { await api(`/api/projects/${encodeURIComponent(p.id)}`, undefined, 'DELETE'); loadProjects(); }
    catch (err) { setMsg(pmsg, err.message); }
  });
  return el;
}

async function createProject() {
  setMsg($('#project-msg'), '');
  const name = $('#np-name').value.trim();
  try {
    const r = await api('/api/projects', {
      name,
      network: $('#np-network').value,
      allowedOrigins: $('#np-origins').value.split('\n').map((s) => s.trim()).filter(Boolean),
    });
    // Secret nur EINMAL anzeigen.
    show($('#new-project-form'), false);
    $('#np-name').value = '';
    alert(`${t('bk.secretonce')}\n\nProject-ID: ${r.project.id}\nSecret: ${r.secret}`);
    buzz(20);
    loadProjects();
  } catch (err) {
    setMsg($('#project-msg'), err.message);
  }
}

// ---------- In-Game-Zahlungsanfrage (?pay=<id>[&return=<url>]) ----------
let payOrigin = null;
let payReturnUrl = null;
let payRequestId = null;

async function maybeHandlePayRequest() {
  const params = new URLSearchParams(location.search);
  const id = params.get('pay');
  if (!id) return;
  payReturnUrl = params.get('return'); // Redirect-Modus
  try {
    const pr = await api(`/api/pay/request/${encodeURIComponent(id)}`);
    if (pr.status !== 'pending') {
      if (payReturnUrl) redirectBack(id, pr.status);
      return;
    }
    sessionStorage.setItem('ob_pay_request', pr.id);
    payOrigin = pr.origin;
    payRequestId = pr.id;
    goto('send');
    $('#send-to').value = pr.to;
    $('#send-amount').value = fmtIota(pr.amountNanos).replace(',', '.');
    const banner = $('#pay-banner');
    banner.innerHTML = `🎮 <strong>${t('pay.request')}</strong> · <code></code>${pr.memo ? ' – „<em></em>“' : ''}<br />
      <span class="muted small">${t('pay.check')}</span>
      ${pr.projectId ? `<button id="btn-claim-gas" class="secondary" style="margin-top:10px">⛽ ${t('pay.getgas')}</button>` : ''}
      <button id="btn-pay-reject" class="secondary" style="margin-top:10px">${t('pay.reject')}</button>`;
    banner.querySelector('code').textContent = pr.origin;
    if (pr.memo) banner.querySelector('em').textContent = pr.memo;
    banner.querySelector('#btn-pay-reject').addEventListener('click', rejectPayRequest);
    if (pr.projectId) {
      banner.querySelector('#btn-claim-gas').addEventListener('click', () => claimGas(pr.id));
      // Ohne Guthaben automatisch einmal Gas anbieten (still, Fehler ignorieren).
      maybeAutoClaimGas(pr.id);
    }
    show(banner, true);
  } catch { /* ungültige Anfrage ignorieren */ }
}

// Gas aus der Projekt-Station beziehen (durch den Barkeeper gesponsert).
async function claimGas(payReqId) {
  setMsg($('#send-msg'), t('pay.gasclaiming'), true);
  try {
    const r = await api('/api/projects/claim-gas', { payRequestId: payReqId });
    setMsg($('#send-msg'), `✅ ${t('pay.gasok')} (${short(r.digest)})`, true);
    toast(t('pay.gasok'));
    buzz(15);
    refreshHome();
  } catch (err) {
    setMsg($('#send-msg'), err.message);
  }
}

async function maybeAutoClaimGas(payReqId) {
  try {
    const s = await api('/api/wallet/summary');
    if (s.balance && BigInt(s.balance.totalBalance) > 0n) return; // schon Gas vorhanden
    await api('/api/projects/claim-gas', { payRequestId: payReqId });
    toast('⛽ ' + t('pay.gasok'));
    refreshHome();
  } catch { /* Limit erreicht o. Ä. – der Button bleibt für manuelle Versuche */ }
}

async function rejectPayRequest() {
  if (!payRequestId) return;
  try { await api(`/api/pay/request/${encodeURIComponent(payRequestId)}/reject`, {}); } catch { /* egal */ }
  sessionStorage.removeItem('ob_pay_request');
  show($('#pay-banner'), false);
  notifyGame('rejected');
}

function finishPayRequest(result) {
  sessionStorage.removeItem('ob_pay_request');
  show($('#pay-banner'), false);
  notifyGame('confirmed', result.digest);
}

// Ergebnis ans Spiel melden: per postMessage (Popup) oder Redirect zurück.
function notifyGame(status, digest) {
  if (window.opener && payOrigin && payOrigin !== 'unbekannt') {
    window.opener.postMessage({ type: 'orange-bar:payment', status, digest }, payOrigin);
    setTimeout(() => window.close(), 1200);
  } else if (payReturnUrl) {
    redirectBack(payRequestId, status);
  }
}

function redirectBack(id, status) {
  try {
    const url = new URL(payReturnUrl, location.origin);
    // Nur http(s)-Rückleitungen zulassen (kein javascript:/data: o. Ä.).
    if (!/^https?:$/.test(url.protocol)) return;
    url.searchParams.set('ob_pay', id);
    url.searchParams.set('ob_status', status);
    location.href = url.toString();
  } catch { /* ungültige return-URL ignorieren */ }
}

// ---------- Navigation ----------
function goto(name) {
  for (const pane of ['home', 'send', 'nfts', 'receive', 'settings']) {
    show($(`#pane-${pane}`), pane === name);
  }
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.goto === name));
  if (name === 'home') refreshHome();
  if (name === 'nfts') loadNfts();
  if (name === 'settings') loadProjects();
  window.scrollTo({ top: 0 });
}

// ---------- Start ----------
function initLanguage() {
  setLang(detectLang());
  const sel = $('#lang-select');
  sel.innerHTML = '';
  for (const l of LANGS) {
    const o = document.createElement('option');
    o.value = l.code; o.textContent = l.name;
    sel.appendChild(o);
  }
  sel.value = getLang();
  sel.addEventListener('change', () => {
    setLang(sel.value);
    // Dynamisch gerenderte Bereiche neu aufbauen.
    if (state.user) { renderSettings(); }
  });
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  initLanguage();

  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => { buzz(); goto(b.dataset.goto); }));
  $('#btn-register').addEventListener('click', register);
  $('#btn-login').addEventListener('click', login);
  $('#btn-totp-login').addEventListener('click', submitLoginTotp);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-send').addEventListener('click', sendIota);
  $('#btn-nft-send').addEventListener('click', sendNft);
  $('#totp-toggle').addEventListener('change', onTotpToggle);
  $('#btn-totp-enable').addEventListener('click', enableTotp);
  $('#btn-totp-disable').addEventListener('click', disableTotp);
  $('#btn-new-project').addEventListener('click', () => {
    fillNetworkSelect($('#np-network'));
    show($('#new-project-form'), !$('#new-project-form').classList.contains('hidden') ? false : true);
  });
  $('#btn-create-project').addEventListener('click', createProject);
  $('#btn-add-passkey').addEventListener('click', addPasskey);
  $('#push-toggle').addEventListener('change', onPushToggle);
  $('#sc-toggle').addEventListener('change', onSelfCustodyToggle);
  $('#net-pill').addEventListener('click', () => show($('#sheet-network'), true));
  $('#sheet-network-close').addEventListener('click', closeSheet);
  $('#sheet-network').addEventListener('click', (e) => { if (e.target === $('#sheet-network')) closeSheet(); });
  $$('.net-opt').forEach((b) => b.addEventListener('click', () => switchNetwork(b.dataset.net)));

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(state.address || '');
      toast(t('copied'));
      buzz();
    } catch { toast('—'); }
  };
  $('#addr-chip').addEventListener('click', copyAddress);
  $('#btn-copy').addEventListener('click', copyAddress);
  $('#btn-share').addEventListener('click', async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Meine Orange-Bar-Adresse', text: state.address }); } catch { /* abgebrochen */ }
    } else copyAddress();
  });

  if (!passkeySupported()) show($('#no-passkey'), true);

  try {
    const me = await api('/api/auth/me');
    if (me.user) return enterWallet(me);
  } catch { /* nicht angemeldet */ }
  show($('#view-auth'), true);
}

init();
