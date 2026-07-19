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
    │  402 Payment Required         │                              │
    │  { accepts: [{ payTo,        │                              │
    │    amountNanos, network }] } │                              │
    │◀───────────────────────────────                              │
    │                                │                              │
    │  zahlt via Agent-Station      │                              │
    │  (station_pay) DIREKT an      │                              │
    │  payTo — eigene Signatur      │                              │
    │───────────────────────────────────────────────────────────────▶ (on-chain)
    │                                │                              │
    │  GET /resource                │                              │
    │  X-Payment-Digest: <digest>   │                              │
    │───────────────────────────────▶                              │
    │                                │  POST /settle                │
    │                                │  { network, digest, payTo,  │
    │                                │    amountNanos, resource }  │
    │                                │──────────────────────────────▶
    │                                │◀── { success: true } ────────
    │  200 OK + Inhalt              │                              │
    │◀───────────────────────────────                              │
```

Der Agent zahlt **nicht** über den Facilitator — er zahlt direkt an die
Merchant-Adresse (z. B. per MCP-Tool `station_pay`), der Facilitator prüft danach
nur den fertigen Zahlungsbeleg (Tx-Digest).

---

## 3. API

### Facilitator (`/api/facilitator/*`, für Merchants/Resource-Server)

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/facilitator/supported` | Unterstützte Netzwerke/Assets (`iota:testnet` …) |
| `POST` | `/api/facilitator/verify` | Prüft eine Zahlung, **ohne** den Beweis zu verbrauchen |
| `POST` | `/api/facilitator/settle` | Prüft **und verbraucht** den Beweis (einmalig, Replay-Schutz) |

**Body `/verify` und `/settle`:**

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

`/settle` → `{ "success": true, "digest": "…", "network": "testnet" }` oder
`409 { "success": false, "code": "replay" }`, falls der Digest schon einmal
verrechnet wurde.

### Merchant-Middleware (`server/paywall.js`)

Für eigene Node/Express-Routen, die selbst zum Merchant werden wollen:

```js
import { paywall } from './server/paywall.js';

app.get('/api/premium-data', paywall({
  network: 'testnet',
  payTo: '0x…',          // eigene Merchant-Adresse
  amountNanos: '10000000',
  resource: '/api/premium-data',
}), (req, res) => {
  res.json({ data: '…' }); // req.payment enthält digest/network
});
```

Ohne `X-Payment-Digest`-Header antwortet die Route mit `402` und den
Zahlungsanforderungen; mit gültigem, noch nicht verbrauchtem Digest lässt sie durch.

### Demo-Route

`GET /api/facilitator/demo/resource` ist nur aktiv, wenn `ORANGE_FACILITATOR_DEMO_PAYTO`
gesetzt ist (siehe `.env.example`). Zeigt den vollen Flow gegen eine echte,
selbst konfigurierte Empfänger-Adresse.

---

## 4. MCP-Tool für Agenten

`pay_for_resource(url, stationId?)` (siehe `mcp/orange-bar-mcp.js`):

1. `GET url`
2. Bei `402` → Zahlungsanforderungen aus `accepts[0]` lesen
3. `station_pay` aus der Agent-Station an `payTo`
4. `GET url` erneut mit `X-Payment-Digest: <digest>`
5. Antwort zurückgeben

Damit kann ein Agent **eigenständig** eine reale, bezahlpflichtige Ressource
konsumieren — Scope `station_spend` vorausgesetzt (siehe
`docs/AGENT_ARCHITECTURE.md`, Stufe C).

---

## 5. Replay-Schutz

Jeder Tx-Digest verbraucht sich über `/settle` **genau einmal**
(`facilitator_receipts`, `digest` als `PRIMARY KEY`). Ein Zahlungsbeleg kann also
nicht zweimal eine Ressource freischalten — auch nicht bei gleichzeitigen Anfragen
(der zweite `INSERT` schlägt fehl, bevor etwas ausgeliefert wird).

`/verify` ist reine Vorabprüfung ohne diesen Effekt — ein Merchant kann damit
z. B. clientseitig eine Vorschau zeigen, bevor er `/settle` aufruft.

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
`POST /api/facilitator/verify`, `POST /api/facilitator/settle`; merchant middleware in
`server/paywall.js`; agent-side MCP tool `pay_for_resource`. No case law exists yet for
this pattern — get real legal review before production use with real value.*
