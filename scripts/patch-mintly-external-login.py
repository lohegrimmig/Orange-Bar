#!/usr/bin/env python3
"""Mintly Lab: external login in app.js + index.js (Server-Fork)."""
from pathlib import Path
import sys

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "/var/www/orange-bar")

MINTLY_BLOCK = r'''
// ---------- Mintly Lab / externe App (?app_login=1&api=…&return=…) ----------
let appLoginCfg = null;

function readAppLoginFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('app_login') !== '1') return null;
  if (isIlfShopLinkApi && isIlfShopLinkApi(params.get('api'))) return null;
  const cfg = {
    return: params.get('return'),
    api: params.get('api'),
    mode: params.get('mode') === 'payout' ? 'payout' : 'login',
  };
  if (!cfg.return || !cfg.api) return null;
  sessionStorage.setItem('ob_app_login', JSON.stringify(cfg));
  try { clearIlfShopLinkPending(); } catch { /* ILF optional */ }
  params.delete('app_login');
  params.delete('api');
  params.delete('return');
  params.delete('mode');
  const qs = params.toString();
  window.history.replaceState({}, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
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
  show($('#ilf-link-banner'), false);
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
      setTimeout(() => { window.location.assign(done.redirect); }, 400);
      return;
    }
    setMsg(msg, 'Keine Rückleitung möglich.', false);
  } catch (err) {
    setMsg(msg, err.message);
  }
}

'''

app_path = ROOT / "public/app.js"
app = app_path.read_text(encoding="utf-8")

if "function readAppLoginFromUrl()" not in app:
    marker = "// ---------- ILF Shop-Wallet-Verknüpfung"
    if marker not in app:
        print("ILF marker not found", file=sys.stderr)
        sys.exit(1)
    app = app.replace(marker, MINTLY_BLOCK + marker, 1)

if "maybeShowAppLoginBanner();" not in app:
    old = "  goto('home');\n  maybeHandlePayRequest();"
    new = "  goto('home');\n  maybeShowAppLoginBanner();\n  maybeHandlePayRequest();"
    if old in app:
        app = app.replace(old, new, 1)
    else:
        print("enterWallet hook not found", file=sys.stderr)
        sys.exit(1)

if "loadAppLoginCfg() &&" not in app:
    old = "async function maybeHandleAppLogin() {\n  dropStaleNonIlfShopLink();\n  stashAppLoginFromUrl();"
    new = "async function maybeHandleAppLogin() {\n  if (loadAppLoginCfg()) return;\n  dropStaleNonIlfShopLink();\n  stashAppLoginFromUrl();"
    if old in app:
        app = app.replace(old, new, 1)
    elif "async function maybeHandleAppLogin() {\n  stashAppLoginFromUrl();" in app:
        app = app.replace(
            "async function maybeHandleAppLogin() {\n  stashAppLoginFromUrl();",
            "async function maybeHandleAppLogin() {\n  if (loadAppLoginCfg()) return;\n  stashAppLoginFromUrl();",
            1,
        )

app = app.replace("  stashAppLoginFromUrl();\n  try {\n    await ensureEmbedStorageAccess();",
                  "  readAppLoginFromUrl();\n  try {\n    await ensureEmbedStorageAccess();", 1)

app_path.write_text(app, encoding="utf-8")
print("patched", app_path)

idx_path = ROOT / "server/index.js"
idx = idx_path.read_text(encoding="utf-8")
if "externalRouter" not in idx:
    idx = idx.replace(
        "import { authRouter } from './routes/auth.js';\n",
        "import { authRouter } from './routes/auth.js';\nimport { externalRouter } from './routes/external.js';\n",
        1,
    )
    idx = idx.replace(
        "app.use(p('/api/auth'), authRouter);\n",
        "app.use(p('/api/auth'), authRouter);\napp.use(p('/api/auth/external'), externalRouter);\n",
        1,
    )
    idx_path.write_text(idx, encoding="utf-8")
    print("patched", idx_path)
else:
    print("index.js already has externalRouter")