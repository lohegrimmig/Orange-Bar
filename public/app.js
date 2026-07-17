// Orange-Bar App-Logik: Passkey-Auth (+ optionale 2FA), Wallet, Senden mit
// Passkey-Bestätigung, NFTs, Aktivität, Netzwerk-Umschalter, Admin-Gas-Station
// und In-Game-Zahlungsanfragen (?pay=…).
import { passkeySupported, createPasskey, getPasskeyAssertion } from '/webauthn-client.js';
import { LANGS, detectLang, setLang, getLang, t, applyI18n } from '/i18n.js';
import { getPrfOutput, wrapSeed, unwrapSeed, prfMaybeSupported, deriveSeedFromPrf, probePrfSupport } from '/prf.js';
import { signIotaTransactionBytes, hexToBytes, addressFromSeed, publicKeyFromSeed } from '/iota-sign.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const show = (el, on = true) => el.classList.toggle('hidden', !on);

const NANOS = 1_000_000_000n;

async function api(path, body, method, signal) {
  const res = await fetch(path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
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
const state = {
  user: null, address: null, network: 'testnet', networks: ['testnet', 'devnet', 'mainnet'],
  selfCustody: true, custodialMode: false, version: '',
  prfSupported: null, prfChecking: false,
};

function usesSelfCustodySigning() {
  return state.selfCustody;
}

// Altkonto aus der Custodial-Zeit auf einem Non-Custodial-Server: Der Server
// darf nicht mehr signieren, das Wallet kann aber noch nicht selbst signieren –
// erst die Migration (Self-Custody-Toggle) macht es wieder sendefähig.
function needsCustodyMigration() {
  return !state.custodialMode && !state.selfCustody;
}

function applyModeUi() {
  show($('#custodial-warn'), state.custodialMode);
  show($('#non-custodial-note'), !state.custodialMode);
  show($('#custodial-banner'), state.custodialMode);
  const scRow = $('#sc-toggle')?.closest('.toggle-row');
  if (scRow) show(scRow, state.custodialMode);
  renderPrfStatus();
  updateRegisterForPrf();
}

function updateRegisterForPrf() {
  const btn = $('#btn-register');
  if (!btn) return;
  const block = !state.custodialMode && state.prfSupported === false;
  btn.disabled = block;
  btn.setAttribute('aria-disabled', block ? 'true' : 'false');
}

function renderPrfStatus() {
  const box = $('#prf-status');
  if (!box) return;
  if (state.custodialMode || !passkeySupported()) {
    show(box, false);
    return;
  }
  show(box, true);
  const icon = $('#prf-status-icon');
  const title = $('#prf-status-title');
  const detail = $('#prf-status-detail');
  const alt = $('#prf-status-alt');
  box.classList.remove('prf-status--ok', 'prf-status--no', 'prf-status--unknown', 'prf-status--checking');

  if (state.prfChecking) {
    box.classList.add('prf-status--checking');
    if (icon) icon.textContent = '…';
    if (title) title.textContent = t('prf.checking');
    if (detail) detail.textContent = '';
    if (alt) show(alt, false);
    return;
  }

  if (state.prfSupported === true) {
    box.classList.add('prf-status--ok');
    if (icon) icon.textContent = '✓';
    if (title) title.textContent = t('prf.ok.title');
    if (detail) detail.textContent = t('prf.ok.detail');
    if (alt) show(alt, false);
  } else if (state.prfSupported === false) {
    box.classList.add('prf-status--no');
    if (icon) icon.textContent = '✗';
    if (title) title.textContent = t('prf.no.title');
    if (detail) detail.textContent = t('prf.no.detail');
    if (alt) {
      alt.innerHTML = t('prf.no.alt');
      show(alt, true);
    }
  } else {
    box.classList.add('prf-status--unknown');
    if (icon) icon.textContent = '?';
    if (title) title.textContent = t('prf.unknown.title');
    if (detail) detail.textContent = t('prf.unknown.detail');
    if (alt) {
      alt.innerHTML = t('prf.no.alt');
      show(alt, true);
    }
  }
}

async function refreshPrfStatus() {
  if (state.custodialMode || !passkeySupported()) {
    state.prfSupported = null;
    state.prfChecking = false;
    renderPrfStatus();
    updateRegisterForPrf();
    return;
  }
  state.prfChecking = true;
  renderPrfStatus();
  const result = await probePrfSupport();
  state.prfSupported = result.supported;
  state.prfChecking = false;
  renderPrfStatus();
  updateRegisterForPrf();
}

async function loadAppConfig() {
  try {
    const cfg = await api('/api/config');
    state.custodialMode = !!cfg.custodialMode;
    state.selfCustody = !state.custodialMode;
    state.version = cfg.version || state.version;
    applyModeUi();
  } catch { /* Offline/Startup */ }
}

function renderLegalFooters(legal) {
  const links = legal?.links || {
    impressum: '/legal/impressum',
    privacy: '/legal/datenschutz',
    terms: '/legal/agb',
  };
  const op = legal?.configured && legal.operatorName
    ? `<span class="legal-op">${escHtml(legal.operatorName)}</span> · `
    : '';
  const html = `${op}<a href="${links.impressum}">${t('legal.impressum')}</a> · `
    + `<a href="${links.privacy}">${t('legal.privacy')}</a> · `
    + `<a href="${links.terms}">${t('legal.terms')}</a>`;
  for (const id of ['#legal-footer-auth', '#legal-footer-settings']) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadLegalFooter() {
  try {
    const legal = await api('/api/legal');
    renderLegalFooters(legal);
  } catch {
    renderLegalFooters(null);
  }
}

/** Non-Custodial: Wallet per Passkey-PRF anlegen – Server erhält nie den Klartext-Seed. */
async function setupNonCustodialWallet(credentialIds = []) {
  if (!prfMaybeSupported()) throw new Error(t('sc.noprf'));
  const out = await getPrfOutput(credentialIds);
  if (!out) throw new Error(t('sc.noprf'));
  const seed = await deriveSeedFromPrf(out.prf);
  const address = await addressFromSeed(seed);
  const pub = await publicKeyFromSeed(seed);
  const wrapped = await wrapSeed(seed, out.prf);
  const pubB64 = btoa(String.fromCharCode(...new Uint8Array(pub)));
  const setup = await api('/api/wallet/setup', {
    credentialId: out.credentialId, address, wrapped, publicKeyB64: pubB64,
  });
  seed.fill(0);
  state.selfCustody = true;
  return setup;
}

async function finishAuth(result) {
  if (result.custodialMode != null) state.custodialMode = !!result.custodialMode;
  if (result.needsWalletSetup) {
    setMsg($('#auth-msg'), t('wallet.settingUp'), true);
    const ids = result.credentialId ? [result.credentialId] : [];
    const setup = await setupNonCustodialWallet(ids);
    result.address = setup.address;
  } else if (!result.address) {
    try {
      const s = await api('/api/wallet/summary');
      result.address = s.address;
    } catch { /* noch kein Wallet */ }
  }
  if (!result.address) {
    setMsg($('#auth-msg'), t('wallet.missing'));
    return;
  }
  if (!state.custodialMode) state.selfCustody = true;
  enterWallet(result);
}

// ---------- Auth ----------
async function register() {
  const username = $('#username').value.trim();
  setMsg($('#auth-msg'), '');
  if (!state.custodialMode && state.prfSupported === false) {
    return setMsg($('#auth-msg'), t('prf.blockRegister'));
  }
  if (!state.custodialMode && !prfMaybeSupported()) {
    return setMsg($('#auth-msg'), t('sc.noprf'));
  }
  try {
    const { challengeId, options } = await api('/api/auth/register/options', { username });
    const response = await createPasskey(options);
    const result = await api('/api/auth/register/verify', { challengeId, response });
    buzz(20);
    await finishAuth(result);
  } catch (err) {
    setMsg($('#auth-msg'), err.name === 'NotAllowedError' ? t('common.cancelled') : err.message);
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
    await finishAuth(result);
  } catch (err) {
    setMsg($('#auth-msg'), err.name === 'NotAllowedError' ? t('common.cancelled') : err.message);
  }
}

async function submitLoginTotp() {
  const ticket = sessionStorage.getItem('ob_2fa_ticket');
  try {
    const result = await api('/api/auth/login/2fa', { ticket, code: $('#totp-login-code').value });
    sessionStorage.removeItem('ob_2fa_ticket');
    show($('#totp-login'), false);
    buzz(20);
    await finishAuth(result);
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
  applyModeUi();
  renderSettings();
  goto('home');
  maybeHandlePayRequest();
  maybeShowAppLoginBanner();
  maybeHandleVerifyRequest();
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
      $('#net-warn').textContent = s.networkError || t('common.networkUnreachable');
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
      box.innerHTML = `<p class="muted small">${t('home.noActivity')}</p>`;
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
          <div>${incoming ? t('home.received') : t('home.sent')}${it.status !== 'success' ? t('home.failedSuffix') : ''}</div>
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
      !confirm(t('net.mainnetWarning'))) {
    return closeSheet();
  }
  try {
    await api('/api/wallet/network', { network });
    state.network = network;
    applyNetworkUi();
    closeSheet();
    toast(`${t('set.network')}: ${network}`);
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
  setMsg(msgEl, t('send.confirming'), true);
  const response = await getPasskeyAssertion(options);
  setMsg(msgEl, t('send.sending'), true);
  const result = await api('/api/wallet/tx/confirm', { challengeId, response });
  return { ...result, tx };
}

const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function sendIota() {
  const msgEl = $('#send-msg');
  setMsg(msgEl, '');
  const to = $('#send-to').value.trim();
  const amountNanos = parseIotaToNanos($('#send-amount').value);
  if (!amountNanos) return setMsg(msgEl, t('send.badAmount'));
  if (needsCustodyMigration()) return setMsg(msgEl, t('sc.migrate'));
  try {
    const payRequestId = sessionStorage.getItem('ob_pay_request') || undefined;
    let result;
    if (usesSelfCustodySigning()) {
      result = await signAndSubmitSelfCustody({ to, amountNanos, payRequestId }, msgEl);
      if (payRequestId) finishPayRequest(result);
    } else {
      result = await confirmAndSend({ kind: 'iota', to, amountNanos, payRequestId }, msgEl);
      if (payRequestId) finishPayRequest(result);
    }
    buzz(25);
    setMsg(msgEl, `${t('send.sentDigest')} ${short(result.digest)}`, true);
    toast(t('send.txConfirmed'));
    refreshHome();
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? t('send.confirmCancelled') : err.message);
  }
}

// Self-Custody / Non-Custodial: Server baut Tx-Bytes, Client signiert lokal per Passkey-PRF.
async function signAndSubmitSelfCustody(buildBody, msgEl) {
  setMsg(msgEl, t('sc.building'), true);
  const { txBytesB64 } = await api('/api/wallet/tx/build', buildBody);
  const { keys } = await api('/api/wallet/custody');
  setMsg(msgEl, t('pay.check'), true);
  const out = await getPrfOutput(keys.map((k) => k.credential_id));
  if (!out) throw new Error(t('sc.noprf'));
  const row = keys.find((k) => k.credential_id === out.credentialId);
  if (!row) throw new Error(t('sc.nokey'));
  const seed = await unwrapSeed(row.wrapped, out.prf);
  const signatureB64 = await signIotaTransactionBytes(b64ToU8(txBytesB64), seed);
  seed.fill(0);
  setMsg(msgEl, t('sc.submitting'), true);
  return api('/api/wallet/tx/submit', {
    txBytesB64, signatureB64, payRequestId: buildBody.payRequestId,
  });
}

// ---------- NFTs ----------
let selectedNft = null;

async function loadNfts() {
  const list = $('#nft-list');
  list.innerHTML = '<p class="muted small">Lade NFTs …</p>';
  try {
    const { objects } = await api('/api/wallet/nfts');
    if (!objects.length) {
      list.innerHTML = `<p class="muted small">${t('nft.none')}</p>`;
      return;
    }
    list.innerHTML = '';
    for (const o of objects) {
      const div = document.createElement('button');
      div.className = 'nft';
      const name = o.display?.name || o.type?.split('::').pop() || t('nft.fallbackName');
      const img = o.display?.image_url || o.display?.imageUrl || '';
      const safeImg = /^https?:\/\//i.test(img) ? img : '';
      div.innerHTML = `${safeImg ? `<img src="${safeImg}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="nft-ph">🖼️</div>'}
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
  if (!selectedNft) return setMsg(msgEl, t('nft.pickFirst'));
  if (needsCustodyMigration()) return setMsg(msgEl, t('sc.migrate'));
  const to = $('#nft-to').value.trim();
  try {
    let result;
    if (usesSelfCustodySigning()) {
      result = await signAndSubmitSelfCustody({ to, objectId: selectedNft.objectId }, msgEl);
    } else {
      result = await confirmAndSend({ kind: 'nft', to, objectId: selectedNft.objectId }, msgEl);
    }
    buzz(25);
    setMsg(msgEl, `${t('nft.sentDigest')} ${short(result.digest)}`, true);
    selectedNft = null;
    show($('#nft-send-form'), false);
    loadNfts();
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? t('send.confirmCancelled') : err.message);
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
  const row = toggle?.closest('.toggle-row');
  try {
    // Immer den echten Custody-Status vom Server holen – der Server-Modus sagt
    // nichts über das einzelne Wallet aus (Altkonten aus der Custodial-Zeit
    // haben self_custody=0, auch wenn der Server non-custodial läuft).
    const c = await api('/api/wallet/custody');
    state.selfCustody = c.selfCustody;
    state.custodialMode = !!c.custodialMode;
    state.credentials = c.credentials || [];
  } catch { return; }
  // Toggle: im Custodial-Modus immer sichtbar (Opt-in), im Non-Custodial-Modus
  // nur für Altkonten, die noch auf Self-Custody migrieren müssen.
  if (row) show(row, state.custodialMode || !state.selfCustody);
  if (toggle) {
    toggle.checked = state.selfCustody;
    toggle.disabled = state.selfCustody;
  }
  show($('#sc-info'), state.selfCustody);
  show($('#sc-seed-box'), false);
  if (needsCustodyMigration()) setMsg($('#sc-msg'), t('sc.legacyNote'));
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
    setMsg($('#push-msg'), t('push.unsupported'));
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
        return setMsg($('#push-msg'), t('push.denied'));
      }
      const { publicKey } = await api('/api/push/vapid');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api('/api/push/subscribe', { subscription: sub });
      setMsg($('#push-msg'), t('push.active'), true);
      buzz(15);
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setMsg($('#push-msg'), t('push.disabled'), true);
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
      const date = new Date(c.createdAt * 1000).toLocaleDateString(getLang());
      const label = c.label || (c.backedUp ? t('cred.synced') : t('cred.thisDevice'));
      div.innerHTML = `
        <div class="cred-ico">${c.backedUp ? '☁️' : '📱'}</div>
        <div class="cred-main">
          <div class="cred-label"></div>
          <div class="muted small">${c.backedUp ? t('cred.syncedPrefix') : ''}${t('cred.since')} ${date}</div>
        </div>
        <button class="cred-del ghost small" data-i18n-title="cred.remove" title="${t('cred.remove')}">✕</button>`;
      div.querySelector('.cred-label').textContent = label;
      div.querySelector('.cred-del').addEventListener('click', () => removeCredential({ ...c, label }));
      box.appendChild(div);
    }
    if (!credentials.length) box.innerHTML = `<p class="muted small">${t('cred.none')}</p>`;
  } catch (err) {
    box.innerHTML = `<p class="muted small">${err.message}</p>`;
  }
}

async function addPasskey() {
  setMsg($('#cred-msg'), '');
  const label = prompt(t('cred.namePrompt'), '') || undefined;
  try {
    const { challengeId, options } = await api('/api/auth/credentials/add/options', { label });
    const response = await createPasskey(options);
    await api('/api/auth/credentials/add/verify', { challengeId, response });
    buzz(20);
    toast(t('cred.added'));
    loadCredentials();
  } catch (err) {
    if (err.name === 'NotAllowedError') return setMsg($('#cred-msg'), t('pay.reject'));
    setMsg($('#cred-msg'), err.message);
  }
}

async function removeCredential(cred) {
  if (!confirm(`${t('cred.removeConfirmPre')} „${cred.label}"${t('cred.removeConfirmPost')}`)) return;
  try {
    await api(`/api/auth/credentials/${encodeURIComponent(cred.id)}`, undefined, 'DELETE');
    toast(t('cred.removed'));
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
    setMsg($('#totp-msg'), t('totp.nowActive'), true);
    toast(t('set.2fa'));
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

// Bricht eine noch laufende vorherige loadProjects()-Anfrage ab, damit eine
// spät eintreffende alte Antwort (z. B. wegen der Guthaben-Abfrage je Station)
// nicht eine neuere Ansicht überschreibt oder eine frische Bearbeitung verwirft.
let projectsAbort = null;

async function loadProjects() {
  projectsAbort?.abort();
  const controller = new AbortController();
  projectsAbort = controller;

  const box = $('#project-list');
  fillNetworkSelect($('#np-network'));
  try {
    const { projects } = await api('/api/projects', undefined, undefined, controller.signal);
    if (controller.signal.aborted) return; // durch neueren Aufruf überholt
    box.innerHTML = '';
    if (!projects.length) {
      box.innerHTML = `<p class="muted small" data-i18n="bk.none">Noch kein Projekt. Erstelle eines, um Barkeeper zu werden.</p>`;
    }
    for (const p of projects) box.appendChild(renderProject(p));
    applyI18n(box);
    box.dataset.loadedAt = String(Date.now()); // Signal: Re-Render abgeschlossen (u. a. für Tests)
  } catch (err) {
    if (err.name === 'AbortError') return;
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
    <div class="field"><label data-i18n="bk.agePolicy">Altersbeschränkung <span class="badge">Demo</span></label>
      <select class="select p-age">
        <option value="0" data-i18n="bk.ageOff">Aus</option>
        <option value="16" data-i18n="bk.age16">16+</option>
        <option value="18" data-i18n="bk.age18">18+</option>
      </select>
      <p class="muted small" data-i18n="bk.ageNote">(Demo – in Entwicklung) Prüft aktuell nur den Selbstauskunfts-Nachweis; echte eID-/KYC-Aussteller folgen, sobald verfügbar. Auf Mainnet-Projekten wird der Demo-Nachweis abgelehnt.</p>
    </div>
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
  el.querySelector('.p-balance').textContent = '…';
  // Guthaben separat nachladen statt die ganze Liste darauf warten zu lassen.
  api(`/api/projects/${encodeURIComponent(p.id)}/balance`)
    .then((r) => {
      el.querySelector('.p-balance').textContent = r.balance == null ? '—' : `${fmtIota(r.balance)} IOTA`;
    })
    .catch(() => { el.querySelector('.p-balance').textContent = '—'; });
  el.querySelector('.p-gas').value = fmtIota(p.gasPerGrant).replace(',', '.');
  el.querySelector('.p-max').value = p.maxGrantsPerUser;
  el.querySelector('.p-origins').value = (p.allowedOrigins || []).join('\n');
  el.querySelector('.p-age').value = String(p.agePolicy || 0);
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
        agePolicy: Number(el.querySelector('.p-age').value),
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
  const id = payRequestId || sessionStorage.getItem('ob_pay_request');
  sessionStorage.removeItem('ob_pay_request');
  show($('#pay-banner'), false);
  // Digest = Tx wurde angenommen → Spiel freischalten (außer explizit failure).
  const gameStatus = result.status === 'failure' ? 'failed'
    : (result.digest || result.status === 'success' || result.ok) ? 'confirmed' : 'pending';
  notifyGame(gameStatus, result.digest, id);
}

// Ergebnis ans Spiel melden: per postMessage (Popup) oder Redirect zurück.
function notifyGame(status, digest, id = payRequestId) {
  if (window.opener && payOrigin && payOrigin !== 'unbekannt') {
    window.opener.postMessage({ type: 'orange-bar:payment', status, digest }, payOrigin);
    setTimeout(() => window.close(), 1200);
  } else if (payReturnUrl && id) {
    redirectBack(id, status, digest);
  } else if (id) {
    // Kein Return-Pfad: Status trotzdem in der UI zeigen (Spiel merkt nichts).
    toast(status === 'confirmed' ? t('send.txConfirmed') : status);
  }
}

function redirectBack(id, status, digest) {
  try {
    const url = new URL(payReturnUrl, location.origin);
    // Nur http(s)-Rückleitungen zulassen (kein javascript:/data: o. Ä.).
    if (!/^https?:$/.test(url.protocol)) return;
    url.searchParams.set('ob_pay', id);
    url.searchParams.set('ob_status', status);
    if (digest) url.searchParams.set('ob_digest', digest);
    location.href = url.toString();
  } catch { /* ungültige return-URL ignorieren */ }
}

// ---------- Externe App-Anmeldung (?app_login=1&api=…&return=…) ----------
let appLoginCfg = null;

function readAppLoginFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('app_login') !== '1') return null;
  const cfg = {
    return: params.get('return'),
    api: params.get('api'),
    mode: params.get('mode') === 'payout' ? 'payout' : 'login',
  };
  if (!cfg.return || !cfg.api) return null;
  sessionStorage.setItem('ob_app_login', JSON.stringify(cfg));
  history.replaceState({}, '', location.pathname);
  return cfg;
}

function loadAppLoginCfg() {
  if (appLoginCfg) return appLoginCfg;
  try {
    const raw = sessionStorage.getItem('ob_app_login');
    if (!raw) return null;
    appLoginCfg = JSON.parse(raw);
    return appLoginCfg;
  } catch {
    return null;
  }
}

function clearAppLoginCfg() {
  appLoginCfg = null;
  sessionStorage.removeItem('ob_app_login');
}

function maybeShowAppLoginBanner() {
  const cfg = loadAppLoginCfg();
  const banner = $('#app-login-banner');
  if (!cfg || !banner) return;

  const appName = (() => {
    try { return new URL(cfg.return).hostname.replace(/^www\./, ''); } catch { return 'App'; }
  })();
  const title = cfg.mode === 'payout'
    ? `${t('app.payout')} · ${appName}`
    : `${t('app.login')} · ${appName}`;

  banner.innerHTML = `🔐 <strong>${title}</strong><br />
    <span class="muted small">${t('app.loginhint')}</span>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button id="btn-app-login" class="primary">${t('app.loginconfirm')}</button>
      <button id="btn-app-login-cancel" class="secondary">${t('pay.reject')}</button>
    </div>
    <p id="app-login-msg" class="msg" role="status"></p>`;
  show(banner, true);
  banner.querySelector('#btn-app-login-cancel').addEventListener('click', () => {
    clearAppLoginCfg();
    show(banner, false);
  });
  banner.querySelector('#btn-app-login').addEventListener('click', () => void confirmAppLogin());
}

async function confirmAppLogin() {
  const cfg = loadAppLoginCfg();
  const msg = $('#app-login-msg');
  if (!cfg) return;
  setMsg(msg, t('app.loginbusy'), true);
  try {
    const prep = await api('/api/auth/external/login/prepare', {
      appApiBase: cfg.api,
      appReturnUrl: cfg.return,
      mode: cfg.mode,
    });
    const assertion = await getPasskeyAssertion(prep.options);
    const done = await api('/api/auth/external/login/confirm', {
      challengeId: prep.challengeId,
      response: assertion,
    });
    clearAppLoginCfg();
    show($('#app-login-banner'), false);
    if (done.redirect) {
      toast(cfg.mode === 'payout' ? t('app.payoutok') : t('app.loginok'));
      setTimeout(() => { location.href = done.redirect; }, 400);
      return;
    }
    setMsg(msg, 'Keine Rückleitung möglich.', false);
  } catch (err) {
    setMsg(msg, err.message);
  }
}

// ================= Identity (Phase 1–2, siehe docs/IDENTITY_ARCHITECTURE.md) =====
//
// HINWEIS: Läuft mit did:key + einem klar markierten Demo-Aussteller
// (Selbstauskunft-Geburtsdatum → nur die Alters-Flags werden gespeichert).
// On-Chain-DIDs, SD-JWT/BBS+ und echte eID-/KYC-Aussteller sind (in
// Entwicklung) und werden implementiert, sobald das IOTA-Identity-Framework
// für Rebased bzw. die Aussteller veröffentlicht sind. Demo-Nachweise werden
// serverseitig auf Mainnet-Projekten abgelehnt.

// ---------- Einstellungen: eigener Vault ----------
async function loadIdentity() {
  const box = $('#id-list');
  try {
    const me = await api('/api/identity/me');
    box.innerHTML = '';
    if (!me.credentials.length) {
      box.innerHTML = `<p class="muted small">${t('id.none')}</p>`;
    }
    for (const c of me.credentials) {
      const div = document.createElement('div');
      div.className = 'cred-item';
      const exp = c.expiresAt ? new Date(c.expiresAt * 1000).toLocaleDateString(getLang()) : '—';
      div.innerHTML = `
        <div class="cred-ico">${c.demo ? '🧪' : '🪪'}</div>
        <div class="cred-main">
          <div class="cred-label"></div>
          <div class="muted small"></div>
        </div>
        <button class="cred-del ghost small" title="${t('cred.remove')}">✕</button>`;
      div.querySelector('.cred-label').textContent = c.type + (c.demo ? ` (${t('id.demoBadge')})` : '');
      div.querySelector('.muted').textContent = `${c.issuerDid.slice(0, 24)}… · ${t('id.until')} ${exp}`;
      div.querySelector('.cred-del').addEventListener('click', async () => {
        try { await api(`/api/identity/credentials/${encodeURIComponent(c.id)}`, undefined, 'DELETE'); loadIdentity(); }
        catch (err) { setMsg($('#id-msg'), err.message); }
      });
      box.appendChild(div);
    }
  } catch (err) {
    box.innerHTML = `<p class="warn small">${err.message}</p>`;
  }
}

async function issueDemoCredential(birthdateInputId, msgEl, onDone) {
  setMsg(msgEl, '');
  const birthdate = $(birthdateInputId).value;
  if (!birthdate) return setMsg(msgEl, t('id.needBirthdate'));
  try {
    await api('/api/identity/demo-issue', { birthdate });
    setMsg(msgEl, '✅ ' + t('id.issued'), true);
    toast(t('id.issued'));
    buzz(15);
    onDone?.();
  } catch (err) {
    setMsg(msgEl, err.message);
  }
}

// ---------- Deep-Link-Ziel: ?verify=<id>[&return=<url>] ----------
let verifyOrigin = null;
let verifyReturnUrl = null;
let verifyRequestId = null;
let verifyProjectId = null;
let verifyPolicyId = null;

async function maybeHandleVerifyRequest() {
  const params = new URLSearchParams(location.search);
  const id = params.get('verify');
  if (!id) return;
  verifyReturnUrl = params.get('return');
  try {
    const vr = await api(`/api/verify/request/${encodeURIComponent(id)}`);
    if (vr.status !== 'pending') {
      if (verifyReturnUrl) redirectBackVerify(id, vr.status);
      return;
    }
    verifyOrigin = vr.origin;
    verifyRequestId = vr.id;
    verifyProjectId = vr.projectId;
    verifyPolicyId = vr.policy;
    goto('verify');

    const banner = $('#verify-banner');
    banner.innerHTML = `🎮 <strong>${t('id.requestFrom')}</strong> · <code></code><br />
      <span class="muted small">${t('id.policyLabel')}: <strong>${vr.policy}</strong></span>`;
    banner.querySelector('code').textContent = vr.origin;
    show(banner, true);

    await refreshVerifyPane();
  } catch { /* ungültige Anfrage ignorieren */ }
}

async function refreshVerifyPane() {
  const status = await api(`/api/identity/status/${encodeURIComponent(verifyProjectId)}`);
  const me = await api('/api/identity/me');
  const req = { age16: 'AgeCredential', age18: 'AgeCredential' }[verifyPolicyId];
  const match = me.credentials.find((c) => c.type === req);

  if (status.ok) {
    setMsg($('#verify-msg'), '✅ ' + t('id.alreadyVerified'), true);
    await shareVerification();
    return;
  }
  show($('#verify-need'), !match);
  show($('#verify-have'), !!match);
}

async function shareVerification() {
  try {
    await api(`/api/identity/share/${encodeURIComponent(verifyRequestId)}`, {});
    notifyVerifyGame('verified');
  } catch { /* Policy evtl. gerade erst gesetzt – Nutzer sieht die Nachweis-UI */ }
}

async function presentVerification() {
  const msgEl = $('#verify-msg');
  setMsg(msgEl, '');
  try {
    const me = await api('/api/identity/me');
    const req = { age16: 'AgeCredential', age18: 'AgeCredential' }[verifyPolicyId];
    const cred = me.credentials.find((c) => c.type === req);
    if (!cred) return setMsg(msgEl, t('id.needCred'));

    const { challengeId, options } = await api('/api/identity/present/options', {
      credentialId: cred.id, verifyRequestId, projectId: verifyProjectId, policyId: verifyPolicyId,
    });
    setMsg(msgEl, t('pay.check'), true);
    const response = await getPasskeyAssertion(options);
    setMsg(msgEl, t('id.checking'), true);
    await api('/api/identity/present/confirm', { challengeId, response });
    setMsg(msgEl, '✅ ' + t('id.verifiedNow'), true);
    buzz(20);
    notifyVerifyGame('verified');
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? t('pay.reject') : err.message);
  }
}

async function rejectVerifyRequest() {
  if (!verifyRequestId) return;
  try { await api(`/api/verify/request/${encodeURIComponent(verifyRequestId)}/reject`, {}); } catch { /* egal */ }
  show($('#verify-banner'), false);
  notifyVerifyGame('rejected');
}

function notifyVerifyGame(status) {
  if (window.opener && verifyOrigin && verifyOrigin !== 'unbekannt') {
    window.opener.postMessage({ type: 'orange-bar:verify', status }, verifyOrigin);
    setTimeout(() => window.close(), 1200);
  } else if (verifyReturnUrl) {
    redirectBackVerify(verifyRequestId, status);
  }
}

function redirectBackVerify(id, status) {
  try {
    const url = new URL(verifyReturnUrl, location.origin);
    if (!/^https?:$/.test(url.protocol)) return;
    url.searchParams.set('ob_verify', id);
    url.searchParams.set('ob_status', status);
    location.href = url.toString();
  } catch { /* ungültige return-URL ignorieren */ }
}

// ---------- Navigation ----------
function goto(name) {
  for (const pane of ['home', 'send', 'nfts', 'receive', 'settings', 'verify']) {
    show($(`#pane-${pane}`), pane === name);
  }
  // 'verify' ist ein Deep-Link-Ziel (kein Bottom-Nav-Eintrag) – keinen Tab markieren.
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.goto === name));
  if (name === 'home') refreshHome();
  if (name === 'nfts') loadNfts();
  if (name === 'settings') { loadProjects(); loadIdentity(); }
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
    loadLegalFooter();
    renderPrfStatus();
  });
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  initLanguage();
  await loadAppConfig();
  await loadLegalFooter();
  if (!state.custodialMode && passkeySupported()) await refreshPrfStatus();

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
  $('#btn-id-issue').addEventListener('click', () =>
    issueDemoCredential('#id-birthdate', $('#id-msg'), loadIdentity));
  $('#btn-verify-issue').addEventListener('click', () =>
    issueDemoCredential('#verify-birthdate', $('#verify-msg'), refreshVerifyPane));
  $('#btn-verify-present').addEventListener('click', presentVerification);
  $('#btn-verify-reject').addEventListener('click', rejectVerifyRequest);
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
      try { await navigator.share({ title: t('share.title'), text: state.address }); } catch { /* cancelled */ }
    } else copyAddress();
  });

  if (!passkeySupported()) show($('#no-passkey'), true);

  readAppLoginFromUrl();

  try {
    const me = await api('/api/auth/me');
    if (me.user) {
      state.custodialMode = !!me.custodialMode;
      if (me.needsWalletSetup) {
        try {
          await setupNonCustodialWallet();
          me.address = (await api('/api/wallet/summary')).address;
        } catch (err) {
          show($('#view-auth'), true);
          setMsg($('#auth-msg'), err.message);
          return;
        }
      }
      if (!me.address) {
        show($('#view-auth'), true);
        setMsg($('#auth-msg'), t('wallet.missing'));
        return;
      }
      return enterWallet(me);
    }
  } catch { /* nicht angemeldet */ }
  show($('#view-auth'), true);
}

init();
