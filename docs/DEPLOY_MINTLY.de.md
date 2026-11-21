# Orange-Bar auf `wallet.mintlylab.com` deployen

Dieses Dokument gilt für den **Mintly-Lab-Wallet-Host** und jeden anderen Produktiv-Server.
Im GitHub-Repo **gibt es keine automatische CI/CD** – ein Push nach `main` aktualisiert **nicht** von selbst die Live-Seite.

## 1. Ist Live schon aktuell?

Von einem Rechner mit Internet (PowerShell im Repo):

```powershell
.\scripts\verify-live-deploy.ps1
```

Oder manuell:

| Prüfung | Erwartet (Stand `main` nach NFT-Fix) | Bedeutung |
|--------|--------------------------------------|-----------|
| `sw.js` → `CACHE = 'orange-bar-v9'` | **v9** | Neues Frontend wird ausgeliefert |
| `app.js` enthält `collectionHint` | ja | Wallet-API + Galerie-Logik |
| `app.js` enthält `creature-row` | ja | Life-Forms-Layout |
| `style.css` enthält `.creature-chip` | ja | Kleine Kacheln (ohne CSS riesige Bilder) |
| `/api/health` → Feld `version` | z. B. `1.2.3` | Server-Code aus aktuellem `package.json` |

**Hinweis (Stand Nov 2026):** Auf `wallet.mintlylab.com` lief u. a. noch **SW v8**, eine **ältere `app.js`** (Creature-Code **ohne** passendes CSS) und teils **`ob-path.js`** (Subpath-Unterstützung), die im öffentlichen `main` lange fehlte. Dadurch wirkten Änderungen aus GitHub „als ob nichts passiert“.

## 2. Typischer Deploy (manuell auf dem Server)

Voraussetzung: Node.js (LTS), HTTPS vor dem Node-Prozess (nginx/Caddy/…), SQLite-Daten bleiben erhalten.

```bash
cd /pfad/zu/Orange-Bar   # Installationsverzeichnis auf dem Server
git fetch origin
git checkout main
git pull origin main

npm ci
npm test   # optional, empfohlen

# Prozess neu starten (eines davon, je nach Setup):
sudo systemctl restart orange-bar
# oder: pm2 restart orange-bar
# oder: docker compose up -d --build
```

**Produktiv-Umgebung** (Auszug, siehe `.env.example`):

```bash
ORANGE_RP_ID=wallet.mintlylab.com
ORANGE_ORIGINS=https://wallet.mintlylab.com,https://mintlylab.com
ORANGE_MASTER_KEY=<32-Byte-Hex, geheim halten>
ORANGE_TRUSTED_APPS=https://mintlylab.com,...
ORANGE_MINTLY_LOGIN_SECRET=<falls Mintly HMAC-Login>
```

Nach dem Neustart: `curl -sS https://wallet.mintlylab.com/api/health` – sollte `ok: true` und **`version`** aus `package.json` liefern.

## 3. Nach dem Deploy: Clients (Handy / Mintly-In-App-Browser)

1. Orange-Bar-Tab oder PWA **komplett schließen** (nicht nur Zurück).
2. Von Mintly **neu** öffnen.
3. Falls das Layout noch alt ist: Safari → Website-Daten für `wallet.mintlylab.com` löschen **oder** einmal die Seite neu laden (Service Worker wechselt nur bei neuem `CACHE`-Namen).

## 4. Wenn der Server lokale Abweichungen hatte

Mintly hatte teils **Server-seitige Patches** (z. B. `public/ob-path.js`, erweitertes `sw.js` mit `swBasePath()`), die nicht in jedem `main`-Commit enthalten waren.

**Empfehlung:**

1. Patches in **eigenem Git-Branch** im selben Repo festhalten (PR nach `main`), statt nur auf dem Server zu editieren.
2. Nach `git pull` Konflikte lösen, dann testen (`npm test`, kurz NFT-Tab im Handy-Browser).
3. Nie nur `public/app.js` per Hand auf dem Server patchen ohne die gleiche Änderung in Git – sonst driftet Live wieder weg.

## 5. Wer macht den Deploy?

| Rolle | Typische Aufgabe |
|-------|-------------------|
| **Entwicklung** | Pusht nach `github.com/lohegrimmig/Orange-Bar` |
| **Betrieb / Mintly-Host** | `git pull` + Neustart auf der Maschine hinter `wallet.mintlylab.com` |

Ohne SSH-/Panel-Zugang zum Host kann Entwicklung nur den Code liefern – **Sie** (oder der Mintly-Server-Admin) müssen Schritt 2 ausführen.

## 6. Mintly-Login vs. ILF-Spielverbindung

Beide nutzen teils `?app_login=1&api=…&return=…`, aber **verschiedene API-Pfade**:

| Herkunft | `api`-URL (Beispiel) |
|----------|----------------------|
| **ILF / Eierhöhle** | `https://…/api/shop/orange-bar/link/<id>` |
| **Mintly Lab** | z. B. `https://mintlylab.com/api` (kein ILF-Pfad) |

Wird eine **Mintly-URL** fälschlich als ILF-Verknüpfung gespeichert, erscheint nach dem Login rot: **„Engine-API-Pfad ist ungültig“** und die Rückkehr ins Spiel klappt nicht.

**Fix auf dem Server:** `public/app.js` filtert mit `isIlfShopLinkApi()` — nur echte ILF-`api`-URLs werden gespeichert; alte Mintly-Einträge in `localStorage` werden verworfen (`scripts/patch-ilf-app-login-filter.py`).

**Für Nutzer:** Nur **Wallet öffnen** über Mintly → normal. **Ins ILF-Spiel** → Verknüpfung **aus dem Spiel** starten (mit ILF-`app_login`-Link), nicht über die Mintly-Wallet-URL allein.

## 7. Kurz-Checkliste NFT-Layout

- [ ] Live `sw.js` = **v9** (oder höher)
- [ ] `style.css` enthält `.creature-row` / `.creature-chip`
- [ ] NFT-Tab zeigt **„Kreaturen“** / **„Weitere NFTs“** (keine rohen Keys `home.creatures`)
- [ ] Kacheln ca. **5–7 pro Zeile** auf iPhone, nicht halbe Bildschirmbreite pro NFT