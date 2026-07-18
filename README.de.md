# 🟠 Orange-Bar

**Deine Wallet. Dein Gesicht ist der Schlüssel.**

*(English version: [README.md](README.md) · Die App-Oberfläche startet auf Englisch und gibt es in 16 Sprachen.)*

---

---

---

---

## v1.1.1 (Juli 2026)

- **Race Condition bei Agent-Stations-Zahlungen behoben:** zwei gleichzeitige `station_pay`-Aufrufe konnten beide das Tageslimit lesen, bevor einer seine Ausgabe verbucht hatte — das Limit ließ sich so umgehen. Limit-Prüfung und Usage-Buchung laufen jetzt in einer einzigen synchronen DB-Transaktion, bevor die On-Chain-Sendung startet; scheitert die Sendung, wird die Reservierung zurückgebucht.
- **`idempotencyKey` für `POST /api/agent/station/pay`** (und das MCP-Tool `station_pay`) ergänzt: ein Agent-Retry nach Timeout/Fehler mit demselben Key liefert das Ergebnis des ersten Versuchs zurück, statt ein zweites Mal aus dem Float zu zahlen.

## v1.1.0 (Juli 2026) — KI-Agenten

**Kurz:** Orange-Bar spricht jetzt mit KI-Agenten (Cursor, Bots, Scripts) — **ohne** die Passkey-Sicherung der User-Wallet aufzuweichen. Agenten können Guthaben lesen, Zahlungen *vorschlagen* oder aus einem optionalen **Agent-Stations-Float** zahlen. Architektur & MiCA-Hinweise: **[docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md)**.

### Was ist neu?

| Fähigkeit | Was der Agent darf | Wer bestätigt? |
|---|---|---|
| **Lesen** (`read`) | Adresse, Netzwerk, Balance | — |
| **Vorschlagen** (`pay_request`) | Pay-Request anlegen (wie In-Game-SDK) | **Du** per Passkey in der PWA |
| **Stations-Float** (`station_spend`) | Aus separatem Hot-Wallet zahlen | Server (Stations-Key) innerhalb deiner Limits |

Die User-Wallet (PRF/Passkey) wird **nie** vom Agenten signiert. Die Agent-Station ist ein **bewusstes Extra-Float** (Adresse ≠ deine Wallet), analog Barkeeper-Gas — nur kleine Beträge aufladen.

### Einstellungen in der App

Pfad: **Einstellungen → Agenten**

#### 1. Agent-Token anlegen

1. „＋ Agent-Token erstellen“ öffnen  
2. Optionen setzen (siehe Tabelle)  
3. **Mit Passkey erstellen** (Face ID / Fingerabdruck / PIN)  
4. Token `oba_…` **einmalig** per Copy oder QR sichern — danach nicht mehr sichtbar  
5. Später jederzeit **widerrufen** (✕ in der Liste)

| Einstellung | Bedeutung |
|---|---|
| **Bezeichnung** | Name in der Liste und in Push-Hinweisen (z. B. „Cursor“) |
| **Berechtigungen** | `Guthaben lesen` · `Zahlungsanfragen anlegen` · `Aus Station zahlen` |
| **Max. pro Anfrage** | Obergrenze je Vorschlag/Stations-Zahlung (IOTA, leer = keines) |
| **Tageslimit** | Summe pro UTC-Tag (IOTA, leer = keines) |
| **Gültig (Tage)** | Ablauf des Tokens (1–365, Standard 30) |
| **Netzwerk-Bindung** | Nur `testnet` / `devnet` / `mainnet` — oder beliebig |
| **Projekt-ID** | Optional: nur mit diesem Barkeeper-Projekt |
| **An Station binden** | Optional: `station_spend` nur für diese Station |
| **Erlaubte Adressen** | Allowlist (eine `0x…` pro Zeile, leer = alle) |

#### 2. Agent-Station (optional, für autonome Ausgaben)

1. „＋ Station erstellen“ → Passkey  
2. Stations-**Adresse** kopieren und mit einer normalen Wallet-Überweisung aufladen  
3. Limits an der Station setzen (Max / Tag / Allowlist / Netzwerk)  
4. Token mit Scope **Aus Station zahlen** erzeugen (idealerweise an die Station gebunden)

Ohne Station bleiben Agenten im sicheren **Propose-only**-Modus: sie legen Pay-Requests an, du bestätigst in der PWA.

### So funktioniert’s mit Cursor / MCP

1. Token in den Einstellungen erzeugen und kopieren  
2. MCP konfigurieren (Beispiel):

```json
{
  "mcpServers": {
    "orange-bar": {
      "command": "node",
      "args": ["mcp/orange-bar-mcp.js"],
      "env": {
        "ORANGE_BAR_URL": "https://deine-orange-bar.example",
        "ORANGE_BAR_AGENT_TOKEN": "oba_…"
      }
    }
  }
}
```

3. Oder: `npm run mcp` mit denselben Umgebungsvariablen  

**MCP-Tools:** `get_balance` · `create_payment` · `get_payment_status` · `list_stations` · `station_pay`

### REST auf einen Blick

| Wer | Endpunkt | Zweck |
|---|---|---|
| Du (Session) | `POST /api/agent/tokens/prepare` + `/confirm` | Token mit Passkey |
| Du (Session) | `POST /api/agent/stations/prepare` + `/confirm` | Station mit Passkey |
| Agent (Bearer) | `GET /api/agent/wallet/summary` | Balance lesen |
| Agent (Bearer) | `POST /api/agent/pay/request` | Zahlung vorschlagen |
| Agent (Bearer) | `POST /api/agent/station/pay` | Aus Float zahlen |

### Sicherheit (unverändert im Kern)

- Jede Bewegung aus der **User-Wallet** braucht weiterhin frische **WebAuthn**-Bestätigung  
- Token nur als SHA-256-Hash in der DB; Klartext einmalig  
- Widerruf sofort wirksam  
- Station und User-Adresse bleiben getrennt — kein Commingling mit dem Passkey-Wallet  

## v1.0.5 (Juli 2026)

- **Mintly-Login im Non-Custodial-Modus:** HMAC-Attestation (`ORANGE_MINTLY_LOGIN_SECRET`) statt Server-Signatur – wiederhergestellt (war auf dem Live-Server als lokaler Patch)

## v1.0.4 (Juli 2026)

- **Pack-/Spiel-Freischaltung:** Pay-Request gilt als `confirmed`, sobald ein Tx-**Digest** vorliegt (nicht erst bei perfektem Effects-Status)
- Redirect übergibt zusätzlich `ob_digest`; SDK `checkReturn()` nutzt Digest + längeres Polling — behebt „Paket gekauft, aber Öffnen führt zurück zur Auswahl“

## v1.0.3 (Juli 2026)

- **Fix In-Game-Zahlungen:** Pay-Request-Status wird nach erfolgreicher Tx zuverlässig `confirmed` (Status aus `waitForTransaction`, nicht aus der ersten RPC-Antwort)
- **SDK `checkReturn()`:** kurzes Polling, wenn Redirect `ob_status=confirmed` meldet, die API aber noch `pending` ist — behebt „Zahlung nicht bestätigt“ obwohl IOTA abgegangen sind

## v1.0.2 (Juli 2026)

**Kurz:** Non-Custodial braucht **Passkey-PRF** (Schlüsselableitung aus dem Passkey). Viele **ältere Handys** unterstützen Passkeys (PIN/Fingerabdruck), aber **kein PRF** — Registrierung im Standard-Modus scheitert dort nicht mehr erst nach der Passkey-Abfrage, sondern wird **vorher erklärt**.

### PRF-Gerätecheck auf dem Login-Bildschirm

Beim Öffnen der App (Non-Custodial-Modus) prüft Orange-Bar per `PublicKeyCredential.getClientCapabilities()`, ob der Browser **`extension:prf`** meldet:

| Anzeige | Bedeutung |
|---|---|
| **Grüner Haken ✓** | PRF verfügbar — Non-Custodial-Registrierung möglich |
| **Rotes ✗** | Kein PRF (typisch ältere Geräte/Browser) — Registrierung gesperrt, mit Hinweisen |
| **Gelbes ?** | Browser meldet PRF nicht — Registrierung versuchbar, bei Fehler gleiche Alternativen |

### Pragmatischer Ansatz (kein largeBlob)

Wir nutzen **bewusst kein** WebAuthn-`largeBlob` für Wallet-Seeds (falsches Werkzeug, fragmentierter Support). Stattdessen:

1. **PRF** — Standardweg für Non-Custodial (wie in v1.0.0)
2. **Neueres Gerät / aktueller Browser** (z. B. Chrome, Safari mit PRF)
3. **Custodial-Modus** durch den Betreiber (`ORANGE_CUSTODIAL_MODE=1`) für Geräte ohne PRF — siehe **[docs/CUSTODIAL.md](docs/CUSTODIAL.md)**

Betreiber und Nutzer sehen auf dem Login klar, ob das Gerät für Non-Custodial geeignet ist.

## v1.0.1 (Juli 2026)

- **Rechtstexte** per `ORANGE_LEGAL_*` (Impressum, Datenschutz, AGB) — **[docs/LEGAL.md](docs/LEGAL.md)**
- **Haftungsausschluss:** mitgelieferte Rechtstexte sind unverbindliche Vorlagen; keine Haftung der Projektautoren

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

> **Haftungsausschluss:** Die mitgelieferten Rechtstexte (Impressum, Datenschutz, AGB) sind unverbindliche Vorlagen. Die Projektautoren übernehmen **keine Haftung** für deren Vollständigkeit, Richtigkeit oder rechtliche Angemessenheit. Jeder Betreiber ist selbst für rechtskonforme Texte verantwortlich.

### Migration für bestehende Deployments

1. **Neue Instanz / frische DB:** Einfach v1.0.0 deployen – neue Nutzer bekommen automatisch PRF-Wallets.
2. **Bestehende custodial Nutzer:** Alte Konten in der DB haben weiterhin Server-Keys → sie können direkt im Non-Custodial-Modus migrieren: Die App zeigt für solche Altkonten den Self-Custody-Toggle (Mehr → Sicherheit); Senden ist bis zur Migration gesperrt. Alternativ mit `ORANGE_CUSTODIAL_MODE=1` betreiben.
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

### Wo wird der Passkey mit dem Seed verbunden – und wo wird das gespeichert?

Die Verbindung passiert **ausschließlich auf dem Gerät** (im Browser), nie auf dem
Server. Die komplette Logik steckt in [`public/prf.js`](public/prf.js) und
[`public/app.js`](public/app.js):

1. **PRF-Ausgabe holen** — `getPrfOutput()` (`public/prf.js`) startet eine
   WebAuthn-Abfrage mit der **PRF-Erweiterung** (fester Eval-Salt
   `orange-bar/self-custody/v1`). Der Authenticator liefert daraufhin ein
   **32-Byte-Geheimnis, das je Passkey einzigartig und stabil** ist. Dieses
   Geheimnis verlässt das Gerät nie.
2. **Seed-Ableitung (neue Konten)** — `setupNonCustodialWallet()`
   (`public/app.js`) leitet aus der PRF-Ausgabe per **HKDF-SHA-256**
   (Info `orange-bar/wallet-seed/v1`) direkt den 32-Byte-Ed25519-Wallet-Seed ab
   (`deriveSeedFromPrf()`). **Hier ist die eigentliche Verbindung Passkey ↔ Seed:**
   derselbe Passkey ergibt deterministisch immer denselben Seed.
3. **Verschlüsselung** — aus derselben PRF-Ausgabe wird ein separater
   **AES-256-GCM-Schlüssel** abgeleitet (HKDF, Info `orange-bar-aes`);
   `wrapSeed()` verschlüsselt damit den Seed zu `base64(iv‖ciphertext)`.
   Bei der Migration alter custodial Konten wird stattdessen der einmalig
   exportierte Server-Seed so verschlüsselt (Punkt 2 entfällt dann).

**Gespeichert wird Folgendes:**

| Was | Wo | Wer kann es lesen |
|---|---|---|
| Privater Passkey-Schlüssel | Nur im Secure-Element/Authenticator des Geräts | Nur das Gerät (nach Face ID/Fingerabdruck/Code) |
| PRF-verschlüsselter Seed (`wrapped`) | Server-SQLite, Tabelle `self_custody_keys` (eine Zeile pro Passkey: `user_id`, `credential_id`, `wrapped`) — Schema in [`server/db.js`](server/db.js), Migration v6 | Niemand ohne die PRF-Ausgabe des passenden Passkeys — der Server kann ihn **nicht** entschlüsseln |
| Klartext-Seed | **Nirgends dauerhaft** — er existiert nur flüchtig im Browser-RAM während Setup/Signierung und wird danach genullt (`seed.fill(0)`) | – |

Der verschlüsselte Blob geht per `POST /api/wallet/setup` (Neuanlage) bzw.
`…/custody/enable` / `…/custody/enroll` (Migration / weiteres Gerät) an den
Server (`server/routes/wallet.js`). Beim Umschalten auf Self-Custody setzt
`enableSelfCustody()` (`server/wallet.js`) den serverseitigen Schlüssel
(`wallets.key_ciphertext`) auf einen leeren Blob — der Server kann ab dann
nicht mehr signieren. Zum Signieren entschlüsselt das Gerät den Blob lokal
(`unwrapSeed()`), signiert und schickt **nur die fertige Signatur** zurück.

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
5. **Orange-Bar in eine kommerziell vertriebene App eingebettet?** Ab Dezember 2027
   verlangt der EU Cyber Resilience Act für solche Produkte eine CE-Kennzeichnung —
   siehe **[docs/CE.md](docs/CE.md)**: wer betroffen ist, die Selbstbewertungs-Schritte
   und die Kosten.

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
- [x] **v1.1.1:** Race Condition beim Tageslimit behoben + Idempotency-Key bei Agent-Stations-Zahlungen
- [x] **v1.1.0:** KI-Agenten (Tokens, Policies, PWA, Agent-Station, MCP) – docs/AGENT_ARCHITECTURE.md
- [x] **v1.0.5:** Mintly Non-Custodial-Login per HMAC-Attestation
- [x] **v1.0.4:** Pay-Confirm mit Digest für In-Game-Freischaltung (Pack öffnen)
- [x] **v1.0.3:** Fix Pay-Request-Bestätigung nach In-Game-Zahlung (SDK checkReturn + Chain-Status)
- [x] **v1.0.2:** PRF-Gerätecheck im Login (grüner Haken / Alternativen-Hinweis)
- [x] **v1.0.1:** Rechtstexte per `ORANGE_LEGAL_*`, Haftungsausschluss für Vorlagen (docs/LEGAL.md)
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
- [x] **KI-Agenten Phase 1:** Agent-Tokens + `/api/agent/*` + MCP (Propose-only) – [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md)
- [x] **KI-Agenten Phase 2:** WebAuthn-Mint, PWA-UI, Tageslimit / Netzwerk / Projekt
- [x] **KI-Agenten Phase 3:** Agent-Station (Hot-Wallet-Float, `station_spend`)
- [ ] Anbindung an die *IOTA Life Forms*-NFTs (Kreaturen direkt in Orange-Bar)
