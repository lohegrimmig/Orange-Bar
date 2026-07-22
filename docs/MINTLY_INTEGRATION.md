# Orange-Bar Upstream Push — Mintly Lab Integration (Jul 2026)

Dieses Dokument ist die **Push-/PR-Vorlage** für das Orange-Bar-Repo  
[`lohegrimmig/Orange-Bar`](https://github.com/lohegrimmig/Orange-Bar), damit Features nicht nur als Cardforge-Deploy-Patches leben.

Referenz-Patches in Cardforge (aktuell live via `deploy/cd-deploy.sh`):

| Patch | Datei | Zweck |
|-------|-------|--------|
| Mint Sign / Batch Unlock v8 | `deploy/patch-orange-bar-mint-sign.mjs` | `?mint_sign=1`, `?mint_batch=1`, PRF-Unlock, Live-Ticker, incremental results, „Zurück zur App“ |
| NFT-Liste | `deploy/patch-orange-bar-nft-list.mjs` | Zähler + Cursor-Pagination („Mehr laden“) |
| Burn Sign | `deploy/patch-orange-bar-burn-sign.mjs` | `?burn_sign=1` → ForgeCard vernichten |
| Mintly Login Attest | `deploy/patch-orange-bar-mintly-login.mjs` | Non-custodial Login-HMAC |
| ForgeCard Display | `deploy/patch-orange-bar-forgecard-display.mjs` | Struct-Felder → Display (optional, wenn Upstream noch `showContent:false`) |

---

## PR-Titel (Vorschlag)

**feat: Mintly Lab deep-links — mint batch, burn, NFT pagination**

## PR-Body (kopierbar)

```markdown
## Summary
- First-class deep-links for Mintly Lab NFT mint (single + batch unlock) and burn
- NFT tab: show owned count + cursor pagination (“Mehr laden”)
- ForgeCard display fallback from Move content fields when IOTA Display is empty
- Keep Passkey/PRF unlock in RAM (+ short sessionStorage) so batch mint does not re-prompt Face ID per card

## Query params (wallet origin)

| Param | Meaning |
|-------|---------|
| `mint_sign=1` | Sign one mint TX (`token`, `api`, `card_id`, `return`) |
| `mint_batch=1` | Unlock once, mint up to N cards (`batch`, `api`, `return`) |
| `burn_sign=1` | Sign `forge_cards::burn_card` (`token`, `api`, `nft_id`, `return`) |

Mintly APIs (CORS `*`, token/batchId is the secret):
- `GET {api}/mints/sign-payload/:token`
- `GET {api}/mints/batch-sign-payload/:batchId`
- `POST {api}/mints/batch-sign-results/:batchId` — **call after every mint** (incremental)
- `GET {api}/burns/sign-payload/:token`

Return URLs:
- Mint: `?ob_mint=1&ob_status=confirmed|rejected&ob_digest=&card_id=`
- Batch: `?ob_mint_batch=1&ob_status=&batch=`
- Burn: `?ob_burn=1&ob_status=&ob_digest=&nft_id=&card_id=`

## UX requirements
- Batch: live ticker (done / remaining / progress + pause countdown)
- After batch: **no auto-redirect** — button “Zurück zur App”
- NFT list: header `N NFT(s) in dieser Wallet` + load more via `?cursor=`
- Burn: banner + Passkey, then redirect with digest

## Test plan
- [ ] Mintly “Alle minten” → one Face ID → ticker advances → results POST → Zurück zur App → Mintly confirms
- [ ] Wallet NFT tab shows count ≥ on-chain ForgeCards; Mehr laden works
- [ ] Mintly Wallet-Sync links unlinked cards; orphans listed
- [ ] Burn from Mintly card detail → Orange-Bar Passkey → NFT gone on-chain + removed in Mintly
- [ ] Burn orphan NFT from Mintly sync list

## Notes for maintainers
Until merged, Cardforge reapplies patches in `cd-deploy.sh` after `git pull` in `/var/www/orange-bar`.
After merge: remove obsolete patch blocks from Cardforge deploy.
```

---

## Manuelles Anwenden (bis Upstream merged)

```bash
ssh hetzner-arena
cd /var/www/orange-bar && git checkout -- public/app.js   # nur wenn nötig
node /var/www/cardforge/deploy/patch-orange-bar-mint-sign.mjs
node /var/www/cardforge/deploy/patch-orange-bar-nft-list.mjs
node /var/www/cardforge/deploy/patch-orange-bar-burn-sign.mjs
node /var/www/cardforge/deploy/patch-orange-bar-mintly-login.mjs
# optional:
node /var/www/cardforge/deploy/patch-orange-bar-forgecard-display.mjs
sudo systemctl restart orange-bar
```

## Mintly-seitige Companion-APIs (bereits in Cardforge)

- `POST /api/cards/wallet-sync` — clear phantoms + **link** ForgeCards (`template_id` + `edition_number`) + `orphans[]`
- `POST /api/burns/destroy/prepare` / `confirm`
- `GET /api/burns/sign-payload/:token`
