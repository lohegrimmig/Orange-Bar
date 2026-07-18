# Orange-Bar × KI-Agenten — Architektur

**Status:** Phase 1–3 implementiert (Propose, Policies/PWA, Agent-Station).  
**Keine Rechtsberatung.** MiCA-/EU-Hinweise sind Orientierung für Betreiber.

Ziel: KI-Agenten (Cursor, Bots, Game-AI) können mit Orange-Bar **problemlos agieren**, ohne die Non-Custodial-Linie und die Passkey-Bestätigung pro Ausgabe zu brechen.

---

## 1. Leitprinzip (Compliance-first)

> **Agenten erlangen nie die Kontrolle über Nutzer-Krypto.**  
> Sie dürfen nur **vorschlagen** (Pay-Requests) und **lesen**, oder — später — aus einem **klar getrennten Betreiber-Float** (Agent-Station) zahlen.  
> Jede Bewegung aus dem User-Wallet braucht weiterhin **frische WebAuthn-Bestätigung**.

Das entspricht dem bestehenden In-Game-SDK und vermeidet MiCA-CASP-Verwahrung für Nutzer-Wallets (vgl. `docs/CUSTODIAL.md`).

---

## 2. Stufenmodell

| Stufe | Name | Agent darf | Wer signiert | MiCA-Lage (Orientierung) |
|---|---|---|---|---|
| **A** | Propose | Balance lesen, Pay-Request anlegen, Status pollen | User per Passkey | Grün — keine Verwahrung |
| **B** | Policy-Propose | wie A + Limits/Allowlist/Ablauf am Token | User per Passkey | Grün — Delegation nur als Vorschlag |
| **C** | Station | aus **Betreiber**-Float zahlen (Barkeeper-ähnlich) | Server mit Stations-Key | Grün *nur* bei Eigenmitteln / klarer Eigentumstrennung; Rot bei User-Pre-Funding auf Server-Wallet |

**Nicht vorgesehen:** Session-Keys auf dem User-Wallet, stilles Signieren, PRF-/Seed-Zugriff für Agenten.

---

## 3. Zielarchitektur

```
KI-Agent (Cursor / Bot / Script)
        │  Bearer Token (oba_…)
        ▼
┌────────────────────────────┐
│  Agent Gateway             │
│  REST /api/agent/*         │
│  MCP (stdio → REST)        │
│  Scopes: read, pay_request │
└────────────┬───────────────┘
             │
      ┌──────┴──────┐
      ▼             ▼
  Pay-Request    User-PWA
  (SQLite)       (WebAuthn)
```

Stufe C (später) hängt parallel an Barkeeper/Gas-Stationen — **nicht** am User-Key.

---

## 4. Phasenplan

### Phase 1 — Propose ✅

| Baustein | Beschreibung |
|---|---|
| `agent_tokens` | Scoped Bearer-Tokens, nur Hash in DB (`oba_…`) |
| Session-API | Token listen / widerrufen (eingeloggter User) |
| Agent-API | `GET …/wallet/summary`, `POST …/pay/request`, `GET …/pay/request/:id` |
| Soft-Policies | `maxAmountNanos`, `allowedTo[]`, TTL |
| MCP | `mcp/orange-bar-mcp.js` — Tools über REST, kein Schlüsselzugriff |
| CORS | `/api/agent` mit `Authorization` für Cross-Origin-Clients |

### Phase 2 — Policy & UX ✅

| Baustein | Beschreibung |
|---|---|
| WebAuthn-Mint | `POST /tokens/prepare` → Passkey → `POST /tokens/confirm` |
| Härtere Policies | Tageslimit (`dailyLimitNanos`), `projectId`, `networkLock` |
| Usage | `agent_usage` pro UTC-Tag; in Token-Liste als `todayUsedNanos` |
| Push | bei Pay-Request: „Agent X will … senden“ (best effort) |
| PWA | Settings → Agenten: anlegen, QR/Copy einmalig, widerrufen |

Direkter `POST /tokens` ohne Passkey → `400 passkey-required`.

### Phase 3 — Agent-Station ✅

| Baustein | Beschreibung |
|---|---|
| `agent_stations` | Separates Hot-Wallet-Float (Adresse ≠ User-Wallet) |
| WebAuthn-Create | `POST /stations/prepare` → Passkey → `/confirm` |
| Aufladen | Normale User-Überweisung an Stations-Adresse (Passkey) |
| Agent-Pay | `POST /api/agent/station/pay` mit Scope `station_spend` |
| Policies | Max/Tag/Allowlist an Station **und** Token; optional `stationId`-Bindung |
| Ledger | `agent_station_payments` + `agent_station_usage` |
| MCP | `list_stations`, `station_pay` |

**MiCA-Hinweis:** Station-Schlüssel liegen auf dem Server (wie Barkeeper-Gas). Das ist ein **Betriebs-Float des Kontoinhabers**, nicht die Passkey-/PRF-User-Wallet. Self-Hoster: eigenes Float. Multi-Tenant-Hosting für Dritte mit Einzahlung auf serverkontrollierte Adressen → CASP-Risiko prüfen.

---

## 5. API-Oberfläche

### Session (Cookie `ob_session`)

| Methode | Pfad | Zweck |
|---|---|---|
| `POST` | `/api/agent/tokens/prepare` | Optionen prüfen + WebAuthn-Challenge |
| `POST` | `/api/agent/tokens/confirm` | Passkey prüfen → Token (Klartext **nur einmal**) |
| `GET` | `/api/agent/tokens` | Liste (ohne Secrets) |
| `DELETE` | `/api/agent/tokens/:id` | Widerruf |

**Body `POST /tokens/prepare` (Beispiel):**

```json
{
  "label": "Cursor Agent",
  "scopes": ["read", "pay_request"],
  "ttlSeconds": 2592000,
  "maxAmountNanos": "1000000000",
  "dailyLimitNanos": "5000000000",
  "networkLock": "testnet",
  "projectId": "proj_…",
  "allowedTo": ["0xabc…"]
}
```

Dann Client: `getPasskeyAssertion(options)` → `POST /tokens/confirm` mit `{ challengeId, response }`.
### Agent (Header `Authorization: Bearer oba_…`)

| Methode | Pfad | Scope |
|---|---|---|
| `GET` | `/api/agent/wallet/summary` | `read` |
| `POST` | `/api/agent/pay/request` | `pay_request` |
| `GET` | `/api/agent/pay/request/:id` | `read` oder `pay_request` |
| `GET` | `/api/agent/stations/list` | `read` oder `station_spend` |
| `POST` | `/api/agent/station/pay` | `station_spend` |

Scopes: `read`, `pay_request`, `station_spend`.

Pay-Request-Body wie SDK: `{ "to", "amountNanos", "memo?", "projectId?" }`.  
Zusätzlich greifen Token-Limits (`maxAmountNanos`, `dailyLimitNanos`, `allowedTo`, `networkLock`, `projectId`).

Station-Pay-Body: `{ "to", "amountNanos", "stationId?", "memo?", "idempotencyKey?" }`. Tageslimits (Station **und** Token) werden race-sicher in einer einzigen synchronen DB-Transaktion geprüft und reserviert, bevor die On-Chain-Sendung startet (siehe § 7). `idempotencyKey`: derselbe Wert bei einem Retry (Timeout, Netzwerkfehler) liefert das Ergebnis des ersten Versuchs zurück, statt eine zweite Zahlung auszulösen — Antwort dann mit `replay: true`.

---

## 6. MCP-Tools

Env: `ORANGE_BAR_URL`, `ORANGE_BAR_AGENT_TOKEN`

| Tool | Beschreibung |
|---|---|
| `get_balance` | Adresse, Netzwerk, Balance (User-Wallet) |
| `create_payment` | Pay-Request anlegen → User bestätigt in PWA |
| `get_payment_status` | Status / txDigest |
| `list_stations` | Agent-Stationen + Float-Guthaben |
| `station_pay` | Zahlung aus Stations-Float (Scope `station_spend`) |

Kein Tool zum Signieren der User-PRF-Wallet oder Key-Export.

Cursor-Beispiel (`mcp.json`):

```json
{
  "mcpServers": {
    "orange-bar": {
      "command": "node",
      "args": ["mcp/orange-bar-mcp.js"],
      "env": {
        "ORANGE_BAR_URL": "https://wallet.example.com",
        "ORANGE_BAR_AGENT_TOKEN": "oba_…"
      }
    }
  }
}
```

---

## 7. Sicherheitsmodell

| Kontrolle | Wirkung |
|---|---|
| Token nur gehasht (SHA-256) | Leak der DB ≠ sofort nutzbare Secrets |
| Scopes | Least Privilege |
| TTL + Revoke | Begrenzte Exposition |
| Optional Amount/Allowlist | Fehlverhalten des Agents begrenzt |
| Kein Sign-Endpoint | Human-in-the-loop bleibt erzwungen |
| Rate-Limit auf Token-Mint & Agent-Pay | Missbrauch dämpfen |
| Race-sichere Tageslimit-Reservierung (Station-Pay) | Prüfung + Buchung laufen in einer synchronen Transaktion vor der On-Chain-Sendung; zwei parallele Requests können das Limit nicht gemeinsam überschreiten. Fehlgeschlagene Sendung bucht die Reservierung zurück. |
| Idempotency-Key auf `station/pay` | Ein Agent-Retry nach Timeout/Fehler zahlt nicht doppelt aus dem Float — gleicher Key liefert das Ergebnis des ersten Versuchs. |

---

## 8. MiCA / EU (Kurz)

| Design | Einschätzung |
|---|---|
| Stufe A/B | Keine Nutzer-Verwahrung; Agent steuert nur Requests |
| Stufe C Eigen-Float | Wie Barkeeper-Gas — separates Betriebs-Wallet des Kontoinhabers |
| Dritte laden auf eure serverkontrollierte Station | **CASP-Risiko** — für Multi-Tenant prüfen |
| Custodial-User-Wallet + Agent-Signing | Explizit gewarnt in `docs/CUSTODIAL.md` |

Weitere Themen für Betreiber: DSGVO (Token-Metadaten, Logs), Impressum/AGB („was ein Agent darf“), ggf. AI Act für den **Agent-Betreiber**.

---

## 9. Dateien

| Pfad | Rolle |
|---|---|
| `docs/AGENT_ARCHITECTURE.md` | Dieser Plan |
| `server/db.js` | Migration `agent_tokens` |
| `server/agent.js` | Token create/verify/revoke, Policy-Check |
| `server/agent-station.js` | Station create/pay/policy |
| `server/routes/agent.js` | REST inkl. Station |
| `mcp/orange-bar-mcp.js` | MCP → REST |
| `tests/agent.test.js` / `tests/agent-station.test.js` | Unit-Tests |

---

## 10. Abnahmekriterien

### Phase 1
1. User kann Agent-Tokens listen und widerrufen.  
2. Agent mit Token liest Summary und legt Pay-Request an.  
3. Pay-Request ohne gültigen Token oder ohne Scope → 401/403.  
4. Betrag über `maxAmountNanos` oder fremde `to`-Adresse → 403.  
5. MCP-Tools rufen dieselben Endpunkte auf; kein Signing.  

### Phase 2
1. Token-Mint nur nach erfolgreicher WebAuthn-Assertion.  
2. Tageslimit / Netzwerk-Lock / Projekt-Bindung werden enforced.  
3. PWA zeigt Agenten-Liste, Einmal-Reveal (QR+Copy), Widerruf.  
4. Push bei neuem Agent-Pay-Request (wenn Abo aktiv).  

### Phase 3
1. Station-Create nur mit Passkey; Adresse ≠ User-Wallet.  
2. `station_pay` ohne Scope / gegen Policy → 403.  
3. Token-`stationId`-Bindung greift.  
4. MCP `station_pay` / `list_stations` verfügbar.  

---

*English summary: Orange-Bar Agent Layer is propose-only (Phase 1): scoped bearer tokens, read + pay-request APIs, MCP bridge. Users still confirm every spend with WebAuthn. No agent access to keys — MiCA custody risk stays aligned with non-custodial default.*
