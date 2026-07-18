# CE-Kennzeichnung für Apps mit eingebetteter Orange-Bar (Cyber Resilience Act)

> **Stand: Juli 2026.** Dieses Dokument ist eine praktische Orientierungshilfe,
> **keine Rechtsberatung**. Die Projektautoren übernehmen keine Haftung für
> Vollständigkeit oder Richtigkeit. Für verbindliche Aussagen bitte eine auf
> Produkt-Compliance/IT-Recht spezialisierte Kanzlei einbinden.

## Worum geht es?

Der **Cyber Resilience Act** (CRA, Verordnung (EU) 2024/2847) macht erstmals
**Software selbst zum CE-pflichtigen Produkt**. Wer ein „Produkt mit digitalen
Elementen" **im Rahmen einer kommerziellen Tätigkeit** auf dem EU-Markt
bereitstellt, ist „Hersteller" im Sinn des CRA und braucht ab dem Stichtag eine
CE-Kennzeichnung.

**Fristen:**

| Datum | Pflicht |
|---|---|
| **11. September 2026** | Meldepflichten: aktiv ausgenutzte Schwachstellen und schwerwiegende Sicherheitsvorfälle müssen an ENISA/CSIRT gemeldet werden (24 h Frühwarnung, 72 h Meldung, Abschlussbericht) |
| **11. Dezember 2027** | Volle Herstellerpflichten: Produkte dürfen nur noch **mit CE-Kennzeichnung** und nach Konformitätsbewertung in Verkehr gebracht werden |

## Bin ich betroffen? (Entscheidungsbaum)

1. **Ist meine App ein „Produkt" oder ein „Dienst"?**
   - **Reines Web-Spiel/SaaS** (läuft nur im Browser, wird nicht als Download
     vertrieben): gilt als **Dienst** → kein CRA/CE, aber ggf. NIS2. Das
     Einbetten des Orange-Bar-SDK per `<script>` ändert daran nichts — auch die
     selbst gehostete Orange-Bar-Instanz ist ein Dienst, kein Produkt.
   - **Vertriebene App** (App Store, Play Store, Download-Client, verkaufte
     Software): **Produkt mit digitalen Elementen** → CRA gilt.
2. **Handle ich kommerziell?** Verkauf, In-App-Käufe, Werbung, kostenpflichtiger
   Support — schon eines davon reicht in der Regel. Rein private/unentgeltliche
   Hobby-Apps ohne Monetarisierung fallen heraus.
3. **EU-Markt?** Sobald die App gezielt Nutzern in der EU bereitgestellt wird.

**Wenn 1 = Produkt, 2 = ja, 3 = ja → CE-Pflicht ab 11.12.2027** (Meldepflichten
schon ab 11.09.2026, auch für Bestandsprodukte, die danach weiter mit Updates
versorgt werden).

**Wichtig:** Die CE-Pflicht trifft **dich als Hersteller deiner App** — nicht
das Orange-Bar-Projekt. Orange-Bar als unentgeltliche Open-Source-Software
bleibt vom CRA ausgenommen. Als Integrator hast du aber eine
**Sorgfaltspflicht für eingebundene Komponenten** (Art. 13 Abs. 5 CRA): du musst
prüfen, dass die Komponente keine bekannten Schwachstellen hat, sie in deiner
SBOM führen und gefundene Schwachstellen an das Upstream-Projekt melden.

## Welche Risikoklasse — und welches Verfahren?

Eine Spiele-/App mit eingebetteter Wallet steht **nicht** in Anhang III
(„wichtige Produkte", z. B. Passwort-Manager, Browser, VPN) oder Anhang IV
(„kritische Produkte"). Sie ist damit ein **Standardprodukt** (~90 % aller
Produkte), und es genügt die **Selbstbewertung nach Modul A** („interne
Fertigungskontrolle") — **keine benannte Stelle (notified body), keine externe
Prüfung, keine Behördengebühr**.

> Graubereich: Würde die Wallet als eigenständiges Sicherheitsprodukt vermarktet
> (Nähe zu „Passwort-Managern", Anhang III Klasse I), wäre eine anwaltliche
> Einordnung ratsam. Als eingebettete Bezahlfunktion eines Spiels spricht die
> Zweckbestimmung des Gesamtprodukts für die Standardklasse.

## Anleitung: In 9 Schritten zur CE-Kennzeichnung (Modul A)

### Schritt 1 — Produkt abgrenzen und Zweckbestimmung dokumentieren
Definiere schriftlich: Was gehört zum Produkt (App, eingebettete Komponenten,
zugehörige „remote data processing" wie deine gehostete Orange-Bar-Instanz,
falls die App ohne sie ihre Kernfunktion nicht erfüllt)? Was ist die
bestimmungsgemäße Verwendung?

### Schritt 2 — Cybersicherheits-Risikobewertung (Art. 13 Abs. 2)
Systematische Analyse: Angriffsflächen, Schutzbedarf, Missbrauchsszenarien —
für eine Wallet-Integration z. B. Phishing auf Payment-Flows, Manipulation der
Origin-Allowlist, Session-Diebstahl. Die Risikobewertung ist Pflichtteil der
technischen Dokumentation und steuert, welche Anforderungen aus Anhang I wie
umgesetzt werden.

### Schritt 3 — Grundlegende Anforderungen umsetzen (Anhang I Teil I)
Die wichtigsten Punkte, mit dem, was Orange-Bar bereits mitbringt:

| Anforderung | In Orange-Bar bereits angelegt |
|---|---|
| Sichere Standardkonfiguration | Non-custodial ist Default; custodial nur per `ORANGE_CUSTODIAL_MODE=1` mit Warnbannern |
| Schutz vor unbefugtem Zugriff | WebAuthn `userVerification: required`, optional TOTP-2FA, Rate-Limiting |
| Vertraulichkeit/Integrität | AES-256-GCM, PRF-verschlüsselter Seed, Tx-Bindung an Passkey-Challenge |
| Datenminimierung | Keine Seed-Klartexte serverseitig, Projekt-Secrets nur als SHA-256-Hash |
| Verfügbarkeit/Resilienz | Rate-Limiting, Origin-Allowlists |
| Sicherheitsupdates | **Deine Pflicht als App-Hersteller:** Update-Mechanismus, standardmäßig automatische Security-Updates |

Du bewertest das **Gesamtprodukt** (deine App) — Orange-Bar deckt nur den
Wallet-Teil ab.

### Schritt 4 — Schwachstellenmanagement einrichten (Anhang I Teil II)
- **SBOM** (Software Bill of Materials) erstellen und pflegen — maschinenlesbar
  (CycloneDX oder SPDX; kostenlose Tools: `syft`, `cdxgen`, npm `--package-lock-only`-Auswertung).
- **Coordinated-Disclosure-Policy** veröffentlichen (z. B. `SECURITY.md` +
  `security.txt` mit Kontaktadresse).
- Prozess für **kostenlose, unverzügliche Sicherheitsupdates** über den
  gesamten **Support-Zeitraum** (erwartete Nutzungsdauer, Richtwert **mind.
  5 Jahre**; der Zeitraum muss dem Nutzer genannt werden).
- Regelmäßige Tests/Reviews des Produkts (dokumentieren!).

### Schritt 5 — Meldeprozesse aufsetzen (ab 11.09.2026 Pflicht!)
Aktiv ausgenutzte Schwachstellen und schwere Vorfälle: **24 h** Frühwarnung,
**72 h** Meldung, Abschlussbericht — über die zentrale Meldeplattform
(ENISA/zuständiges CSIRT, in Deutschland BSI). Intern festlegen: Wer erkennt,
wer meldet, wie erreichbar?

### Schritt 6 — Technische Dokumentation erstellen (Anhang VII)
Ein Dossier mit: Produktbeschreibung, Architektur/Design, Risikobewertung
(Schritt 2), Umsetzung der Anhang-I-Anforderungen, SBOM, Testberichte,
Support-Zeitraum, ggf. angewandte Normen. **10 Jahre aufbewahren** (bzw.
Support-Zeitraum, falls länger).

### Schritt 7 — Konformitätsbewertung Modul A durchführen
Interne Prüfung: Erfüllt das Produkt anhand der Dokumentation alle
Anforderungen? Sobald die **harmonisierten Normen der EN-40000-Serie**
(CEN/CENELEC JTC 13, erste Veröffentlichungen ab H2 2026 erwartet) im
EU-Amtsblatt gelistet sind, löst ihre Anwendung die **Konformitätsvermutung**
aus — bis dahin: direkt gegen Anhang I dokumentieren.

### Schritt 8 — EU-Konformitätserklärung ausstellen (Anhang V)
Formales Dokument: Produkt, Hersteller (Name, Anschrift), Erklärung der
Alleinverantwortung, Verweis auf CRA und angewandte Normen, Ort/Datum/
Unterschrift. Muss dem Produkt beiliegen (bei Software: mit ausgeliefert oder
per verlinkter Download-Seite zugänglich).

### Schritt 9 — CE-Kennzeichnung anbringen
Bei reiner Software: CE-Zeichen **auf der EU-Konformitätserklärung und auf der
Website/Produktseite bzw. im Store-Eintrag/Begleitmaterial** (sichtbar, lesbar,
dauerhaft). Kein Antrag, keine Registrierung, keine Gebühr — das Zeichen wird
in Eigenverantwortung geführt; Marktüberwachungsbehörden kontrollieren
nachträglich.

## Was kostet das?

**Die CE-Kennzeichnung selbst kostet nichts** — es gibt keine Gebühr, keinen
Antrag, keine Zertifizierungsstelle für Standardprodukte. Die Kosten sind der
**Umsetzungsaufwand**:

| Posten | Größenordnung (kleine App, Modul A) |
|---|---|
| Eigenleistung: Risikobewertung, Doku, SBOM, Prozesse | überwiegend Arbeitszeit; realistisch mehrere Personenwochen initial |
| Tooling (SBOM, Dependency-Scanning) | 0 € (Open-Source: syft, cdxgen, osv-scanner, Dependabot) |
| Optionale externe Beratung/Review | ca. 2.000–15.000 € einmalig |
| Benannte Stelle | **entfällt** bei Standardprodukten |
| Laufend: Updates, Schwachstellen-Monitoring, Meldebereitschaft | Arbeitszeit über den gesamten Support-Zeitraum |

Kursierende Schätzungen von 20.000–60.000 € (IoT-Geräte, Selbstbewertung) bis
200.000–500.000 € (Firewall mit benannter Stelle) betreffen Hardware- bzw.
Enterprise-Szenarien — für eine App mit Selbstbewertung liegt der realistische
Aufwand deutlich darunter und besteht fast vollständig aus eigener Arbeitszeit.

## Abgrenzung: CE ≠ MiCA

Die CE-Kennzeichnung (Produkt-/Cybersicherheit) ist unabhängig von der Frage
der **Kryptoverwahrung**. Betreibst du Orange-Bar **custodial**
(`ORANGE_CUSTODIAL_MODE=1`) als Dienst für Dritte, drohen **MiCA/CASP-Pflichten**
(Zulassung, Eigenkapital, AML/KYC) — siehe [CUSTODIAL.md](CUSTODIAL.md). Im
non-custodial Default-Modus stellt sich diese Frage regelmäßig nicht.

## Checkliste (Kurzfassung)

- [ ] Produkt/Dienst-Einordnung und Kommerzialität geklärt
- [ ] Risikobewertung dokumentiert
- [ ] Anhang-I-Anforderungen umgesetzt (Gesamt-App, nicht nur Wallet-Teil)
- [ ] SBOM automatisiert erzeugt, `SECURITY.md`/Disclosure-Policy veröffentlicht
- [ ] Update-Mechanismus + Support-Zeitraum festgelegt und kommuniziert
- [ ] Meldeprozess (24 h/72 h) steht — **spätestens 11.09.2026**
- [ ] Technische Dokumentation (Anhang VII) vollständig, 10 Jahre archiviert
- [ ] EU-Konformitätserklärung (Anhang V) ausgestellt
- [ ] CE-Zeichen auf Konformitätserklärung + Produktseite — **spätestens 11.12.2027**
