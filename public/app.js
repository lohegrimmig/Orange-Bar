// Orange-Bar App-Logik: Passkey-Auth (+ optionale 2FA), Wallet, Senden mit
// Passkey-Bestätigung, NFTs, Aktivität, Netzwerk-Umschalter, Admin-Gas-Station
// und In-Game-Zahlungsanfragen (?pay=…).
import { passkeySupported, createPasskey, getPasskeyAssertion } from '/webauthn-client.js';

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
const state = { user: null, address: null, network: 'testnet', networks: ['testnet', 'devnet', 'mainnet'] };

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
  if (user.isAdmin) initAdmin();
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

async function sendIota() {
  const msgEl = $('#send-msg');
  setMsg(msgEl, '');
  const to = $('#send-to').value.trim();
  const amountNanos = parseIotaToNanos($('#send-amount').value);
  if (!amountNanos) return setMsg(msgEl, 'Ungültiger Betrag.');
  try {
    const payRequestId = sessionStorage.getItem('ob_pay_request') || undefined;
    const result = await confirmAndSend({ kind: 'iota', to, amountNanos, payRequestId }, msgEl);
    buzz(25);
    setMsg(msgEl, `✅ Gesendet! Digest: ${short(result.digest)}`, true);
    toast('Transaktion bestätigt');
    if (payRequestId) finishPayRequest(result);
    refreshHome();
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? 'Bestätigung abgebrochen.' : err.message);
  }
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

// ---------- Admin: Gas Station ----------
function initAdmin() {
  show($('#admin-panel'), true);
  loadStation();
  loadAdminUsers();
}

async function loadStation() {
  try {
    const st = await api('/api/admin/station');
    $('#station-address').textContent = st.address;
    $('#station-enabled').checked = st.enabled;
    $('#station-amount').value = fmtIota(st.amountNanos).replace(',', '.');
    const box = $('#station-balances');
    box.innerHTML = '';
    for (const [net, bal] of Object.entries(st.balances)) {
      const div = document.createElement('div');
      div.className = 'sb';
      div.innerHTML = `<strong>${bal == null ? '–' : fmtIota(bal)}</strong><span>${net}</span>`;
      box.appendChild(div);
    }
  } catch (err) {
    setMsg($('#station-msg'), err.message);
  }
}

async function saveStation() {
  const amountNanos = parseIotaToNanos($('#station-amount').value);
  if (!amountNanos) return setMsg($('#station-msg'), 'Ungültiger Betrag.');
  try {
    await api('/api/admin/station/config', {
      enabled: $('#station-enabled').checked,
      amountNanos,
    });
    setMsg($('#station-msg'), '✅ Gespeichert.', true);
    toast('Gas Station aktualisiert');
  } catch (err) {
    setMsg($('#station-msg'), err.message);
  }
}

async function loadAdminUsers() {
  const box = $('#admin-users');
  try {
    const { users } = await api('/api/admin/users');
    box.innerHTML = '';
    for (const u of users) {
      const div = document.createElement('div');
      div.className = 'admin-user';
      div.innerHTML = `
        <div class="au-main">
          <div><strong></strong> ${u.is_admin ? '<span class="badge">Admin</span>' : ''}</div>
          <code></code>
        </div>
        <button class="secondary">⛽ Gas</button>`;
      div.querySelector('strong').textContent = u.username;
      div.querySelector('code').textContent = short(u.address || '');
      div.querySelector('button').addEventListener('click', async () => {
        const iota = prompt(`Wieviel IOTA an ${u.username} senden? (Netzwerk: ${state.network})`, '0.1');
        if (!iota) return;
        const amountNanos = parseIotaToNanos(iota);
        if (!amountNanos) return setMsg($('#grant-msg'), 'Ungültiger Betrag.');
        setMsg($('#grant-msg'), 'Sende Gas …', true);
        try {
          const r = await api('/api/admin/grant', { userId: u.id, amountNanos, network: state.network });
          setMsg($('#grant-msg'), `✅ ${iota} IOTA an ${u.username} gesendet (${short(r.digest)}).`, true);
          loadStation();
        } catch (err) {
          setMsg($('#grant-msg'), err.message);
        }
      });
      box.appendChild(div);
    }
  } catch (err) {
    box.innerHTML = `<p class="warn small">${err.message}</p>`;
  }
}

// ---------- In-Game-Zahlungsanfrage (?pay=<id>) ----------
let payOrigin = null;

async function maybeHandlePayRequest() {
  const id = new URLSearchParams(location.search).get('pay');
  if (!id) return;
  try {
    const pr = await api(`/api/pay/request/${encodeURIComponent(id)}`);
    if (pr.status !== 'pending') return;
    sessionStorage.setItem('ob_pay_request', pr.id);
    payOrigin = pr.origin;
    goto('send');
    $('#send-to').value = pr.to;
    $('#send-amount').value = fmtIota(pr.amountNanos).replace(',', '.');
    const banner = $('#pay-banner');
    banner.innerHTML = `🎮 <strong>Zahlungsanfrage</strong> von <code></code>${pr.memo ? ' – „<em></em>“' : ''}<br />
      <span class="muted small">Prüfe Betrag und Adresse, dann bestätige mit deinem Passkey.</span>`;
    banner.querySelector('code').textContent = pr.origin;
    if (pr.memo) banner.querySelector('em').textContent = pr.memo;
    show(banner, true);
  } catch { /* ungültige Anfrage ignorieren */ }
}

function finishPayRequest(result) {
  sessionStorage.removeItem('ob_pay_request');
  show($('#pay-banner'), false);
  if (window.opener && payOrigin && payOrigin !== 'unbekannt') {
    // Ergebnis gezielt nur an die anfragende Spiel-Origin melden.
    window.opener.postMessage(
      { type: 'orange-bar:payment', status: 'confirmed', digest: result.digest },
      payOrigin
    );
    setTimeout(() => window.close(), 1200);
  }
}

// ---------- Navigation ----------
function goto(name) {
  for (const pane of ['home', 'send', 'nfts', 'receive', 'settings']) {
    show($(`#pane-${pane}`), pane === name);
  }
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.goto === name));
  if (name === 'home') refreshHome();
  if (name === 'nfts') loadNfts();
  if (name === 'settings' && state.user?.isAdmin) { loadStation(); loadAdminUsers(); }
  window.scrollTo({ top: 0 });
}

// ---------- Start ----------
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

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
  $('#btn-station-save').addEventListener('click', saveStation);
  $('#btn-add-passkey').addEventListener('click', addPasskey);
  $('#net-pill').addEventListener('click', () => show($('#sheet-network'), true));
  $('#sheet-network-close').addEventListener('click', closeSheet);
  $('#sheet-network').addEventListener('click', (e) => { if (e.target === $('#sheet-network')) closeSheet(); });
  $$('.net-opt').forEach((b) => b.addEventListener('click', () => switchNetwork(b.dataset.net)));

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(state.address || '');
      toast('Adresse kopiert');
      buzz();
    } catch { toast('Kopieren nicht möglich'); }
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
