// Orange-Bar App-Logik: Passkey-Auth, Wallet-Anzeige, Senden mit
// Passkey-Bestätigung, NFT-Liste, In-Game-Zahlungsanfragen (?pay=…).
import { passkeySupported, createPasskey, getPasskeyAssertion } from '/webauthn-client.js';

const $ = (sel) => document.querySelector(sel);
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
  const whole = nanos / NANOS;
  const frac = (nanos % NANOS).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}` : `${whole}`;
}

function parseIotaToNanos(text) {
  const t = String(text).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,9})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return (BigInt(w) * NANOS + BigInt(f.padEnd(9, '0'))).toString();
}

function setMsg(el, text, ok = false) {
  el.textContent = text || '';
  el.className = 'msg ' + (ok ? 'ok' : text ? 'err' : '');
}

// ---------- Auth ----------
async function register() {
  const username = $('#username').value.trim();
  setMsg($('#auth-msg'), '');
  try {
    const { challengeId, options } = await api('/api/auth/register/options', { username });
    const response = await createPasskey(options);
    const result = await api('/api/auth/register/verify', { challengeId, response });
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
    enterWallet(result);
  } catch (err) {
    setMsg($('#auth-msg'), err.name === 'NotAllowedError' ? 'Abgebrochen.' : err.message);
  }
}

async function logout() {
  await api('/api/auth/logout', {});
  location.reload();
}

// ---------- Wallet ----------
let state = { address: null };

function enterWallet({ address, user }) {
  state.address = address;
  show($('#view-auth'), false);
  show($('#view-wallet'), true);
  show($('#btn-logout'), true);
  $('#address').textContent = short(address);
  $('#receive-address').textContent = address;
  refreshBalance();
  maybeHandlePayRequest();
}

const short = (a) => (a && a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a || '');

async function refreshBalance() {
  try {
    const s = await api('/api/wallet/summary');
    $('#net-name').textContent = s.network;
    if (s.balance) {
      $('#balance').textContent = `${fmtIota(s.balance.totalBalance)} IOTA`;
      show($('#net-warn'), false);
    } else {
      $('#balance').textContent = '—';
      $('#net-warn').textContent = s.networkError || 'Netzwerk nicht erreichbar.';
      show($('#net-warn'), true);
    }
  } catch (err) {
    $('#net-warn').textContent = err.message;
    show($('#net-warn'), true);
  }
}

// Senden: prepare → Passkey-Assertion → confirm
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
    setMsg(msgEl, `✅ Gesendet! Digest: ${short(result.digest)}`, true);
    if (payRequestId) finishPayRequest(result);
    refreshBalance();
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? 'Bestätigung abgebrochen.' : err.message);
  }
}

// ---------- NFTs ----------
let selectedNft = null;

async function loadNfts() {
  const list = $('#nft-list');
  list.innerHTML = '<p class="muted">Lade NFTs …</p>';
  try {
    const { objects } = await api('/api/wallet/nfts');
    if (!objects.length) {
      list.innerHTML = '<p class="muted">Noch keine NFTs. Lass dir welche an deine Empfangsadresse senden!</p>';
      return;
    }
    list.innerHTML = '';
    for (const o of objects) {
      const div = document.createElement('button');
      div.className = 'nft';
      const name = o.display?.name || o.type?.split('::').pop() || 'Objekt';
      const img = o.display?.image_url;
      div.innerHTML = `${img ? `<img src="${img}" alt="" loading="lazy" />` : '<div class="nft-ph">🖼️</div>'}
        <div class="nft-name">${name}</div><div class="nft-id muted small">${short(o.objectId)}</div>`;
      div.addEventListener('click', () => {
        selectedNft = o;
        document.querySelectorAll('.nft').forEach((n) => n.classList.remove('sel'));
        div.classList.add('sel');
        show($('#nft-send-form'), true);
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
    setMsg(msgEl, `✅ NFT gesendet! Digest: ${short(result.digest)}`, true);
    selectedNft = null;
    show($('#nft-send-form'), false);
    loadNfts();
  } catch (err) {
    setMsg(msgEl, err.name === 'NotAllowedError' ? 'Bestätigung abgebrochen.' : err.message);
  }
}

// ---------- In-Game-Zahlungsanfrage (?pay=<id>) ----------
async function maybeHandlePayRequest() {
  const id = new URLSearchParams(location.search).get('pay');
  if (!id) return;
  try {
    const pr = await api(`/api/pay/request/${encodeURIComponent(id)}`);
    if (pr.status !== 'pending') return;
    sessionStorage.setItem('ob_pay_request', pr.id);
    switchTab('send');
    $('#send-to').value = pr.to;
    $('#send-amount').value = fmtIota(pr.amountNanos).replace(',', '.');
    setMsg($('#send-msg'),
      `🎮 Zahlungsanfrage von ${pr.origin}${pr.memo ? ` – „${pr.memo}“` : ''}. Prüfe die Daten und bestätige mit Passkey.`, true);
  } catch { /* ungültige Anfrage ignorieren */ }
}

function finishPayRequest(result) {
  sessionStorage.removeItem('ob_pay_request');
  if (window.opener) {
    window.opener.postMessage(
      { type: 'orange-bar:payment', status: 'confirmed', digest: result.digest },
      '*'
    );
    setTimeout(() => window.close(), 1500);
  }
}

// ---------- Tabs & Start ----------
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const pane of ['send', 'nfts', 'receive']) show($(`#tab-${pane}`), pane === name);
  if (name === 'nfts') loadNfts();
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#btn-register').addEventListener('click', register);
  $('#btn-login').addEventListener('click', login);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-send').addEventListener('click', sendIota);
  $('#btn-nft-send').addEventListener('click', sendNft);
  $('#btn-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.address || '');
    $('#btn-copy').textContent = '✔ Kopiert';
    setTimeout(() => ($('#btn-copy').textContent = 'Kopieren'), 1500);
  });

  if (!passkeySupported()) show($('#no-passkey'), true);

  try {
    const me = await api('/api/auth/me');
    if (me.user) return enterWallet(me);
  } catch { /* nicht angemeldet */ }
  show($('#view-auth'), true);
}

init();
