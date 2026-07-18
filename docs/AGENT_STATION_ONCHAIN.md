# Orange-Bar Agent-Station — On-Chain Enforcement (Phase 4, Entwurf)

**Status:** Architektur-Entwurf + Move-Modul-Skizze (`move/agent_station/`). **Nicht kompiliert**
(kein IOTA-Move-Toolchain in dieser Umgebung verfügbar), **nicht deployed**, **nicht in den
Server verdrahtet**. Keine Rechtsberatung.

Vorgänger: `docs/AGENT_ARCHITECTURE.md` Phase 3 (Agent-Station als serverseitiges Hot-Wallet-Float,
Limits in SQLite). Dieses Dokument beschreibt eine optionale, stärkere Variante derselben Station.

---

## 1. Welches Problem das löst — und welches nicht

**Heutiger Zustand (Phase 3):** Die Agent-Station ist ein Ed25519-Keypair, verschlüsselt in
SQLite. Ob ein `station_pay`-Aufruf das Tageslimit respektiert, entscheidet ausschließlich
`server/agent-station.js`. **Wer den Master-Key und die DB in die Hand bekommt, kann die Prüfung
umgehen und das komplette Float in einer einzigen Transaktion abräumen** — die Policy ist reiner
Anwendungscode, kein Bestandteil der Zahlung selbst.

**Mit Phase 4:** Das Guthaben der Station liegt nicht mehr als frei bewegbarer `Coin`, sondern als
`Balance<IOTA>` **innerhalb eines Move-Objekts**. Eine `Balance` kann — anders als ein Coin — nicht
dadurch bewegt werden, dass jemand den privaten Schlüssel der besitzenden Adresse kennt; sie
verlässt das Objekt ausschließlich über die `entry`-Funktionen des Moduls. Diese Funktionen prüfen
`max_per_tx`, `epoch_limit` und Allowlist **on-chain**, durchgesetzt von jedem Validator bei der
Ausführung — nicht von eurem Node-Prozess.

**Was dadurch NICHT verschwindet:** Wer den privaten Schlüssel des Servers (den Halter der
`SpendCap`) stiehlt, kann weiterhin `spend()` aufrufen — nur eben **nur** innerhalb von
`max_per_tx`/`epoch_limit`, wieder und wieder, epochenweise, bis der Nutzer es bemerkt und
`admin_set_paused(true)` oder einen Cap-Revoke auslöst. Das ist eine **Reduktion des Blast-Radius
von „gesamtes Float, ein Schlag" auf „begrenzter, öffentlich sichtbarer, stoppbarer Leak pro
Epoche"** — kein „unmöglich zu stehlen". Diese Präzisierung ist bewusst: die letzte Fassung dieser
Idee (als „Verifiable Credential") hätte das Geld gar nicht gebunden; hier bindet es tatsächlich
die Bewegung der Mittel, nicht nur eine Behauptung darüber.

**Was sich NICHT ändert:** Die MiCA-Einordnung bleibt wie in `AGENT_ARCHITECTURE.md` § 8 — es ist
weiterhin ein **Betreiber-Float** (Eigenmittel des Kontoinhabers), nur technisch härter
durchgesetzt. Phase 4 ist eine Sicherheits-, keine Compliance-Maßnahme.

---

## 2. Objektmodell

```
AgentStation (shared object)
  ├─ balance: Balance<IOTA>         ← Geld lebt HIER, nicht an einer Adresse
  ├─ max_per_tx, epoch_limit, epoch_length_ms, spent_this_epoch
  ├─ allowlist: VecSet<address>, allowlist_enabled
  └─ paused: bool

SpendCap (owned von Server-/Agent-Adresse)
  └─ station_id  → erlaubt NUR spend() auf dieser Station

AdminCap (owned von der User-Passkey-/PRF-Adresse — der Server bekommt sie NIE)
  └─ station_id  → erlaubt admin_set_limits / admin_set_allowlist /
                    admin_set_paused / admin_withdraw
```

`spend()` ist der **einzige** Weg, Geld aus `balance` herauszuholen, außer `admin_withdraw()` (nur
mit `AdminCap`). Wer keine der beiden Caps besitzt, kann überhaupt nichts abheben — das ist eine
Eigenschaft des Move-Typsystems (die Funktionen verlangen die Cap als Parameter), nicht eine
Konvention, an die sich Code halten müsste.

Quelle: [`move/agent_station/sources/agent_station.move`](../move/agent_station/sources/agent_station.move)
(Move 2024 edition, Framework-Importe wie im IOTA-Rebased-Move-Framework üblich — **Pfade/API vor
dem Kompilieren gegen den aktuellen `iota-framework`-Stand verifizieren**, siehe § 8).

---

## 3. Ablauf

### Station anlegen
Der Nutzer signiert (Passkey/PRF, wie beim bestehenden Self-Custody-Signing) eine Transaktion, die
`create_station(max_per_tx, epoch_limit, epoch_length_ms, spend_cap_recipient, clock, ctx)` aufruft.
`spend_cap_recipient` ist die Server-Betriebsadresse. Ergebnis: `AgentStation` (shared), `SpendCap`
an den Server, `AdminCap` an den Nutzer.

### Aufladen
Der Nutzer signiert eine Transaktion, die `deposit(station, coin)` aufruft — technisch ein
Move-Call statt einer einfachen Überweisung an eine Adresse, aber im selben client-seitigen
Signierfluss wie heute (`public/prf.js` + `public/iota-sign.js` bauen bereits Transaktionen für
Self-Custody-Sends; hier wird derselbe Baustein für einen anderen Call-Typ verwendet).

### Autonomes Ausgeben (Agent)
Der Server baut `spend(station, cap, amount, recipient, clock, ctx)`, signiert mit dem
**SpendCap-Schlüssel** (einer eigenen, kleinen Betriebsadresse — **nicht** mehr identisch mit dem
heutigen `agent_stations.key_ciphertext`) und sendet. Braucht zusätzlich eigenes Gas: **die
Balance im Objekt kann nicht als Gas-Coin dienen**, die Server-Adresse braucht also eine separate,
kleine, regelmäßig aufgefüllte Gas-Reserve — ein zusätzlicher operativer Baustein gegenüber Phase 3.

### Policy ändern / Not-Aus / Restguthaben abheben
Nur mit `AdminCap`, die ausschließlich der Nutzer besitzt — jede dieser Aktionen verlangt also eine
frische Passkey-Bestätigung, exakt wie ein normaler Send heute.

---

## 4. Integration mit dem bestehenden System

- Neue Spalte `agent_stations.kind` (`'legacy'` | `'move'`). **Kein Zwangs-Migrationspfad**:
  bestehende Stationen (`legacy`) laufen unverändert mit serverseitiger Policy weiter (Phase 3
  bleibt bestehen — inkl. des Race-/Idempotenz-Fixes aus v1.1.1). Eine Migration wäre ohnehin eine
  Geldbewegung und braucht eine explizite Nutzeraktion (altes Float abheben → neue Station anlegen
  → einzahlen), keinen automatischen Cutover.
- `server/agent-station.js` bekäme einen zweiten Pfad: `payFromStationOnChain()`, der statt
  `sendFromSecret` einen `spend()`-Move-Call signiert und sendet. Die SQLite-Policy-Checks
  (`checkStationPayPolicy`) entfallen für `kind='move'`-Stationen nicht ersatzlos, sondern bleiben
  als **Fast-Fail-Vorprüfung** (bessere Fehlermeldung, spart unnötige Chain-Calls) — die
  **verbindliche** Prüfung ist ab jetzt aber der Move-Call selbst.
- MCP-Tool `station_pay` bleibt nach außen unverändert; welcher Pfad intern läuft, entscheidet
  `agent_stations.kind`.
- Server-seitige Betriebs-Gas-Adresse (Punkt „Autonomes Ausgeben" oben) braucht eigene
  Env-Variable/Verwaltung — analog zur bestehenden Barkeeper-Gas-Station, aber getrennt, da sie
  Transaktionsgebühren zahlt, nicht Nutzer-Guthaben.

---

## 5. Sicherheitsmodell im Vergleich

| Angriff | Phase 3 (heute) | Phase 4 (Entwurf) |
|---|---|---|
| Master-Key + DB geleakt | Kompletter Float-Betrag in einer Transaktion abziehbar | Nur `epoch_limit` pro Rollfenster, wiederholt bis Stop — nie mehr als das konfigurierte Limit auf einen Schlag |
| Zwei parallele `station_pay`-Aufrufe | Race auf das Tageslimit war v1.1.0 der Bug, seit v1.1.1 durch synchrone DB-Transaktion geschlossen | Strukturell unmöglich: die Chain serialisiert konkurrierende Transaktionen auf demselben Shared Object; kein Äquivalent zur SQLite-Race existiert überhaupt |
| Server ändert eigenmächtig Limits/Allowlist | Direkter DB-Write reicht | Braucht `AdminCap` — die der Server nie besitzt; strukturell unmöglich, nicht nur „nicht vorgesehen" |
| Nutzer will sofort stoppen | Token/Station in der PWA deaktivieren (serverseitiger DB-Write) | `admin_set_paused(true)` — eine on-chain-Transaktion, öffentlich nachprüfbar dass sie wirkte |
| Auditierbarkeit der Ausgaben | Nur im eigenen SQLite-Log | Jede `Spent`-/`Deposited`-Emission ist ein öffentliches Chain-Event, von jedem Dritten nachprüfbar |

---

## 6. Offene Punkte / bewusste Tradeoffs

1. **Rollierendes Epochenfenster statt UTC-Kalendertag.** `epoch_length_ms` läuft ab dem letzten
   Reset, nicht ab Mitternacht UTC wie `agent_usage.day` in Phase 3. Andere, aber nicht schlechtere
   Semantik — sollte in der PWA klar kommuniziert werden, damit „Tageslimit" nicht missverstanden wird.
2. **Zusätzliche Gas-Adresse für den Server** (siehe § 3) — ein Betriebsteil mehr, der überwacht
   und aufgefüllt werden muss.
3. **Move-API-Pfade wurden gegen den echten Framework-Quellcode geprüft** (per Fetch der
   Rohdateien aus `iotaledger/iota`, Branch `develop`, siehe § 11 „Quellen"), nicht mehr nur aus dem
   Gedächtnis. Alle verwendeten Signaturen (`balance::zero/join/split/value`,
   `coin::from_balance/into_balance/value/mint_for_testing`, `clock::timestamp_ms/create_for_testing`,
   `object::new/id`, `transfer::transfer/public_transfer/share_object`, `vec_set::empty/from_keys/contains`,
   `event::emit`, `tx_context::sender`, `test_scenario::begin/next_tx/ctx/take_shared/return_shared/
   take_from_sender/return_to_sender/end`) stimmen mit dem Framework-Stand auf `develop` überein;
   das Muster (Shared-Object-Float + AdminCap) entspricht sogar fast 1:1 dem offiziellen
   `examples/move/flash_lender`-Beispiel. **Trotzdem weiterhin ungetestet**, da kein
   Move-Toolchain in dieser Sandbox verfügbar ist (`iota`/`sui`-Binary fehlt) — `iota move build`
   und `iota move test` vor dem ersten echten Einsatz zwingend nachholen, insbesondere weil
   `develop` nicht zwingend dem tatsächlich auf testnet/mainnet laufenden Framework-Stand
   entspricht (dafür ist `rev = "framework/testnet"` im `Move.toml` gedacht, siehe dort).
4. **Skalierung der Allowlist:** `VecSet<address>` ist für kleine Listen (einige Dutzend Adressen)
   günstig; bei sehr großen Allowlists steigen Gas-Kosten für `admin_set_allowlist` linear.
5. **Mehrere Agenten an einer Station:** aktuell eine `SpendCap` pro Station. Eine natürliche
   Erweiterung (Phase 4.1, hier nicht ausgearbeitet) wäre, `max_per_tx`/`epoch_limit`/Allowlist auch
   auf der `SpendCap` selbst zu führen (statt nur auf der Station), sodass mehrere Agenten dasselbe
   Float mit je eigenen, enger geschnittenen Limits nutzen und einzeln widerrufen werden können.
6. **Kein Ersatz für Kill-Switch/Anomalie-Erkennung auf Anwendungsebene** — diese On-Chain-Härtung
   und die in der vorherigen Diskussion vorgeschlagene Injection-resistente Bestätigungs-UX
   (Fakten statt Agenten-Text, ein Tap zum Einfrieren) ergänzen sich, ersetzen sich aber nicht.

---

## 7. MiCA / EU (kurz)

Unverändert gegenüber `AGENT_ARCHITECTURE.md` § 8: weiterhin Betreiber-Eigenmittel, kein
Nutzer-Pre-Funding auf eine dem Server zurechenbare Adresse im rechtlichen Sinn. Die On-Chain-
Kapselung ist eine **Sicherheitsmaßnahme**, kein Argument für eine andere aufsichtsrechtliche
Einordnung — das sollte in Marketing-Texten nicht vermischt werden.

---

## 8. Vor Produktiveinsatz (Abnahmekriterien)

1. Move-Modul kompiliert (`iota move build`) und die Tests aus
   `move/agent_station/tests/agent_station_tests.move` laufen grün (inkl. der im Kommentar
   aufgeführten TODO-Fälle: max_per_tx-Überschreitung, paused, Allowlist, epoch-Rollover).
2. Unabhängige Security-Review des Moduls (Move-Objektmodell-Fehler sind schwer wieder
   rückgängig zu machen, sobald echtes Geld im Objekt liegt).
3. Testnet-Pilot: mindestens eine Station über mehrere echte Epochenzyklen inkl. absichtlicher
   Grenzfälle (Betrag = Limit, Betrag = Limit + 1, Pause während laufender Epoche).
4. Serverseitige Gas-Reserve-Verwaltung für die SpendCap-Adresse dokumentiert (Env-Var, minimale
   Füllstands-Warnung).
5. Erst danach: `agent_stations.kind = 'move'` als Option in der PWA freischalten — Default bleibt
   vorerst `legacy`.

---

## 9. Dateien

| Pfad | Rolle |
|---|---|
| `docs/AGENT_STATION_ONCHAIN.md` | Dieses Dokument |
| `move/agent_station/Move.toml` | Package-Manifest (Platzhalter-Adressen, Revision vor Deploy prüfen) |
| `move/agent_station/sources/agent_station.move` | Modul: `AgentStation`, `SpendCap`, `AdminCap`, `spend`/`deposit`/`admin_*` |
| `move/agent_station/tests/agent_station_tests.move` | Testskizze, ungetestet in dieser Umgebung |
| `docs/AGENT_ARCHITECTURE.md` | Phase 3 (weiterhin aktiv, unabhängig von Phase 4) |

---

## 10. Nächste Schritte (falls freigegeben)

1. Move-Toolchain lokal/CI einrichten, Modul kompilieren und die Testskizze vervollständigen.
2. `payFromStationOnChain()` in `server/agent-station.js` (Move-Call-Bau via
   `@iota/iota-sdk/transactions`, analog zu `sendFromSecret` in `server/wallet.js`).
3. Client-seitiger Signierfluss für `create_station`/`deposit`/`admin_*` (PRF, wie bei
   bestehenden Self-Custody-Sends) in `public/app.js` + `public/iota-sign.js`.
4. Schema-Migration `agent_stations.kind`, neue Routen/PWA-Toggle „On-Chain-Station (Beta)".
5. Testnet-Pilot vor jeder Mainnet-Freigabe (siehe § 8).

---

## 11. PTB-Signierpfade: SpendCap (Server) vs. AdminCap (Nutzer-Passkey)

Zwei strukturell unterschiedliche Signierpfade, keine austauschbaren Varianten desselben Musters —
das lässt sich leicht verwechseln, weil beide `Transaction`-Objekte mit `moveCall` bauen. Beide
Sketches unten sind gegen den tatsächlich installierten `@iota/iota-sdk@1.13.0` in `node_modules/`
geprüft (Methodensignaturen per Quellcode-Lesen bestätigt), aber **nicht gegen ein laufendes
Testnet ausgeführt** — Objektauflösung (Version/Digest von Station/Caps) passiert erst bei
`build({ client })`/`executeTransactionBlock` gegen einen echten Node.

### 11.1 Server signiert selbst (SpendCap → `spend()`)

Analog zu `executeTransfer()`/`sendFromSecret()` in `server/wallet.js:173-183` — der Server besitzt
den privaten Schlüssel der SpendCap-Adresse direkt und ruft `client.signAndExecuteTransaction`
selbst auf (kein Passkey nötig, da es die autonome Agenten-Zahlung *ist*, nicht eine Nutzeraktion):

```js
// server/agent-station.js – Sketch, ungetestet
import { Transaction } from '@iota/iota-sdk/transactions'; // NICHT '@iota/iota-sdk' (kein Root-Export)

async function payFromStationOnChain({ network, spendCapKeypair, stationId, packageId, spendCapId, amountNanos, recipient, clockId }) {
  const client = getClient(network);
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent_station::spend`,
    arguments: [
      tx.object(stationId),
      tx.object(spendCapId),
      tx.pure.u64(BigInt(amountNanos)),
      tx.pure.address(recipient),
      tx.object(clockId), // Clock ist ein bekanntes Shared Object, feste ID 0x6
    ],
  });
  const result = await client.signAndExecuteTransaction({
    signer: spendCapKeypair,   // hält der Server, analog zum heutigen station.key_ciphertext
    transaction: tx,           // Schlüssel heißt "transaction", nicht "Transaction" (client.d.ts:117)
    options: { showEffects: true },
  });
  return waitForTxEffects(client, result.digest, result); // bestehender Helper wiederverwendbar
}
```

### 11.2 Nutzer signiert per Passkey (AdminCap → `admin_*`/`create_station`/`deposit`)

**Nicht** derselbe Pfad wie oben — der Server kennt hier keinen privaten Schlüssel. Es gilt exakt
der bestehende Non-Custodial-Split aus `server/wallet.js:261-289` (`buildTransferBytes` →
Client signiert via PRF → `submitSignedTransaction`), nur mit einem `moveCall` statt
`splitCoins`/`transferObjects` als Tx-Inhalt:

```js
// server/agent-station.js – Sketch, ungetestet
async function buildAdminActionBytes({ network, sender, packageId, stationId, adminCapId, action, args }) {
  const client = getClient(network);
  const tx = new Transaction();
  tx.setSender(sender); // die PRF-Adresse des Nutzers
  tx.moveCall({
    target: `${packageId}::agent_station::${action}`, // z. B. "admin_set_paused"
    arguments: [tx.object(stationId), tx.object(adminCapId), ...args],
  });
  const bytes = await tx.build({ client }); // braucht Netzwerk: löst Objekt-Versionen + Gas auf
  return toBase64(bytes);
}
// Client (public/iota-sign.js) signiert die Bytes lokal per PRF-Keypair, wie beim heutigen Send.
// Danach: submitSignedTransaction() (bestehend, server/wallet.js:283) mit
// client.executeTransactionBlock({ transactionBlock, signature }) – unverändert wiederverwendbar.
```

**Was das korrigiert, im Vergleich zu einem früher diskutierten Entwurfsschnipsel:** `Transaction`
kommt aus `@iota/iota-sdk/transactions`, nicht aus dem Package-Root (kein Root-Export laut
`package.json`). `signAndExecuteTransaction` hängt am **Client**, nicht am Signer, und der
Parameter heißt `transaction` (klein), nicht `Transaction` (`client.d.ts:117`,
`signAndExecuteTransaction({ transaction, signer, ...input })`). Eine vollständig netzwerkfreie
„Trockenübung" der fertigen, signierbaren Transaktion gibt es nicht — `build()` ohne
`onlyTransactionKind: true` braucht einen `client`, weil er reale Objekt-Versionen/Digests und
Gas-Coins auflösen muss (`build(options?: BuildTransactionOptions): Promise<Uint8Array>`,
`BuildTransactionOptions.client?: IotaClient`); die genannte `txb.serialize()`-Methode existiert in
dieser SDK-Version nicht (`toJSON(options?): Promise<string>` ist der reale asynchrone Name und
liefert eine JSON-, keine Base64-BCS-Repräsentation).

---

## 12. Quellen (Framework- und SDK-Verifikation, Juli 2026)

Alle Modulpfade/Funktionssignaturen in `move/agent_station/` wurden gegen diese Dateien im
offiziellen Repo geprüft (Branch `develop`, Stand der Prüfung: siehe Commit-Datum dieses Dokuments;
`rev = "framework/testnet"` im `Move.toml` kann von `develop` abweichen — vor dem Build erneut
gegenprüfen):

- [`iota-framework/packages/iota-framework/sources/balance.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/balance.move)
- [`iota-framework/packages/iota-framework/sources/coin.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/coin.move)
- [`iota-framework/packages/iota-framework/sources/clock.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/clock.move)
- [`iota-framework/packages/iota-framework/sources/object.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/object.move)
- [`iota-framework/packages/iota-framework/sources/transfer.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/transfer.move)
- [`iota-framework/packages/iota-framework/sources/iota.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/iota.move)
- [`iota-framework/packages/iota-framework/sources/vec_set.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/vec_set.move)
- [`iota-framework/packages/iota-framework/sources/event.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/event.move)
- [`iota-framework/packages/iota-framework/sources/tx_context.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/tx_context.move)
- [`iota-framework/packages/iota-framework/sources/test/test_scenario.move`](https://github.com/iotaledger/iota/blob/develop/crates/iota-framework/packages/iota-framework/sources/test/test_scenario.move)
- [`examples/move/flash_lender/sources/example.move`](https://github.com/iotaledger/iota/blob/develop/examples/move/flash_lender/sources/example.move) — offizielles Vorbild für das Shared-Object-Float + AdminCap-Muster, inkl. Test-Modul-Struktur
- [`examples/move/flash_lender/Move.toml`](https://github.com/iotaledger/iota/blob/develop/examples/move/flash_lender/Move.toml) — Referenz für `edition`/`[addresses]`
- [Move.toml File — IOTA Documentation](https://docs.iota.org/references/move/move-toml), [IOTA Move CLI — IOTA Documentation](https://docs.iota.org/references/cli/move), [Build and Test Packages — IOTA Documentation](https://docs.iota.org/developer/getting-started/build-test) (nur per Suchindex einsehbar, `docs.iota.org` direkt war in dieser Sitzung nicht erreichbar — CLI-Befehle `iota move build`/`iota move test`/`iota client publish` sind darüber trotzdem bestätigt)

**SDK-seitig** (§ 11) geprüft gegen die lokal installierte `node_modules/@iota/iota-sdk@1.13.0`:
`package.json` (Exports-Map, kein Root-Export), `dist/esm/transactions/Transaction.{js,d.ts}`
(`object`, `moveCall`, `transferObjects`, `setGasBudget`, `build`, `toJSON`, `sign`),
`dist/esm/transactions/pure.js` (`pure.u64/address/string`), `dist/esm/transactions/
json-rpc-resolver.d.ts` (`BuildTransactionOptions`), `dist/esm/client/client.d.ts`
(`signAndExecuteTransaction`-Signatur) — sowie die bereits produktiv laufenden Referenzimplementierungen
`server/wallet.js:173-183` (`executeTransfer`, Server-Signing) und `server/wallet.js:261-289`
(`buildTransferBytes`/`submitSignedTransaction`, Client-PRF-Signing).

**Weiterhin nicht verifiziert:** ob `spend`/`admin_*` in einer echten PTB gegen ein laufendes
Testnet mit deployter `orange_bar::agent_station` tatsächlich wie erwartet durchläuft (Objekt-
Auflösung, Gas-Schätzung, Fehlerpfade bei den `assert!`-Codes) — das setzt Schritt 1 aus § 10
(Toolchain + Deployment) voraus und ist nicht durch Quellcode-Lesen ersetzbar.

*English summary: Design draft (uncompiled, unaudited) for hardening the Agent Station float —
funds live as a `Balance<IOTA>` inside a shared Move object instead of a raw keypair-controlled
address, reachable only through the module's `spend`/`deposit`/`admin_*` entry functions. A leaked
server key (SpendCap holder) can then drain at most `epoch_limit` per rolling window, never the
whole float at once, and only the user's own passkey-held `AdminCap` can change limits, pause, or
withdraw. This hardens security; it does not change the MiCA custody classification. Not yet wired
into the running server — see § 10 for the implementation path.*
