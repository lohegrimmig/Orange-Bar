# 🟠 Orange-Bar

**Your wallet. Your face is the key.**

*(Deutsche Version: [README.md](README.md) · The UI starts in English and ships in 16 languages.)*

> ⚠️ **Healthy skepticism is always wise.** Orange-Bar is deliberately built for **in-game
> currencies and small amounts** — for a lightweight game/app experience, not as a vault.
> **Don’t load large savings into it.** As with any wallet: only deposit what you could
> afford to lose.

Orange-Bar is a mobile wallet app (PWA) for **IOTA and NFTs** where everything runs
through **passkeys**: create an account, sign in, and **confirm every transaction with
Face ID, a fingerprint or your device code** — no 24-word seed phrase at all.

- 📱 **Runs everywhere** — in the mobile browser and as an installable app on Android
  ("Add to home screen") and iPhone (Share → "Add to Home Screen").
- 🔐 **Passkey instead of a seed phrase** — registration and login via WebAuthn
  (`userVerification: required`).
- 👆 **Works on older phones too** — WebAuthn's user verification is satisfied by
  whatever unlocks the device: Face ID, fingerprint, **or the screen-lock code
  (PIN/pattern)**. Phones without biometrics simply confirm with their device code.
- 🙂 **Each transaction confirmed individually** — a passkey challenge is bound to the
  exact transaction data.
- 🪙 **IOTA & NFTs** — show balance, receive, send to any address (IOTA Rebased via
  `@iota/iota-sdk`).
- 🌐 **Network switcher** — Testnet / Devnet / Mainnet in-app (Mainnet with a warning).
  The same address works on every network.
- 🔒 **Optional 2FA (TOTP)** — per account, compatible with Google Authenticator, Aegis,
  1Password; QR-code setup.
- 🔑 **Multiple passkeys / devices per account** — add a phone, tablet or backup key so
  you are never locked out; the last passkey can't be removed.
- 🔔 **Push on incoming payments** — Web-Push notifications when funds arrive.
- 🎮 **In-game SDK** — games embed `sdk/orange-bar-sdk.js` and request payments; the user
  confirms in Orange-Bar with a passkey. Popup **and** mobile-friendly redirect mode.
- 🛡️ **Optional self-custody (beta)** — non-custodial mode via the WebAuthn **PRF**
  extension: the key is derived from your passkey, the server deletes its copy, and the
  browser signs transactions **locally**. The client signature is proven byte-identical to
  `@iota/iota-sdk` (see `tests/iota-sign.test.js`). Only for advanced users / small amounts:
  lose your passkey and seed backup and the funds are unrecoverable.
- 🌍 **Many languages** — the UI ships in 16 languages with automatic detection and a
  switcher (incl. right-to-left for Arabic).

## The Barkeeper model (embed it anywhere)

Orange-Bar is meant to be **embedded by anyone**. Whoever integrates it into their
game/project becomes the **Barkeeper** — the admin of their own space:

- Any signed-in user can create a **Project** and thereby become its Barkeeper.
- Each project has its **own gas station** (a dedicated wallet the Barkeeper tops up).
- The Barkeeper sets **how much gas a user gets per draw** and the **maximum number of
  draws per user** — so end users can start on any smartphone without owning gas first,
  while the Barkeeper stays in control of the budget.
- Each project has an **allowed-origins list**: only the Barkeeper's own sites may create
  payment requests or trigger gas draws, which protects the gas station from abuse.

Embed with a project id:

```html
<script src="https://your-orange-bar/sdk/orange-bar-sdk.js"></script>
<script>
  const ob = new OrangeBar('https://your-orange-bar', { projectId: 'proj_…' });
  const result = await ob.requestPayment({
    to: '0x…', amountIota: '1.5', memo: 'Sword of Fire', mode: 'auto',
  });
  if (result.status === 'confirmed') { /* unlock the item */ }
</script>
```

When a payment request belongs to a project, Orange-Bar offers the player a **"Get gas"**
action (and auto-tops-up once if their balance is empty), funded by the Barkeeper's gas
station and capped by the per-user limit.

## Quick start

```bash
npm install
npm start          # http://localhost:8787
```

> **Note:** passkeys only work on `localhost` or over **HTTPS**. To test from a phone use
> a tunnel (Cloudflare Tunnel, ngrok, Tailscale) and set `ORANGE_RP_ID` + `ORANGE_ORIGINS`.

## Security model

1. **Account = passkey.** The device holds the private key; the server stores only the
   public key.
2. **Wallet keys are custodial and encrypted** with AES-256-GCM (master key from
   `ORANGE_MASTER_KEY`, mandatory in production).
3. **Two-step transactions.** `tx/prepare` stores the exact transaction with a one-time
   WebAuthn challenge (120 s); `tx/confirm` only executes after the passkey signature
   (with user verification) verifies — so the data can't change between display and
   approval.
4. **Optional TOTP 2FA** — the passkey login only issues a short-lived ticket; the correct
   authenticator code (RFC 6238) creates the session.
5. **Brute-force protection** — rate limiting on the sensitive login/registration/2FA and
   gas-claim endpoints.
6. **Multi-tenant isolation** — project secrets are stored only as SHA-256 hashes; per-user
   gas limits are enforced race-safely (a pending grant is reserved inside a DB transaction
   before the on-chain payout); origin allowlists guard each project; the pay result is
   posted only to the requesting game's origin (no wildcard).

## Configuration (env)

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | server port | `8787` |
| `ORANGE_RP_ID` | WebAuthn domain (no scheme) | `localhost` |
| `ORANGE_ORIGINS` | allowed browser origins (comma-separated) | `http://localhost:8787` |
| `ORANGE_IOTA_NETWORK` | default network for new users | `testnet` |
| `ORANGE_IOTA_RPC_TESTNET/DEVNET/MAINNET` | custom RPC endpoints | – |
| `ORANGE_MASTER_KEY` | 32-byte hex key for wallet/2FA encryption (**required in prod**, `openssl rand -hex 32`) | generated in `data/master.key` |
| `ORANGE_VAPID_PUBLIC/PRIVATE/SUBJECT` | Web-Push keys | generated in `data/vapid.json` |
| `ORANGE_DB_PATH` | SQLite path | `data/orange-bar.db` |

## Tests

```bash
npm test          # unit tests (crypto, wallet, TOTP, gas, projects, push)
npm run test:e2e  # mobile E2E (iPhone + Android emulation, virtual passkey)
```

The E2E suite drives a real Chromium with a **virtual WebAuthn authenticator**
(user verification on = Face ID / fingerprint) across an emulated **iPhone** and
**Android** run: onboarding, PWA, passkey register/login, Barkeeper project creation,
per-user gas-limit enforcement, origin allowlist, network switching, sending, 2FA,
multiple devices, in-game pay (popup + redirect), i18n switching (incl. RTL), rate
limiting and auth guards — currently **30 checks green**.

## Stack

Node.js 20+, Express, better-sqlite3, `@simplewebauthn/server`, `web-push`,
`@iota/iota-sdk` 1.13. Build-free front end (vanilla ES modules + PWA).
