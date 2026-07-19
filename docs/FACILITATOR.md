# Orange-Bar Facilitator (x402-artig, verify-only)

**Status:** Minimaler Prototyp.
**Keine Rechtsberatung.** MiCA-/EU-Hinweise sind Orientierung für Betreiber, keine Zusicherung.

Ziel: Ein **Zahlungsempfänger** für Agenten schaffen, der ohne Custody auskommt — die
eigentliche Lücke aus der Agent-Payments-Recherche (kein x402-Facilitator für IOTA,
kaum Merchants, die IOTA annehmen).

---

## 1. Leitprinzip

> Der Facilitator **bewegt nie Assets**. Der Zahler (Agent-Station, siehe
> `docs/AGENT_ARCHITECTURE.md`) signiert und sendet die Zahlung **selbst direkt** an
> die Merchant-Adresse. Der Facilitator liest danach nur die Chain und bestätigt, ob
> die Zahlung zu den geforderten Bedingungen (Adresse, Betrag, Netzwerk) passt.

Diese Architektur ist bewusst so gewählt, um **nicht** unter die MiCA-CASP-Kategorie
„Transfer-Service" (Art. 3(1)(26) MiCAR: *Übertragung von Krypto-Assets im Namen
eines Dritten*) zu fallen — der Facilitator überträgt nichts im Namen eines Dritten,
er verifiziert nur. Eine Variante mit Pool/Escrow (Facilitator zahlt aus eigenem
Bestand aus und rechnet später ab) wäre Custody + Transfer-Service und damit
CASP-pflichtig; das ist hier **nicht** implementiert.

**Gebührenmodell:** Falls ein Betreiber Gebühren erhebt, sollte das eine flache
Infra-/API-Gebühr sein, keine vom Zahlungsvolumen abhängige Provision — siehe
Begründung im Chat-Verlauf zur regulatorischen Einordnung. Diese Implementierung
erhebt selbst keine Gebühr.

**Kein Präzedenzfall:** Für x402-artige Facilitator gibt es noch keine
Aufsichtsentscheidung. Vor echtem Merchant-Traffic mit echtem Wert: rechtlich prüfen
lassen.

---

## 2. Ablauf (angelehnt an x402)

```
Agent (LLM)                Merchant/Resource-Server         Facilitator (Orange-Bar)
    │  GET /resource                │                              │
    │───────────────────────────────▶                              │
    │                                │  legt Einmal-Challenge an    │
    │                                │──────────────────────────────▶
    │  402 Payment Required         │                              │
    │  { accepts: [{ payTo,        │                              │
    │    amountNanos (+Jitter),    │                              │
    │    network, challengeId }] } │                              │
    │◀───────────────────────────────                              │
    │                                │                              │
    │  zahlt via Agent-Station      │                              │
    │  (station_pay) DIREKT an      │                              │
    │  payTo, EXAKTER Betrag —      │                              │
    │  eigene Signatur              │                              │
    │───────────────────────────────────────────────────────────────▶ (on-chain)
    │                                │                              │
    │  GET /resource                │                              │
    │  X-Payment-Digest: <digest>   │                              │
    │  X-Payment-Challenge: <id>    │                              │
    │───────────────────────────────▶                              │
    │                                │  settleChallenge(id, digest) │
    │                                │──────────────────────────────▶
    │                                │◀── { success: true } ────────
    │  200 OK + Inhalt              │                              │
    │◀───────────────────────────────                              │
```

Der Agent zahlt **nicht** über den Facilitator — er zahlt direkt an die
Merchant-Adresse (z. B. per MCP-Tool `station_pay`), der Facilitator prüft danach
nur den fertigen Zahlungsbeleg (Tx-Digest) **gegen genau die Challenge, die zu
dieser 402-Antwort gehört** (Details → § 5).

---

## 3. API

### Facilitator (`/api/facilitator/*`, für Merchants/Resource-Server)

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/facilitator/supported` | Unterstützte Netzwerke/Assets (`iota:testnet` …) |
| `POST` | `/api/facilitator/verify` | Prüft eine Zahlung, **ohne** den Beweis zu verbrauchen (kein Challenge-Bezug) |
| `POST` | `/api/facilitator/challenge` | Legt eine Einmal-Challenge für eine konkrete Zahlungsanfrage an |
| `POST` | `/api/facilitator/settle` | Mit `challengeId`: race- und front-running-sicher (empfohlen). Ohne: alter, einfacher Pfad (siehe Warnhinweis unten) |

**Body `/verify`** (unverändert, ohne Challenge-Bezug):

```json
{
  "network": "testnet",
  "digest": "<tx-digest>",
  "payTo": "0x…",
  "amountNanos": "10000000",
  "resource": "/api/premium-data"
}
```

`/verify` → `{ "isValid": true }` oder `{ "isValid": false, "error": "…", "code": "…" }`
(Fehlercodes: `address`, `amount`, `digest`, `notfound`, `status`, `nomatch`).

**Body `/challenge`:**

```json
{ "network": "testnet", "payTo": "0x…", "amountNanos": "10000000", "resource": "/api/premium-data" }
```

→ `{ "challengeId": "pc_…", "network": "testnet", "payTo": "0x…", "amountNanos": "10000037", "resource": "…", "expiresAt": 1730000000000 }`

Der zurückgegebene `amountNanos` weicht bewusst leicht (< 0,001 IOTA) vom
angefragten Grundbetrag ab — das ist der Anti-Front-Running-Mechanismus, siehe § 5.
Der Zahler muss **exakt** diesen Betrag zahlen, nicht den ursprünglich angefragten.

**Body `/settle` (empfohlen, mit Challenge):**

```json
{ "challengeId": "pc_…", "digest": "<tx-digest>" }
```

**Body `/settle` (Legacy, ohne Challenge):**

```json
{ "network": "testnet", "digest": "<tx-digest>", "payTo": "0x…", "amountNanos": "10000000", "resource": "…" }
```

> ⚠️ Der Legacy-Pfad ohne `challengeId` prüft nur Adresse/Betrag/Digest — **ohne**
> Schutz vor Digest-Front-Running (§ 5). Nur verwenden, wenn der Merchant selbst
> eine gleichwertige Bindung an die konkrete Anfrage umsetzt (z. B. eigene
> Session-/Nonce-Logik). Für alles andere: `/challenge` + `/settle` mit
> `challengeId`, oder direkt `server/paywall.js` (macht das automatisch).

`/settle` → `{ "success": true, "digest": "…", "network": "testnet" }` oder Fehler
mit Code `replay` (409, Digest bzw. Challenge schon verbraucht), `challenge` (400,
unbekannte/fremde `challengeId`), `expired` (400), `amount` (400, Gutschrift trifft
nicht exakt den Challenge-Betrag), `notfound`/`status`/`nomatch` (Chain-Prüfung).

### Merchant-Middleware (`server/paywall.js`)

Für eigene Node/Express-Routen, die selbst zum Merchant werden wollen:

```js
import { paywall } from './server/paywall.js';

app.get('/api/premium-data', paywall({
  network: 'testnet',
  payTo: '0x…',          // eigene Merchant-Adresse
  amountNanos: '10000000', // Grundpreis – die tatsächliche Forderung pro Anfrage
  resource: '/api/premium-data', // bekommt automatisch einen Mikro-Jitter (§ 5)
}), (req, res) => {
  res.json({ data: '…' }); // req.payment enthält digest/network/resource
});
```

Ohne gültige `X-Payment-Digest`/`X-Payment-Challenge`-Header antwortet die Route
mit `402` und einer frischen Einmal-Challenge; mit gültigem, zu dieser Challenge
passendem Beweis lässt sie durch. Die Front-Running-Bindung passiert hier
automatisch — kein Zutun des Merchant-Codes nötig.

### Demo-Route

`GET /api/facilitator/demo/resource` ist nur aktiv, wenn `ORANGE_FACILITATOR_DEMO_PAYTO`
gesetzt ist (siehe `.env.example`). Zeigt den vollen Flow gegen eine echte,
selbst konfigurierte Empfänger-Adresse.

---

## 4. MCP-Tool für Agenten

`pay_for_resource(url, stationId?)` (siehe `mcp/orange-bar-mcp.js`):

1. `GET url`
2. Bei `402` → Zahlungsanforderungen (inkl. `challengeId` und dem exakt zu
   zahlenden `amountNanos`) aus `accepts[0]` lesen
3. `station_pay` aus der Agent-Station an `payTo`, exakt der geforderte Betrag
4. `GET url` erneut mit `X-Payment-Digest: <digest>` und, falls vorhanden,
   `X-Payment-Challenge: <challengeId>`
5. Antwort zurückgeben

Damit kann ein Agent **eigenständig** eine reale, bezahlpflichtige Ressource
konsumieren — Scope `station_spend` vorausgesetzt (siehe
`docs/AGENT_ARCHITECTURE.md`, Stufe C).

---

## 5. Replay-Schutz **und** Front-Running-Schutz

Zwei getrennte Probleme, zwei getrennte Mechanismen:

**a) Replay (derselbe Beweis zweimal einlösen).** Jeder Tx-Digest verbraucht sich
über `/settle` **genau einmal** (`facilitator_receipts`, `digest` als
`PRIMARY KEY`). Auch bei gleichzeitigen Anfragen mit demselben Digest gewinnt nur
ein `INSERT`, bevor irgendetwas ausgeliefert wird.

**b) Digest-Front-Running (ein Dritter löst den Beweis eines anderen ein).**
Ein Tx-Digest ist öffentlich, sobald die Zahlung on-chain bestätigt ist — jeder,
der die Merchant-Adresse beobachtet, kann ihn lesen. Ohne weitere Bindung würde
„gültiger, noch nicht verbrauchter Digest passend zu Adresse+Betrag" genügen, um
eine Ressource freizuschalten — **unabhängig davon, wer tatsächlich gezahlt hat**.
Ein Angreifer könnte so den öffentlich sichtbaren Zahlungsbeweis eines fremden,
echten Zahlers abgreifen und schneller einlösen als dieser selbst; der Merchant
bekommt sein Geld trotzdem, aber die Ressource geht an den Falschen, während der
ehrliche Zahler `409 replay` bekommt.

Da IOTA-Überweisungen kein On-Chain-Memo-Feld haben, in dem eine Anfrage-ID
mitgeschickt werden könnte, löst Orange-Bar das über **Einmal-Challenges**
(`facilitator_challenges`, seit diesem Fix):

1. Jede `402`-Antwort erzeugt eine neue Challenge mit einer Einmal-`challengeId`
   **und** einem Betrag, der einen zufälligen Mikro-Aufschlag (< 0,001 IOTA) über
   dem Grundpreis bekommt (`createPaymentChallenge`, `server/facilitator.js`).
2. `/settle` mit `challengeId` verlangt eine **exakte** Übereinstimmung mit genau
   diesem (leicht einzigartigen) Betrag — nicht nur „mindestens", wie `/verify`
   es sonst zulässt.
3. Ein Digest, der zufällig zu Adresse+Grundpreis passt, aber für eine ANDERE
   Challenge bezahlt wurde, trifft den exakten Betrag dieser Challenge mit
   verschwindender Wahrscheinlichkeit nicht — ein Angreifer müsste zusätzlich die
   konkrete `challengeId` kennen, die nur an den ursprünglichen Requester der
   `402`-Antwort ausgegeben wurde.
4. Die Challenge selbst wird ebenfalls genau einmal verbraucht (bedingtes
   `UPDATE … WHERE consumed_at IS NULL`, race-sicher nach demselben Muster wie die
   Agent-Stations-Zahlungen seit v1.1.1).

**Restrisiko, bewusst in Kauf genommen:** Bei extrem hoher Parallelität könnten
zwei gleichzeitig offene Challenges zum selben Grundpreis theoretisch denselben
Mikro-Aufschlag ziehen (Kollisionswahrscheinlichkeit bei < 1e6 möglichen Werten
für wenige gleichzeitige Challenges praktisch vernachlässigbar). Der
Legacy-Pfad `/settle` **ohne** `challengeId` (§ 3) hat diesen Schutz nicht —
bewusst dokumentierte Ausnahme für Merchants mit eigener Bindung, nicht der
empfohlene Standardweg.

`/verify` bleibt reine Vorabprüfung ohne Challenge-Bezug und ohne Verbrauchs­effekt
— ein Merchant kann damit z. B. clientseitig eine Vorschau zeigen.

---

## 6. Grenzen dieses Prototyps

- **Nur IOTA-Coin**, kein Stablecoin — Beträge sind volatil (siehe Recherche zu
  fehlendem Stablecoin-Mainnet-Stand).
- **Kein Netzwerk-übergreifendes Matching**: Agent-Station und Merchant müssen im
  selben IOTA-Netzwerk sein (`network`-Feld muss übereinstimmen).
- **Kein Preloading/Streaming großer Beträge** — für Micropayments pro Request
  gedacht, nicht für Abo-Modelle.
- **Kein eigenes Fee-/Settlement-Ledger** für den Merchant — die Zahlung landet
  direkt in dessen Wallet, Orange-Bar führt nur das Replay-Log.
- **Legacy-`/settle` ohne `challengeId`** hat keinen Front-Running-Schutz (§ 5) —
  bewusst so belassen für Merchants mit eigener Bindung, aber nicht der
  empfohlene Weg. `server/paywall.js` und `/challenge`+`/settle` mit
  `challengeId` schließen die Lücke automatisch.
- **Kein On-Chain-Memo/Nonce-Feld verfügbar** (IOTA-Transfers kennen so etwas
  nicht) — die Challenge-Bindung läuft deshalb über einen quasi-eindeutigen
  Mikro-Betrag statt über eine im Transfer selbst mitgeführte Kennung. Sobald
  Phase 4 (`docs/AGENT_STATION_ONCHAIN.md`) real läuft, könnte `spend()` eine
  Nonce als Move-Call-Argument entgegennehmen und im `Spent`-Event emittieren —
  eine sauberere, nicht auf Beitrags-Jitter angewiesene Bindung. Nicht
  umgesetzt, da Phase 4 selbst noch unkompiliert/undeployed ist.

---

## 7. Ideen — momentan nicht verfolgt

Nur festgehalten, damit sie nicht verloren geht. Kein aktuelles Arbeitsziel, keine
Zusage, dass das passiert.

- **TWIN/TLIP-Andockung:** Die IOTA Foundation betreibt mit **TWIN** (vormals TLIP,
  „Trade Worldwide Information Network") 2026 ein produktives Handels-/Logistik-
  Datenaustausch-Projekt (Piloten Kenia/Nigeria/Marokko, UK-Frachttests, Partner
  AfCFTA/WEF/Tony Blair Institute). Grundidee für später: ein Digital Twin (z. B.
  Container, Sendung) meldet einen Statuswechsel und löst darüber automatisch eine
  Zahlung an einen Dienstleister aus — oder ein Datensatz/Zertifikat wird nur gegen
  einen verifizierten Zahlungsbeweis freigegeben (gleiches Verify/Settle-Muster wie
  hier). Voraussetzung, bevor das ernsthaft verfolgt würde: Kontakt zur IOTA
  Foundation/den TWIN-Betreibern, Klärung ob TWIN überhaupt eine
  Monetarisierungs-/Zahlungsschicht vorsieht (öffentlich nicht bestätigt), und eine
  deutlich höhere Audit-/Compliance-Tiefe als dieser Prototyp — TWIN hängt an
  echten Zoll-/Handelsdaten mit Regierungsbeteiligung, das ist eine andere
  Vertrauensebene als ein selbst betriebener Facilitator.

---

*English summary: A minimal, non-custodial x402-style facilitator for IOTA. The payer
signs and sends directly to the merchant address (via the Agent Station); the
facilitator only reads the chain via digest and confirms/consumes the payment proof
once. This avoids MiCA's CASP "transfer service" category since the facilitator never
moves assets on anyone's behalf. Endpoints: `GET /api/facilitator/supported`,
`POST /api/facilitator/verify`, `POST /api/facilitator/challenge`,
`POST /api/facilitator/settle`; merchant middleware in `server/paywall.js`; agent-side
MCP tool `pay_for_resource`. No case law exists yet for this pattern — get real legal
review before production use with real value.*

*Fix note: the initial version bound proof-of-payment only to (payTo, amount),
which let a third party who merely observed a payer's already-public, confirmed
tx digest race to redeem someone else's payment for a paywalled resource before
the actual payer did ("digest front-running") — the merchant still got paid, but
the wrong party could get the resource. Fixed by one-time payment challenges
(`facilitator_challenges`): each `402` issues a unique `challengeId` and a
micro-jittered exact amount, and settlement requires an exact match against that
specific, single-use challenge — see § 5.*
