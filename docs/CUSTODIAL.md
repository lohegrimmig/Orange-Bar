# Orange-Bar – Custodial-Modus (Legacy / Opt-in)

**Version 1.0.0** trennt zwei Betriebsarten:

| Modus | Standard? | Umgebungsvariable | Server hält Nutzer-Schlüssel? |
|---|---|---|---|
| **Non-Custodial** | ✅ Ja (empfohlen) | *(keine Variable)* | Nein |
| **Custodial** | Nein (Legacy) | `ORANGE_CUSTODIAL_MODE=1` | Ja |

---

## Non-Custodial (Standard seit v1.0.0)

- Schlüssel werden per **WebAuthn-PRF** aus dem Passkey abgeleitet.
- Der Server speichert nur die **verschlüsselte** Seed-Kopie (ohne PRF nicht lesbar).
- **Keine MiCA-CASP-Verwahrung** für die Nutzer-Wallet (Software/Infrastruktur).
- Voraussetzung: Browser/Gerät mit **Passkey-PRF** (hmac-secret).
- Die App zeigt auf dem Login-Bildschirm einen **PRF-Gerätecheck** (grüner Haken oder Alternativen-Hinweis).

---

## Custodial-Modus aktivieren

Nur wenn du bewusst den Legacy-Flow brauchst (z. B. Geräte ohne PRF):

```bash
# .env oder Deployment
ORANGE_CUSTODIAL_MODE=1
```

Der Server loggt beim Start:

```
⚠️  CUSTODIAL-MODUS AKTIV
⚠️  Nutzer-Schlüssel liegen auf dem Server – MiCA-CASP-Pflicht in der EU möglich!
```

Die PWA zeigt zusätzlich **Warnbanner** auf Login- und Wallet-Ansicht.

---

## Regulatorische Warnung (EU / Deutschland)

Wenn du **Custodial** für EU-Nutzer mit **Mainnet** und **echtem Guthaben** betreibst:

1. **MiCA** – Verwahrung von Kryptowerten für Dritte → in der Regel **CASP-Zulassung** (BaFin), inkl. Eigenkapitalanforderungen (Klasse 2: ca. 125.000 €).
2. **GwG** – KYC/AML, Travel Rule, Transaktionsüberwachung.
3. **DORA** – IT-Risikomanagement für CASPs.
4. **DSGVO** – Datenschutz, ggf. DSFA.

Orange-Bar ersetzt **keine Rechtsberatung**. Vor Produktivbetrieb im Custodial-Modus: **Fachanwalt** (Krypto/Fintech) konsultieren.

Die Übergangsfristen unter MiCA sind in der EU **abgelaufen** (Stand 2026). Unzulässige Verwahrung kann **buß- und strafrechtlich** relevant sein.

---

## Was im Custodial-Modus anders ist

| Feature | Non-Custodial | Custodial |
|---|---|---|
| Registrierung | PRF-Wallet-Setup sofort | Server erzeugt Schlüssel |
| Senden / NFTs | Client signiert (PRF) | Server signiert nach Passkey |
| Self-Custody-Toggle | Ausgeblendet (immer aktiv) | Optional aktivierbar |
| Geräte ohne PRF | ❌ nicht unterstützt | ✅ funktioniert |
| Signierter Extern-Login (Mintly) | ❌ nur Payout-Adresse | ✅ |
| Identity / DID (Phase 1–2) | ✅ (Public Key beim Setup) | ✅ |

**Barkeeper-Gas-Stationen** sind in **beiden** Modi custodial – aber das sind **deine** Betriebs-Wallets, keine Nutzer-Verwahrung.

---

## Empfehlung

- **Produktion / Business in der EU:** Non-Custodial-Standard (`ORANGE_CUSTODIAL_MODE` **nicht** setzen).
- **Custodial:** nur Testnet, interne Demos, oder mit vollständiger CASP-Compliance.
- **Git-Branch `custodial`:** optional für langfristige Legacy-Pflege (gleicher Code, Dokumentation fokussiert auf Warnungen).

---

*English summary: set `ORANGE_CUSTODIAL_MODE=1` only if you accept custodial wallet operation and potential MiCA CASP obligations in the EU. Default is non-custodial since v1.0.0.*
