# 🟠 Orange-Bar

**Deine Wallet. Dein Gesicht ist der Schlüssel.**

*(English version: [README.md](README.md) · Die App-Oberfläche startet auf Englisch und gibt es in 16 Sprachen.)*

---

## Was ist neu in v1.0.0? (Juli 2026)

**Kurz:** Orange-Bar ist ab Version **1.0.0** standardmäßig **Non-Custodial**. Der Server signiert keine Nutzer-Transaktionen mehr – Schlüssel werden per **Passkey-PRF** auf dem Gerät abgeleitet. Das ist eine bewusste **Architektur- und Compliance-Entscheidung**, nicht nur ein Feature-Update.

### Warum diese Änderung?

Bis v0.1.x war Orange-Bar **standardmäßig custodial**: Der Server erzeugte und hielt verschlüsselte Nutzer-Schlüssel. Für Business-Betrieb in der EU bedeutet das in der Regel **MiCA-CASP-Pflicht** (Verwahrgeschäft, u. a. ~125.000 € Eigenkapital, AML/KYC, BaFin-Zulassung). Für ein Self-Hosted-In-Game-Wallet-Projekt ohne diese Ressourcen ist das keine tragfähige Default-Annahme.

**v1.0.0 dreht das um:**

| Vorher (v0.1.x) | Jetzt (v1.0.0) |
|---|---|
| Custodial = Standard | **Non-Custodial = Standard** |
| Self-Custody optional (Toggle) | PRF-Wallet bei Registrierung |
| Server signiert nach Passkey | **Gerät signiert**, Server broadcastet nur |
| MiCA-Risiko für Betreiber hoch | **Deutlich geringer** für Nutzer-Wallets |

### Zwei Modi – ein Repository

Es gibt **keinen separaten Branch-Zwang** – beide Modi leben im gleichen Code:

| Modus | Aktivierung | Wann sinnvoll? |
|---|---|---|
| **Non-Custodial** | *(nichts setzen)* | Produktion, EU-Business, Mainnet |
| **Custodial** (Legacy) | `ORANGE_CUSTODIAL_MODE=1` | Demos, Geräte ohne PRF, bewusst mit Compliance |

Custodial zeigt **Warnbanner** in der App und **Startup-Warnungen** im Server-Log. Details: **[docs/CUSTODIAL.md](docs/CUSTODIAL.md)**.

### Impressum & Datenschutz (Betreiber-Pflicht)

Jeder, der Orange-Bar **öffentlich** hostet, muss als **Diensteanbieter** erkennbar sein – **unabhängig** vom Wallet-Modus (Non-Custodial oder Custodial). Setze die Umgebungsvariablen `ORANGE_LEGAL_*`; die App verlinkt dann Impressum, Datenschutz und AGB.

**Wichtigste Variable:** `ORANGE_LEGAL_NAME` = **dein** offizieller Firmen- oder Personenname (nicht nur „Orange-Bar“).

Vollständige Erklärung aller Felder mit Beispielen: **[docs/LEGAL.md](docs/LEGAL.md)**.

### Migration für bestehende Deployments

1. **Neue Instanz / frische DB:** Einfach v1.0.0 deployen – neue Nutzer bekommen automatisch PRF-Wallets.
2. **Bestehende custodial Nutzer:** Alte Konten in der DB haben weiterhin Server-Keys → nur mit `ORANGE_CUSTODIAL_MODE=1` betreiben, oder Nutzer migrieren (Self-Custody-Toggle im Custodial-Modus, dann Modus wechseln).
3. **Barkeeper-Gas-Stationen:** Unverändert – das sind **deine** Betriebs-Wallets, kein Nutzer-Custody.

### Technische Highlights v1.0.0

- `POST /api/wallet/setup` – PRF-first Wallet nach Registrierung
- `GET /api/config` – Modus für Frontend (`walletMode`, `custodialMode`)
- Client-Signatur für IOTA **und NFTs**; SDK-Zahlungen mit `payRequestId` gefixt
- Identity Phase 1–2 (Alters-Gates) bleibt erhalten; `did:key` aus Wallet-Public-Key

---

> ⚠️ **Gesunde Skepsis ist wichtig.** Orange-Bar ist bewusst für **In-Game-Währungen und
> kleine Beträge** gedacht – für ein leichtgewichtiges Spiel-/App-Erlebnis, nicht als Tresor.
> Lade **keine großen Ersparnisse** hinein. Bei jeder Wallet gilt: nur so viel einzahlen,
> wie man im Zweifel verschmerzen kann.

Orange-Bar ist eine mobile Wallet-App (PWA) für **IOTA und NFTs**, bei der alles über
**Passkeys** läuft: Konto erstellen, anmelden und **jede Transaktion mit Face ID,
Fingerabdruck oder Geräte-PIN bestätigen** – ganz ohne Seed-Phrase mit 24 Wörtern.

<p align="center">
  <img src="docs/screenshots/onboarding.png" width="230" alt="Onboarding: Deine Wallet, dein Gesicht ist der Schlüssel">
  <img src="docs/screenshots/wallet-home.png" width="230" alt="Wallet-Startseite mit Guthaben und Aktivitäts-Feed">
  <img src="docs/screenshots/barkeeper.png" width="230" alt="Barkeeper-Panel: Projekt, Gas Station, Pro-Nutzer-Limit">
  <img src="docs/screenshots/devices.png" width="230" alt="Geräte- und Passkey-Verwaltung">
</p>

## Funktionsüberblick

- 📱 **Läuft überall**: im mobilen Browser, und als installierbare App auf Android
  („Zum Startbildschirm hinzufügen“) und iPhone (Teilen → „Zum Home-Bildschirm“).
- 🔐 **Passkey statt Seed-Phrase**: Registrierung und Login per WebAuthn
  (`userVerification: required`).
- 👆 **Auch für ältere Handys**: WebAuthn akzeptiert das, womit das Gerät entsperrt
  wird – Face ID, Fingerabdruck **oder den Bildschirmsperr-Code (PIN/Muster)**.
  Handys ohne Biometrie bestätigen Transaktionen einfach mit ihrem Geräte-Code.
- 🙂 **Jede Transaktion einzeln bestätigt**: Senden von IOTA oder NFTs erzeugt eine
  Passkey-Challenge, die fest an genau diese Transaktionsdaten gebunden ist.
- 🪙 **IOTA & NFTs**: Guthaben anzeigen, empfangen, an beliebige Adressen senden
  (IOTA-Rebased-Netzwerk über `@iota/iota-sdk`).
- 🌐 **Netzwerk-Umschalter**: **Testnet / Devnet / Mainnet** direkt in der App
  wechseln (pro Nutzer gespeichert, Mainnet mit Sicherheitswarnung). Dieselbe
  Adresse gilt auf allen Netzwerken.
- 🔒 **Optionale 2FA (TOTP)**: pro Konto per Schalter aktivierbar, kompatibel mit
  Google Authenticator, Aegis, 1Password – Einrichtung per QR-Code.
- 🔑 **Mehrere Passkeys/Geräte pro Konto**: Handy, Tablet oder Ersatzschlüssel
  hinzufügen, damit du nie ausgesperrt bist; der letzte Passkey lässt sich nicht löschen.
- 🔔 **Push bei Zahlungseingang**: Web-Push-Benachrichtigung, sobald Guthaben eintrifft.
- 🍹 **Barkeeper-Modell**: Wer Orange-Bar einbindet, betreibt eine eigene Gas Station
  und legt fest, wie viel Gas jeder Nutzer beziehen darf (siehe unten).
- 🎮 **In-Game-SDK**: Spiele binden `sdk/orange-bar-sdk.js` ein und fordern Zahlungen
  an – der Nutzer bestätigt im Orange-Bar-Popup per Passkey. Popup **und**
  mobilfreundlicher Redirect-Modus.
- 🛡️ **Optionaler Self-Custody-Modus (Beta)**: non-custodial über die WebAuthn-**PRF**-
  Erweiterung – der Schlüssel wird aus dem Passkey abgeleitet, der Server löscht seine
  Kopie, und der Browser signiert Transaktionen **lokal**. Die clientseitige Signatur ist
  nachweislich byte-identisch zu `@iota/iota-sdk` (siehe `tests/iota-sign.test.js`). Nur
  für fortgeschrittene Nutzer/kleine Beträge: Passkey und Seed-Backup verloren bedeutet
  unwiederbringlich verlorene Mittel.
- 🌍 **16 Sprachen**: automatische Erkennung, Umschalter in der App, Rechts-nach-links
  für Arabisch.
- 🎨 **Modernes Mobile-UI**: Glassmorphism, Bottom-Tab-Navigation, QR-Codes,
  Aktivitäts-Feed, haptisches Feedback.

<p align="center">
  <img src="docs/screenshots/receive-qr.png" width="230" alt="Empfangen-Ansicht mit QR-Code">
  <img src="docs/screenshots/settings-i18n.png" width="230" alt="Einstellungen mit Sprachumschalter">
</p>

## Barkeeper-Modell (überall einbindbar)

Orange-Bar ist so gebaut, dass **jeder es einbinden** kann. Wer die App in sein
Spiel/Projekt integriert, wird zum **Barkeeper** – dem Admin seines eigenen Bereichs:

- Jeder angemeldete Nutzer kann unter *Mehr → Barkeeper* ein **Projekt** erstellen und
  wird damit dessen Barkeeper.
- Jedes Projekt hat eine **eigene Gas Station** (ein eigenes Wallet, das der Barkeeper
  von außen mit IOTA auflädt).
- Der Barkeeper legt **Gas pro Bezug** und die **maximale Anzahl Bezüge pro Nutzer**
  fest. So kann jeder Endnutzer von jedem Smartphone sofort loslegen, ohne selbst Gas
  zu besorgen – der Barkeeper behält das Budget in der Hand.
- Jedes Projekt hat eine **Origin-Allowlist**: nur die eigenen Seiten des Barkeepers
  dürfen Zahlungsanfragen stellen oder Gas beziehen – das schützt die Station vor
  Missbrauch.

Einbinden mit Projekt-ID:

```html
<script src="https://deine-orange-bar/sdk/orange-bar-sdk.js"></script>
<script>
  const ob = new OrangeBar('https://deine-orange-bar', { projectId: 'proj_…' });
  const result = await ob.requestPayment({ to: '0x…', amountIota: '1.5', memo: 'Schwert' });
</script>
```

Gehört eine Zahlungsanfrage zu einem Projekt, bietet Orange-Bar dem Spieler **„Gas holen"**
an (und füllt bei leerem Guthaben einmal automatisch auf) – finanziert aus der Station des
Barkeepers und begrenzt durch das Pro-Nutzer-Limit.

> Jede Station ist ein eigenes custodial Ed25519-Wallet; ihr Schlüssel wird wie die
> Nutzer-Wallets mit AES-256-GCM verschlüsselt abgelegt. Projekt-Secrets werden nur als
> SHA-256-Hash gespeichert. Das Pro-Nutzer-Limit wird race-sicher durchgesetzt (eine
> „pending"-Reservierung in einer DB-Transaktion vor der On-Chain-Auszahlung).

## Self-Custody (optional, non-custodial via WebAuthn-PRF)

Standardmäßig ist Orange-Bar **custodial** (der Server hält den verschlüsselten
Schlüssel – beste UX). Wer volle Selbstverwahrung will, aktiviert unter
*Mehr → Sicherheit → Self-Custody* den **non-custodial-Modus**:

1. Der Seed wird **einmalig** per Passkey-Bestätigung exportiert (nur solange
   noch custodial).
2. Aus dem Passkey wird über die **WebAuthn-PRF-Erweiterung** ein Geheimnis
   abgeleitet, das den Seed clientseitig mit AES-256-GCM verschlüsselt.
3. Der Server **löscht seine Kopie** des Schlüssels und speichert nur noch den
   PRF-verschlüsselten Seed. Ab dann **signiert der Browser lokal**: der Server
   baut die Transaktions-Bytes, das Gerät entschlüsselt den Seed per Passkey und
   erzeugt die Ed25519-Signatur; nur die fertige Signatur geht zurück.

Die clientseitige Signatur ist **byte-identisch** zu der des `@iota/iota-sdk`
(Intent „TransactionData" → BLAKE2b-256 → Ed25519 → 1+64+32-Byte-Signatur) –
`tests/iota-sign.test.js` beweist das gegen das SDK, ohne Netzwerk.

> **Ehrlicher Hinweis:** Non-custodial heißt volle Eigenverantwortung. Verlierst du
> Passkey **und** Seed-Backup, sind die Mittel unwiederbringlich – es gibt keine
> Server-Wiederherstellung. Deshalb ist der Modus **Beta**, opt-in und nur für
> kleine In-Game-Beträge empfohlen. Er braucht einen Browser/Authenticator mit
> PRF-Unterstützung; ohne PRF bleibt es beim (bequemeren) custodial-Modus.

## Zwei-Faktor-Authentifizierung (optional)

Unter *Mehr → Sicherheit* per Schalter aktivierbar: QR-Code scannen (oder Secret
manuell eintippen), ersten Code eingeben – fertig. Ab dann verlangt jeder Login
nach dem Passkey zusätzlich den TOTP-Code. Deaktivieren erfordert einen gültigen
aktuellen Code.

## In-Game-Zahlungen (SDK)

```html
<script src="https://deine-orange-bar-domain/sdk/orange-bar-sdk.js"></script>
<script>
  // Optional mit projectId (Barkeeper-Projekt): { projectId: 'proj_…' }
  const ob = new OrangeBar('https://deine-orange-bar-domain');
  const result = await ob.requestPayment({
    to: '0x…',                // Empfängeradresse des Spiels
    amountIota: '1.5',
    memo: 'Schwert des Feuers',
  });
  if (result.status === 'confirmed') {
    // Item freischalten – result.digest ist der Transaktions-Digest
  }
</script>
```

Das SDK legt über `POST /api/pay/request` eine Zahlungsanfrage an und liefert das
Ergebnis per `postMessage` **und** Status-Polling zurück. Über `mode` wählst du,
wie Orange-Bar geöffnet wird:

| `mode` | Verhalten | Wofür |
|---|---|---|
| `'popup'` | Orange-Bar in einem Fenster (`/?pay=<id>`) | Desktop |
| `'redirect'` | Ganze Seite navigiert zu Orange-Bar und kehrt mit `?ob_pay=<id>&ob_status=…` zurück | Mobil / In-App-Browser, die Popups blocken |
| `'auto'` (Standard) | Popup, mit automatischem Redirect-Fallback bei Blockade | überall |

Im Redirect-Modus rufst du beim Laden der Spielseite `await ob.checkReturn()` auf –
es liest das Ergebnis aus der URL, holt den finalen Status nach und bereinigt die
URL. Zahlungsanfragen lassen sich in Orange-Bar auch **ablehnen** (Reject);
im Redirect-Modus kehrt der Nutzer dann mit `ob_status=rejected` zurück.
Eine anklickbare Demo (Popup **und** Redirect) liegt unter
[`/demo/game.html`](public/demo/game.html).

```js
// Redirect-Variante (mobilfreundlich)
await ob.requestPayment({ to, amountIota: '1.5', memo: 'Schwert', mode: 'redirect' });
// … nach Rückkehr, beim Laden der Spielseite:
const res = await ob.checkReturn(); // { id, status, digest? } oder null
```

## Lokal ausprobieren (nur Entwicklung)

```bash
npm install
npm start          # nur zum lokalen Testen: http://localhost:8787
```

Dann **auf demselben Rechner** im Browser öffnen, Nutzernamen wählen,
**„Konto mit Passkey erstellen“** – fertig. Beim Erstellen wird automatisch eine
IOTA-Adresse (testnet) angelegt.

> ⚠️ **`http://localhost:8787` ist NUR die lokale Entwicklungs-Adresse – nicht die
> URL, unter der später echte Nutzer die App aufrufen.** Insbesondere:
> - **Vom Handy aus funktioniert `localhost` nicht.**
> - **Passkeys brauchen HTTPS mit einer echten Domain** (Ausnahme: nur `localhost`
>   am selben Gerät). Fürs Testen vom Handy einen Tunnel (Cloudflare Tunnel, ngrok,
>   Tailscale) nutzen und `ORANGE_RP_ID` + `ORANGE_ORIGINS` auf die Domain setzen.

## Produktiv betreiben

Orange-Bar ist ein **selbst zu hostender Dienst**. Für einen echten Einsatz:

1. Server hinter **HTTPS auf einer eigenen Domain** deployen (z. B. `wallet.dein-spiel.tld`).
2. `ORANGE_RP_ID=wallet.dein-spiel.tld`, `ORANGE_ORIGINS=https://wallet.dein-spiel.tld`
   und einen festen `ORANGE_MASTER_KEY` (`openssl rand -hex 32`) setzen – ohne den
   Master-Key als Secret sind die (custodial) Wallet-Schlüssel nicht sicher.
3. Für **Mainnet**: die Gas Station(s) der Barkeeper-Projekte mit echten IOTA
   aufladen – Auszahlungen sind reale On-Chain-Transaktionen.
4. **Erst auf Testnet durchspielen** und vor echtem Wert ein Security-Review machen.
   Dies ist kein auditiertes Produkt; custodial heißt, der Betreiber ist für die
   Schlüssel verantwortlich (daher die Empfehlung: nur kleine In-Game-Beträge).

## Netzwerke: Testnet / Devnet / Mainnet

Der Umschalter (Pille oben rechts oder *Mehr → Netzwerk*) wechselt zwischen den
drei IOTA-Netzwerken; die Wahl wird pro Nutzer gespeichert. **Dieselbe Adresse
gilt auf allen Netzwerken** – nur Guthaben, NFTs und Aktivität unterscheiden sich.
Mainnet erfordert eine ausdrückliche Bestätigung („echtes IOTA"). Eigene
RPC-Endpunkte lassen sich je Netzwerk über `ORANGE_IOTA_RPC_{TESTNET,DEVNET,MAINNET}`
setzen.

## Wie die Sicherheit funktioniert

1. **Konto = Passkey.** Bei der Registrierung erzeugt das Gerät ein
   Passkey-Schlüsselpaar (discoverable credential); der öffentliche Schlüssel
   liegt am Server, der private bleibt in der Secure Enclave des Geräts.
2. **Wallet-Schlüssel custodial, verschlüsselt.** Pro Nutzer wird ein
   Ed25519-Keypair für IOTA erzeugt und mit AES-256-GCM (Master-Key)
   verschlüsselt in SQLite abgelegt. Der Nutzer braucht nie eine Seed-Phrase.
3. **Transaktionen sind zweistufig.** `POST /api/wallet/tx/prepare` speichert die
   Transaktionsdaten serverseitig zusammen mit einer frischen WebAuthn-Challenge
   (TTL 120 s, Einmal-Verwendung). Erst wenn `POST /api/wallet/tx/confirm` die
   Passkey-Signatur (mit User-Verification) erfolgreich prüft, wird **genau die
   gespeicherte Transaktion** signiert und ins IOTA-Netzwerk gesendet.
   Manipulation der Daten zwischen Anzeige und Bestätigung ist damit ausgeschlossen.
4. **Optionale 2FA (TOTP).** Ist sie aktiv, liefert der Passkey-Login nur ein
   kurzlebiges Ticket; erst der korrekte 6-stellige Authenticator-Code (RFC 6238,
   ±1 Zeitfenster, max. 5 Versuche) erstellt die Session. Das TOTP-Secret wird
   ebenfalls verschlüsselt gespeichert.
5. **Brute-Force-Schutz.** Auth- und 2FA-Endpunkte sind pro IP rate-limitiert
   (Sliding Window). Die In-Game-Pay-API ist bewusst CORS-offen, die
   Wallet-API strikt same-origin und session-gebunden.
6. **Gezieltes `postMessage`.** Das Popup meldet Zahlungsergebnisse nur an die
   konkrete Origin des anfragenden Spiels zurück (kein Wildcard-`*`).
7. **Mandanten-Trennung (Barkeeper).** Projekt-Secrets werden nur als SHA-256-Hash
   gespeichert; jedes Projekt hat eine Origin-Allowlist; das Pro-Nutzer-Gas-Limit wird
   race-sicher durchgesetzt (eine „pending"-Reservierung in einer DB-Transaktion vor der
   On-Chain-Auszahlung), und der Gas-Bezug hängt an einer bereits origin-geprüften
   Zahlungsanfrage. Der Gas-Endpunkt ist zusätzlich rate-limitiert.
8. **Geräte-Code für ältere Handys.** `authenticatorSelection` verlangt keine Biometrie,
   nur `userVerification: required`. Damit erfüllt auf Geräten ohne Face ID/Fingerabdruck
   der **Bildschirmsperr-Code** (PIN/Muster) die Nutzerverifikation – die App bleibt so
   auch mit älteren Smartphones kompatibel.

## Konfiguration

Alle Optionen per Umgebungsvariable, siehe [`.env.example`](.env.example):

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` | Server-Port | `8787` |
| `ORANGE_RP_ID` | WebAuthn-Domain (ohne Protokoll) | `localhost` |
| `ORANGE_ORIGINS` | Erlaubte Browser-Origins (kommagetrennt) | `http://localhost:8787` |
| `ORANGE_IOTA_NETWORK` | Standard-Netzwerk für neue Nutzer | `testnet` |
| `ORANGE_IOTA_RPC_TESTNET/DEVNET/MAINNET` | Eigene RPC-Endpunkte je Netzwerk (optional) | – |
| `ORANGE_MASTER_KEY` | 32-Byte-Hex-Key für die Wallet-/2FA-Verschlüsselung (**Pflicht in Produktion**, `openssl rand -hex 32`) | wird in `data/master.key` erzeugt |
| `ORANGE_VAPID_PUBLIC/PRIVATE/SUBJECT` | Web-Push-Schlüssel | werden in `data/vapid.json` erzeugt |
| `ORANGE_DB_PATH` | SQLite-Pfad | `data/orange-bar.db` |

## API-Überblick

| Route | Zweck |
|---|---|
| `POST /api/auth/register/options` / `verify` | Passkey-Registrierung (legt Konto + Wallet an) |
| `POST /api/auth/login/options` / `verify` | Passkey-Login |
| `POST /api/auth/login/2fa` | Zweiter Login-Schritt bei aktiver 2FA (TOTP) |
| `GET /api/auth/me` · `POST /api/auth/logout` | Session |
| `GET /api/auth/credentials` · `POST …/add/options` · `…/add/verify` · `DELETE …/:id` | Passkeys/Geräte verwalten |
| `GET /api/push/vapid` · `POST /api/push/subscribe` · `…/unsubscribe` | Web-Push-Abos |
| `POST /api/2fa/setup` · `/enable` · `/disable` | 2FA einrichten/aktivieren/deaktivieren |
| `GET /api/wallet/summary` | Adresse + IOTA-Guthaben (aktives Netzwerk) |
| `POST /api/wallet/network` | Netzwerk umschalten (testnet/devnet/mainnet) |
| `GET /api/wallet/nfts` | Eigene NFTs/Objekte (mit Display-Metadaten) |
| `GET /api/wallet/activity` | Letzte Transaktionen |
| `POST /api/wallet/tx/prepare` / `confirm` | Senden (IOTA oder NFT) mit Passkey-Bestätigung (custodial) |
| `GET /api/wallet/custody` · `POST …/custody/export/*` · `…/custody/enable` · `…/custody/enroll` | Self-Custody: Status, Seed-Export, aktivieren, Gerät hinterlegen |
| `POST /api/wallet/tx/build` · `/tx/submit` | Self-Custody: Tx-Bytes bauen · clientseitig signierte Tx ausführen |
| `GET/POST /api/projects` · `PATCH/DELETE /api/projects/:id` | Barkeeper-Projekte verwalten |
| `POST /api/projects/claim-gas` | Gas aus der Projekt-Station beziehen (an Zahlungsanfrage gebunden) |
| `GET /api/projects/:id/grants` · `/:id/public` | Bezugs-Protokoll · öffentliche Projekt-Infos |
| `POST /api/pay/request` · `GET /api/pay/request/:id` | In-Game-Zahlungsanfragen (CORS-offen, optional projektgebunden) |

## Geräte, Wiederherstellung & Benachrichtigungen

- **Mehrere Passkeys pro Konto** (*Mehr → Deine Geräte & Passkeys*): weitere
  Geräte (zweites Handy, Tablet, Hardware-Sicherheitsschlüssel) hinzufügen,
  benennen und entfernen. Der **letzte Passkey kann nicht gelöscht werden** –
  so bleibt das Konto immer zugänglich. Damit ist der Gerätewechsel bzw. die
  Wiederherstellung abgedeckt: einfach vom neuen Gerät einen Passkey hinzufügen.
- **Push bei Zahlungseingang** (*Mehr → Sicherheit → Benachrichtigungen*): Ein
  serverseitiger Balance-Watcher pollt das Guthaben und schickt bei einem Eingang
  eine Web-Push-Nachricht an alle abonnierten Geräte des Nutzers. VAPID-Schlüssel
  werden beim ersten Start erzeugt (`data/vapid.json`) oder per Env gesetzt.

## Entwicklung

```bash
npm run dev       # Server mit Auto-Reload
npm test          # Unit-Tests (node:test): Crypto, Wallet, TOTP, Gas, Projekte, Push,
                  #   sowie iota-sign (Signatur-Parität zum SDK) und PRF-Wrapping
npm run test:e2e  # Mobile-E2E (iPhone + Android emuliert, virtueller Passkey)
npm run icons     # App-Icons neu erzeugen
```

Stack: Node.js 20+, Express, better-sqlite3, `@simplewebauthn/server`, `web-push`,
`@iota/iota-sdk` 1.13 – Frontend ist buildfrei (Vanilla-ES-Module + PWA, 16 Sprachen).

### Mobile-Kompatibilitätstests

`npm run test:e2e` startet den Server und fährt mit einem virtuellen
WebAuthn-Authenticator (User-Verification an = Face ID / Fingerabdruck) je einen
emulierten **iPhone-** und **Android-Durchlauf** (**33 Checks**). Geprüft werden u. a.:
Onboarding & Layout ohne Horizontal-Scroll, PWA-Manifest/Icons/iOS-Meta-Tags, Passkey-
Registrierung & -Login, **Barkeeper-Projekt-Erstellung**, **Pro-Nutzer-Gas-Limit** und
**Origin-Allowlist**, Netzwerk-Umschaltung inkl. Mainnet-Warnung, Empfangs-QR,
Sende-Flow mit Passkey, 2FA-Einrichtung + -Login (inkl. Ablehnung falscher Codes),
mehrere Geräte/Passkeys, In-Game-Zahlung (Popup **und** Redirect), **Sprachwechsel
inkl. RTL**, Rate-Limiting und Auth-Guards. Mit `SCREENSHOT_DIR=./shots` werden
Screenshots je Schritt abgelegt.

> Die Emulation nutzt Chromium mit iPhone-/Android-Viewport & -UserAgent. Für einen
> echten **WebKit/Safari**-Lauf `npx playwright install webkit` (Mac/Linux) und den
> Runner auf `webkit` umstellen.

## Roadmap

- [x] QR-Code für die Empfangsadresse
- [x] Netzwerk-Umschalter Testnet/Devnet/Mainnet
- [x] Optionale 2FA (TOTP)
- [x] Mehrere Passkeys pro Konto (Gerätewechsel/Backup) & Konto-Wiederherstellung
- [x] Push-Benachrichtigungen bei eingehenden Zahlungen
- [x] Redirect-Modus des SDK (mobilfreundlich, ohne Popup) + Reject-Flow
- [x] Multi-Tenant „Barkeeper"-Modell: eigene Gas Station je Projekt, Pro-Nutzer-Limit
- [x] Mehrsprachigkeit (16 Sprachen, Startsprache Englisch, RTL) + englische Doku
- [x] Geräte-Code-Kompatibilität für ältere Handys ohne Biometrie
- [x] **v1.0.0:** Non-Custodial als Standard; Custodial nur per `ORANGE_CUSTODIAL_MODE=1` (siehe docs/CUSTODIAL.md)
- [x] Optional non-custodial: Signieren mit WebAuthn-PRF (clientseitige Signatur) – jetzt Standard
- [x] Architektur für die **IOTA-Identity**-Integration – Altersbeschränkungen durch
      den Barkeeper, verifizierte Barkeeper, portable Cross-Game-Reputation,
      credential-beschränkter Handel: siehe
      [docs/IDENTITY_ARCHITECTURE.md](docs/IDENTITY_ARCHITECTURE.md)
      (mit deutscher Zusammenfassung)
- [x] Identity Phase 1–2 umgesetzt (Credential Vault, Policy-Engine, Alters-Gate) –
      Demo-Stufe: `did:key` + selbst ausgestelltes JWT-VC, klar als "(in Entwicklung)"
      markiert und auf Mainnet-Projekten abgelehnt; On-Chain-`did:iota`, SD-JWT/BBS+
      und echte eID-/KYC-Aussteller folgen, sobald Framework bzw. Aussteller
      veröffentlicht sind
- [ ] Anbindung an die *IOTA Life Forms*-NFTs (Kreaturen direkt in Orange-Bar)
