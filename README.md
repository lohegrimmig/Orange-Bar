# 🟠 Orange-Bar

**Deine Wallet. Dein Gesicht ist der Schlüssel.**

Orange-Bar ist eine mobile Wallet-App (PWA) für **IOTA und NFTs**, bei der alles über
**Passkeys** läuft: Konto erstellen, anmelden und **jede Transaktion mit Face ID,
Fingerabdruck oder Geräte-PIN bestätigen** – ganz ohne Seed-Phrase mit 24 Wörtern.

- 📱 **Läuft überall**: im mobilen Browser, und als installierbare App auf Android
  („Zum Startbildschirm hinzufügen“) und iPhone (Teilen → „Zum Home-Bildschirm“).
- 🔐 **Passkey statt Seed-Phrase**: Registrierung und Login per WebAuthn
  (Face ID / Fingerabdruck), `userVerification: required`.
- 🙂 **Jede Transaktion einzeln bestätigt**: Senden von IOTA oder NFTs erzeugt eine
  Passkey-Challenge, die fest an genau diese Transaktionsdaten gebunden ist.
- 🪙 **IOTA & NFTs**: Guthaben anzeigen, empfangen, an beliebige Adressen senden
  (IOTA-Rebased-Netzwerk über `@iota/iota-sdk`, kompatibel zu den
  Move-Verträgen aus *IOTA Life Forms*).
- 🌐 **Netzwerk-Umschalter**: **Testnet / Devnet / Mainnet** direkt in der App
  wechseln (pro Nutzer gespeichert, Mainnet mit Sicherheitswarnung). Dieselbe
  Adresse gilt auf allen Netzwerken.
- 🔒 **Optionale 2FA (TOTP)**: pro Konto per Schalter aktivierbar, kompatibel mit
  Google Authenticator, Aegis, 1Password – Einrichtung per QR-Code.
- ⛽ **Admin-Modus mit Gas Station**: Der Admin betreibt ein Station-Wallet, das
  neue Nutzer automatisch mit Startgas versorgt (Auto-Funding) und einzelne
  Nutzer manuell auffüllen kann – so kann jedes Smartphone sofort loslegen,
  ohne selbst Gas zu besorgen.
- 🎮 **In-Game-SDK**: Spiele binden `sdk/orange-bar-sdk.js` ein und fordern Zahlungen
  an – der Nutzer bestätigt im Orange-Bar-Popup per Passkey. Demo unter `/demo/game.html`.
- 🎨 **Modernes Mobile-UI**: Glassmorphism, Bottom-Tab-Navigation, QR-Codes,
  Aktivitäts-Feed, haptisches Feedback – ausgelegt auf iPhone- und Android-Viewports.

## Schnellstart

```bash
npm install
npm start          # läuft auf http://localhost:8787
```

Dann im Browser öffnen, Nutzernamen wählen, **„Konto mit Passkey erstellen“** – fertig.
Beim Erstellen des Kontos wird automatisch eine IOTA-Adresse (testnet) angelegt.

> **Wichtig:** Passkeys funktionieren nur auf `localhost` oder über **HTTPS**.
> Fürs Testen vom Handy aus z. B. einen Tunnel (Cloudflare Tunnel, ngrok, Tailscale)
> verwenden und `ORANGE_RP_ID` + `ORANGE_ORIGINS` auf die Domain setzen.

## Konfiguration

Alle Optionen per Umgebungsvariable, siehe [`.env.example`](.env.example):

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` | Server-Port | `8787` |
| `ORANGE_RP_ID` | WebAuthn-Domain (ohne Protokoll) | `localhost` |
| `ORANGE_ORIGINS` | Erlaubte Browser-Origins (kommagetrennt) | `http://localhost:8787` |
| `ORANGE_IOTA_NETWORK` | Standard-Netzwerk für neue Nutzer | `testnet` |
| `ORANGE_IOTA_RPC_TESTNET/DEVNET/MAINNET` | Eigene RPC-Endpunkte je Netzwerk (optional) | – |
| `ORANGE_ADMIN_USERS` | Zusätzliche Admin-Nutzernamen (kommagetrennt) | – (nur erster Nutzer) |
| `ORANGE_MASTER_KEY` | 32-Byte-Hex-Key für die Wallet-Verschlüsselung (**Pflicht in Produktion**, `openssl rand -hex 32`) | wird in `data/master.key` erzeugt |
| `ORANGE_DB_PATH` | SQLite-Pfad | `data/orange-bar.db` |

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
   Wallet-/Admin-API strikt same-origin und session-gebunden.
6. **Gezieltes `postMessage`.** Das Popup meldet Zahlungsergebnisse nur an die
   konkrete Origin des anfragenden Spiels zurück (kein Wildcard-`*`).

## Netzwerke: Testnet / Devnet / Mainnet

Der Umschalter (Pille oben rechts oder *Mehr → Netzwerk*) wechselt zwischen den
drei IOTA-Netzwerken; die Wahl wird pro Nutzer gespeichert. **Dieselbe Adresse
gilt auf allen Netzwerken** – nur Guthaben, NFTs und Aktivität unterscheiden sich.
Mainnet erfordert eine ausdrückliche Bestätigung („echtes IOTA"). Eigene
RPC-Endpunkte lassen sich je Netzwerk über `ORANGE_IOTA_RPC_{TESTNET,DEVNET,MAINNET}`
setzen.

## Admin & Gas Station

Damit Nutzer von jedem Smartphone **ohne eigenes Startguthaben** sofort senden
können, gibt es eine Gas Station:

- Der **erste registrierte Nutzer** wird automatisch Admin (zusätzlich lassen sich
  Namen über `ORANGE_ADMIN_USERS` als Admins festlegen).
- Unter *Mehr → Gas Station* sieht der Admin die **Station-Adresse** und deren
  Guthaben je Netzwerk. Diese Adresse lädt man von außen mit IOTA auf.
- **Auto-Funding** (per Schalter): Jeder neue Nutzer bekommt bei der Registrierung
  automatisch den eingestellten Startbetrag – best effort, protokolliert unter
  `/api/admin/grants`.
- **Manuelles Funding**: In der Nutzerliste kann der Admin jedem Konto gezielt Gas
  auf dem aktuell gewählten Netzwerk senden.

> Die Station ist ein eigenes custodial Ed25519-Wallet; ihr Schlüssel wird wie die
> Nutzer-Wallets mit AES-256-GCM verschlüsselt abgelegt.

## Zwei-Faktor-Authentifizierung (optional)

Unter *Mehr → Sicherheit* per Schalter aktivierbar: QR-Code scannen (oder Secret
manuell eintippen), ersten Code eingeben – fertig. Ab dann verlangt jeder Login
nach dem Passkey zusätzlich den TOTP-Code. Deaktivieren erfordert einen gültigen
aktuellen Code.

## In-Game-Zahlungen (SDK)

```html
<script src="https://deine-orange-bar-domain/sdk/orange-bar-sdk.js"></script>
<script>
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
| `POST /api/wallet/tx/prepare` / `confirm` | Senden (IOTA oder NFT) mit Passkey-Bestätigung |
| `GET /api/admin/station` · `POST /api/admin/station/config` | Gas Station (nur Admin) |
| `GET /api/admin/users` · `POST /api/admin/grant` · `GET /api/admin/grants` | Nutzer & manuelles Funding (nur Admin) |
| `POST /api/pay/request` · `GET /api/pay/request/:id` | In-Game-Zahlungsanfragen (CORS-offen) |

## Entwicklung

```bash
npm run dev       # Server mit Auto-Reload
npm test          # Unit-Tests (node:test): Crypto, Wallet, TOTP, Gas Station
npm run test:e2e  # Mobile-E2E (iPhone + Android emuliert, virtueller Passkey)
npm run icons     # App-Icons neu erzeugen
```

Stack: Node.js 20+, Express, better-sqlite3, `@simplewebauthn/server`,
`@iota/iota-sdk` 1.13 – Frontend ist buildfrei (Vanilla-ES-Module + PWA).

### Mobile-Kompatibilitätstests

`npm run test:e2e` startet den Server und fährt mit einem virtuellen
WebAuthn-Authenticator (User-Verification an = Face ID / Fingerabdruck) je einen
emulierten **iPhone-** und **Android-Durchlauf**. Geprüft werden u. a.: Onboarding
& Layout ohne Horizontal-Scroll, PWA-Manifest/Icons/iOS-Meta-Tags, Passkey-
Registrierung & -Login, Admin-Erkennung, Gas-Station-Konfiguration, Auto- und
Manual-Funding, Netzwerk-Umschaltung inkl. Mainnet-Warnung, Empfangs-QR,
Sende-Flow mit Passkey, 2FA-Einrichtung + -Login (inkl. Ablehnung falscher Codes),
In-Game-Zahlungsanfrage, Rate-Limiting und Auth-Guards. Mit
`SCREENSHOT_DIR=./shots` werden Screenshots je Schritt abgelegt.

> Die Emulation nutzt Chromium mit iPhone-/Android-Viewport & -UserAgent. Für einen
> echten **WebKit/Safari**-Lauf `npx playwright install webkit` (Mac/Linux) und den
> Runner auf `webkit` umstellen.

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

## Roadmap

- [x] QR-Code für die Empfangsadresse
- [x] Netzwerk-Umschalter Testnet/Devnet/Mainnet
- [x] Admin-Gas-Station (Auto- & Manual-Funding)
- [x] Optionale 2FA (TOTP)
- [x] Mehrere Passkeys pro Konto (Gerätewechsel/Backup) & Konto-Wiederherstellung
- [x] Push-Benachrichtigungen bei eingehenden Zahlungen
- [x] Redirect-Modus des SDK (mobilfreundlich, ohne Popup) + Reject-Flow
- [ ] Optional non-custodial: Signieren mit WebAuthn-PRF-Extension
- [ ] Anbindung an die *IOTA Life Forms*-NFTs (Kreaturen direkt in Orange-Bar)
