# Rechtstexte & Impressum (Self-Hosting)

Orange-Bar ist **Open-Source-Software**. Wer eine Instanz öffentlich betreibt, ist **Diensteanbieter** im Sinne von Impressumspflicht (§ 5 DDG), Datenschutz (DSGVO) und ggf. AGB – **nicht** automatisch die Software-Autoren auf GitHub.

Diese Datei erklärt alle **`ORANGE_LEGAL_*`**-Umgebungsvariablen. Nach dem Setzen erscheinen die Texte unter:

- `/legal/impressum`
- `/legal/datenschutz`
- `/legal/agb`

…und Links im Login- sowie Einstellungs-Bereich der App.

> **Keine Rechtsberatung, keine Haftung.** Die mitgelieferten Texte sind **unverbindliche Vorlagen**. Die Projektautoren übernehmen **keine Haftung** für Vollständigkeit, Richtigkeit oder rechtliche Angemessenheit. Für Produktion (besonders Mainnet, Custodial, KYC/Identity) mit einem Anwalt prüfen; jeder Betreiber haftet für seine Instanz selbst.

---

## Schnellstart (Deutschland, Minimal)

```env
ORANGE_LEGAL_NAME=Musterfirma GmbH
ORANGE_LEGAL_FORM=GmbH
ORANGE_LEGAL_STREET=Musterstraße 1
ORANGE_LEGAL_ZIP=12345
ORANGE_LEGAL_CITY=Musterstadt
ORANGE_LEGAL_COUNTRY=Deutschland
ORANGE_LEGAL_EMAIL=support@musterfirma.de
ORANGE_LEGAL_PHONE=+49 123 456789
ORANGE_LEGAL_RESPONSIBLE=Max Mustermann
```

Server neu starten. Im Log erscheint: `Rechtstexte: Musterfirma GmbH (GmbH) (/legal/impressum)`.

Ohne diese Variablen zeigen die Seiten einen **Platzhalter** mit Hinweis für den Betreiber (lokal ok, in Produktion nicht empfohlen).

---

## Pflicht vs. optional

| Variable | Pflicht für „konfiguriert“ | Bedeutung |
|---|---|---|
| `ORANGE_LEGAL_NAME` | **Ja** | **Offizieller Name des Diensteanbieters** – siehe unten |
| `ORANGE_LEGAL_EMAIL` | **Ja** | Erreichbare Kontakt-E-Mail (Impressum + Datenschutz) |
| `ORANGE_LEGAL_STREET` | **Ja** | Straße und Hausnummer |
| `ORANGE_LEGAL_CITY` | **Ja** | Ort |
| `ORANGE_LEGAL_ZIP` | empfohlen | Postleitzahl |
| `ORANGE_LEGAL_COUNTRY` | optional | Standard: `Deutschland` |
| `ORANGE_LEGAL_FORM` | optional | Rechtsform, z. B. `GmbH`, `UG`, `Einzelunternehmen` |
| `ORANGE_LEGAL_PHONE` | optional | Telefon (in DE faktisch oft erwartet) |
| `ORANGE_LEGAL_WEBSITE` | optional | Weitere Web-Adresse des Betreibers |
| `ORANGE_LEGAL_REGISTER` | optional | Handelsregister-Nr., z. B. `HRB 12345` |
| `ORANGE_LEGAL_REGISTER_COURT` | optional | Registergericht, z. B. `Amtsgericht München` |
| `ORANGE_LEGAL_VAT_ID` | optional | USt-IdNr., z. B. `DE123456789` |
| `ORANGE_LEGAL_RESPONSIBLE` | optional | Verantwortlich i. S. d. § 18 Abs. 2 MStV; Standard: `ORANGE_LEGAL_NAME` |
| `ORANGE_LEGAL_DPO_EMAIL` | optional | Datenschutzbeauftragter (falls bestellt) |
| `ORANGE_LEGAL_SERVICE_NAME` | optional | Anzeigename des Dienstes; Standard: `ORANGE_RP_NAME` |
| `ORANGE_LEGAL_CUSTODY_NOTE` | optional | Eigener Hinweistext im Custodial-Impressum |

**„Konfiguriert“** bedeutet: Name, E-Mail, Straße und Ort sind gesetzt → echte Betreibertexte statt Platzhalter.

---

## Was muss bei `ORANGE_LEGAL_NAME` stehen?

`ORANGE_LEGAL_NAME` ist der **rechtlich verantwortliche Anbieter dieser Orange-Bar-Instanz** – also **du** (bzw. deine Firma), nicht „Orange-Bar“ oder „IOTA“ als Projektname.

### Einzelunternehmer / Freiberufler (DE)

Trage deinen **vollständigen bürgerlichen Namen** ein:

```env
ORANGE_LEGAL_NAME=Max Mustermann
# ORANGE_LEGAL_FORM weglassen oder:
ORANGE_LEGAL_FORM=Einzelunternehmen
```

### GmbH, UG, AG, …

Trage den **eingetragenen Firmennamen** exakt wie im Handelsregister ein:

```env
ORANGE_LEGAL_NAME=Musterfirma GmbH
ORANGE_LEGAL_FORM=GmbH
ORANGE_LEGAL_REGISTER=HRB 123456
ORANGE_LEGAL_REGISTER_COURT=Amtsgericht Berlin-Charlottenburg
```

Die Rechtsform kann in `ORANGE_LEGAL_FORM` stehen; sie wird im Impressum als `Name (Form)` angezeigt. Wenn die Form schon im Namen steht (`… GmbH`), ist `ORANGE_LEGAL_FORM` optional.

### Verein (e. V.)

```env
ORANGE_LEGAL_NAME=Orange Gaming e. V.
ORANGE_LEGAL_FORM=eingetragener Verein
```

### Du betreibst für einen Arbeitgeber / Kunden

Dann gehört in `ORANGE_LEGAL_NAME` die **juristische Person des Auftraggebers**, die den Dienst veröffentlicht – nicht dein privater Name, sofern du nicht selbst Anbieter bist.

### Was **nicht** reingehört

| Falsch | Richtig |
|---|---|
| `Orange-Bar` allein (Software-Name) | Firma oder voller Name des Betreibers |
| `wallet.example.com` (nur Domain) | Domain optional in `ORANGE_LEGAL_WEBSITE` |
| `IOTA Foundation` | Nur wenn die Foundation tatsächlich Betreiber ist |
| Spitzname ohne Nachnamen | Vollständiger Name bei Einzelpersonen |

Der **Produktname** in der App kommt aus `ORANGE_RP_NAME` bzw. `ORANGE_LEGAL_SERVICE_NAME` (z. B. „Orange-Bar“, „Mein-Spiel-Wallet“).

---

## Beispiele nach Szenario

### 1. Hobby-Testnet (lokal)

Keine Variablen nötig. Platzhalter-Seiten reichen zum Entwickeln.

### 2. Öffentliches Testnet für ein Indie-Spiel

```env
ORANGE_RP_NAME=PixelQuest Wallet
ORANGE_LEGAL_SERVICE_NAME=PixelQuest Wallet
ORANGE_LEGAL_NAME=Anna Beispiel
ORANGE_LEGAL_STREET=Spielerallee 7
ORANGE_LEGAL_ZIP=10115
ORANGE_LEGAL_CITY=Berlin
ORANGE_LEGAL_EMAIL=wallet@pixelquest.example
ORANGE_LEGAL_RESPONSIBLE=Anna Beispiel
```

### 3. Firma, Mainnet, Non-Custodial (Standard v1.0.0)

Wie oben mit GmbH-Feldern; **kein** Custodial-Hinweis im Impressum außer dem Standardtext zu Non-Custodial.

### 4. Custodial-Demo (`ORANGE_CUSTODIAL_MODE=1`)

Zusätzlich MiCA-Hinweis (automatisch) oder eigener Text:

```env
ORANGE_CUSTODIAL_MODE=1
ORANGE_LEGAL_CUSTODY_NOTE=Diese Demo-Instanz verwahrt Testnet-Schlüssel zu Schulungszwecken. Kein Angebot für Endkunden in der EU.
```

---

## Technische Details

- Konfiguration wird in `server/legal.js` gelesen (kein Neustart von Node bei `.env`-Änderung ohne Prozess-Neustart).
- API: `GET /api/legal` → `{ configured, serviceName, operatorName, email, links }` für App-Footer.
- In **Produktion** (wenn `ORANGE_RP_ID` ≠ `localhost`) warnt der Server beim Start, falls nicht konfiguriert.
- Rechtstexte der Seiten sind derzeit **Deutsch**; Footer-Labels folgen der App-Sprache (i18n).

---

## Checkliste vor Go-Live

- [ ] `ORANGE_LEGAL_NAME` = korrekte juristische Person
- [ ] Vollständige ladungsfähige Anschrift
- [ ] Erreichbare E-Mail (und ggf. Telefon)
- [ ] Handelsregister/USt-IdNr., falls vorhanden
- [ ] Datenschutztext an tatsächliche Verarbeitung anpassen (Hosting, Logs, Push, Custodial ja/nein)
- [ ] AGB bei kostenpflichtigen Leistungen erweitern
- [ ] Links in App und SDK-Docs für Spiel-Partner sichtbar machen

---

## Siehe auch

- [CUSTODIAL.md](./CUSTODIAL.md) – Custodial-Modus & MiCA
- [IDENTITY_ARCHITECTURE.md](./IDENTITY_ARCHITECTURE.md) – Altersnachweise / KYC-Demo
- `.env.example` – alle Variablen zum Kopieren
