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
- 🎮 **In-Game-SDK**: Spiele binden `sdk/orange-bar-sdk.js` ein und fordern Zahlungen
  an – der Nutzer bestätigt im Orange-Bar-Popup per Passkey. Demo unter `/demo/game.html`.

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
| `ORANGE_IOTA_NETWORK` | `testnet` / `devnet` / `mainnet` | `testnet` |
| `ORANGE_IOTA_RPC_URL` | Eigener RPC-Endpunkt (optional) | – |
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

Das SDK legt über `POST /api/pay/request` eine Zahlungsanfrage an, öffnet
Orange-Bar in einem Popup (`/?pay=<id>`), und liefert das Ergebnis per
`postMessage` **und** Status-Polling zurück – robust auch auf Mobilgeräten.
Eine anklickbare Demo liegt unter [`/demo/game.html`](public/demo/game.html).

## API-Überblick

| Route | Zweck |
|---|---|
| `POST /api/auth/register/options` / `verify` | Passkey-Registrierung (legt Konto + Wallet an) |
| `POST /api/auth/login/options` / `verify` | Passkey-Login |
| `GET /api/auth/me` · `POST /api/auth/logout` | Session |
| `GET /api/wallet/summary` | Adresse + IOTA-Guthaben |
| `GET /api/wallet/nfts` | Eigene NFTs/Objekte (mit Display-Metadaten) |
| `POST /api/wallet/tx/prepare` / `confirm` | Senden (IOTA oder NFT) mit Passkey-Bestätigung |
| `POST /api/pay/request` · `GET /api/pay/request/:id` | In-Game-Zahlungsanfragen (CORS-offen) |

## Entwicklung

```bash
npm run dev      # Server mit Auto-Reload
npm test         # Unit-Tests (node:test)
npm run icons    # App-Icons neu erzeugen
```

Stack: Node.js 20+, Express, better-sqlite3, `@simplewebauthn/server`,
`@iota/iota-sdk` 1.13 – Frontend ist buildfrei (Vanilla-ES-Module + PWA).

## Roadmap

- [ ] QR-Code für die Empfangsadresse
- [ ] Push-Benachrichtigungen bei eingehenden Zahlungen
- [ ] Mehrere Passkeys pro Konto (Gerätewechsel/Backup) & Konto-Wiederherstellung
- [ ] iFrame-Einbettung des SDK zusätzlich zum Popup
- [ ] Optional non-custodial: Signieren mit WebAuthn-PRF-Extension
- [ ] Anbindung an die *IOTA Life Forms*-NFTs (Kreaturen direkt in Orange-Bar)
