/// Orange-Bar Agent-Station, Phase 4 (Entwurf, siehe docs/AGENT_STATION_ONCHAIN.md).
///
/// Ziel: Das Ausgabe-Limit eines KI-Agenten wird nicht mehr nur von der
/// SQLite-Policy des Servers geprüft, sondern von JEDEM Validator beim
/// Ausführen der Transaktion. Die Gelder liegen als `Balance<IOTA>` INNERHALB
/// dieses Objekts – eine Balance kann (anders als ein Coin) nicht durch
/// simplen Adress-Besitz bewegt werden, sondern nur über die entry-Funktionen
/// dieses Moduls. Ein geleakter Server-Schlüssel (SpendCap-Inhaber) kann daher
/// höchstens `epoch_limit` pro Epoche abschöpfen, nie das gesamte Float auf
/// einen Schlag – und der Nutzer (AdminCap) kann jederzeit pausieren/entziehen.
///
/// Nicht auditiert. Vor Mainnet-Einsatz: externe Security-Review, siehe
/// docs/AGENT_STATION_ONCHAIN.md § 8.
module orange_bar::agent_station {
    // object::{Self, UID, ID}, transfer und tx_context::{Self, TxContext} sind
    // seit dieser Framework-Version automatisch importiert (kompiliert sonst
    // mit "duplicate alias"-Warnungen, siehe iota-move build).
    use iota::balance::{Self, Balance};
    use iota::coin::{Self, Coin};
    use iota::clock::{Self, Clock};
    use iota::vec_set::{Self, VecSet};
    use iota::event;
    use iota::iota::IOTA;

    // ---------- Fehlercodes ----------
    const E_WRONG_STATION: u64 = 1;
    const E_PAUSED: u64 = 2;
    const E_OVER_MAX_PER_TX: u64 = 3;
    const E_NOT_ALLOWED: u64 = 4;
    const E_OVER_EPOCH_LIMIT: u64 = 5;
    const E_ZERO_AMOUNT: u64 = 6;
    const E_INSUFFICIENT_BALANCE: u64 = 7;
    const E_ZERO_EPOCH_LENGTH: u64 = 8;

    /// Das Float. Shared Object, damit sowohl Server- (SpendCap) als auch
    /// Nutzer-Transaktionen (AdminCap) es referenzieren können.
    public struct AgentStation has key {
        id: UID,
        owner: address,             // Nutzer-Adresse, nur zur Anzeige/Events
        balance: Balance<IOTA>,
        max_per_tx: u64,
        epoch_limit: u64,
        epoch_length_ms: u64,
        spent_this_epoch: u64,
        epoch_started_at_ms: u64,
        allowlist: VecSet<address>,
        allowlist_enabled: bool,
        paused: bool,
    }

    /// Hält der Server/Agent. Erlaubt AUSSCHLIESSLICH `spend()` auf genau
    /// dieser Station – keine Admin-Rechte, kein Withdraw, keine Limit-Änderung.
    public struct SpendCap has key, store {
        id: UID,
        station_id: ID,
    }

    /// Hält der Nutzer (dieselbe Passkey/PRF-Adresse wie die Non-Custodial-
    /// Wallet). Der Server bekommt dieses Objekt NIE.
    public struct AdminCap has key, store {
        id: UID,
        station_id: ID,
    }

    public struct StationCreated has copy, drop { station_id: ID, owner: address }
    public struct Spent has copy, drop { station_id: ID, amount: u64, recipient: address }
    public struct Deposited has copy, drop { station_id: ID, amount: u64 }
    public struct PolicyChanged has copy, drop { station_id: ID }
    public struct Paused has copy, drop { station_id: ID, paused: bool }

    /// Legt eine neue Station an. `spend_cap_recipient` ist die Server-/
    /// Agent-Adresse, die künftig `spend()` aufrufen darf; AdminCap geht immer
    /// an den Transaktions-Absender (= die Nutzer-Passkey-Adresse).
    public entry fun create_station(
        max_per_tx: u64,
        epoch_limit: u64,
        epoch_length_ms: u64,
        spend_cap_recipient: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(epoch_length_ms > 0, E_ZERO_EPOCH_LENGTH);
        let owner = tx_context::sender(ctx);
        let station = AgentStation {
            id: object::new(ctx),
            owner,
            balance: balance::zero<IOTA>(),
            max_per_tx,
            epoch_limit,
            epoch_length_ms,
            spent_this_epoch: 0,
            epoch_started_at_ms: clock::timestamp_ms(clock),
            allowlist: vec_set::empty(),
            allowlist_enabled: false,
            paused: false,
        };
        let station_id = object::id(&station);

        event::emit(StationCreated { station_id, owner });

        transfer::transfer(SpendCap { id: object::new(ctx), station_id }, spend_cap_recipient);
        transfer::transfer(AdminCap { id: object::new(ctx), station_id }, owner);
        transfer::share_object(station);
    }

    /// Auflädt das Float. Jeder darf einzahlen (wie eine normale Überweisung
    /// an die alte Stations-Adresse) – typischerweise der Nutzer selbst.
    public entry fun deposit(station: &mut AgentStation, payment: Coin<IOTA>, _ctx: &mut TxContext) {
        let amount = coin::value(&payment);
        balance::join(&mut station.balance, coin::into_balance(payment));
        event::emit(Deposited { station_id: object::id(station), amount });
    }

    /// Rollt die Epoche fort, falls `epoch_length_ms` seit `epoch_started_at_ms`
    /// vergangen ist. Rollierendes Fenster ab letzter Aktivität – bewusst KEIN
    /// UTC-Kalendertag wie beim SQLite-Tageslimit (siehe docs § 6, Tradeoff).
    fun maybe_roll_epoch(station: &mut AgentStation, clock: &Clock) {
        let now_ms = clock::timestamp_ms(clock);
        if (now_ms >= station.epoch_started_at_ms + station.epoch_length_ms) {
            station.spent_this_epoch = 0;
            station.epoch_started_at_ms = now_ms;
        }
    }

    /// Autonomes Ausgeben durch den Agenten. Einziger Weg, Geld aus der
    /// Balance zu holen außer `admin_withdraw`. Alle Prüfungen laufen
    /// on-chain; die Chain serialisiert konkurrierende Transaktionen auf
    /// demselben Shared Object automatisch – zwei parallele `spend`-Aufrufe
    /// können `epoch_limit` NICHT gemeinsam überschreiten (kein Äquivalent
    /// zum SQLite-Race aus v1.1.1 möglich, da hier kein Server-Code, sondern
    /// Konsens-Ausführung entscheidet).
    public entry fun spend(
        station: &mut AgentStation,
        cap: &SpendCap,
        amount: u64,
        recipient: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(cap.station_id == object::id(station), E_WRONG_STATION);
        assert!(!station.paused, E_PAUSED);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(amount <= station.max_per_tx, E_OVER_MAX_PER_TX);
        if (station.allowlist_enabled) {
            assert!(vec_set::contains(&station.allowlist, &recipient), E_NOT_ALLOWED);
        };

        maybe_roll_epoch(station, clock);
        assert!(station.spent_this_epoch + amount <= station.epoch_limit, E_OVER_EPOCH_LIMIT);
        assert!(balance::value(&station.balance) >= amount, E_INSUFFICIENT_BALANCE);

        station.spent_this_epoch = station.spent_this_epoch + amount;
        let out = coin::from_balance(balance::split(&mut station.balance, amount), ctx);
        transfer::public_transfer(out, recipient);

        event::emit(Spent { station_id: object::id(station), amount, recipient });
    }

    // ---------- Admin (nur mit AdminCap, d. h. nur der Nutzer selbst) ----------

    public entry fun admin_set_limits(
        station: &mut AgentStation, cap: &AdminCap,
        max_per_tx: u64, epoch_limit: u64, epoch_length_ms: u64,
    ) {
        assert!(cap.station_id == object::id(station), E_WRONG_STATION);
        // epoch_length_ms == 0 würde maybe_roll_epoch bei JEDEM spend() neu starten
        // lassen (now_ms >= epoch_started_at_ms + 0 ist immer wahr) und damit das
        // Epochen-Limit still aushebeln – nur max_per_tx bliebe wirksam.
        assert!(epoch_length_ms > 0, E_ZERO_EPOCH_LENGTH);
        station.max_per_tx = max_per_tx;
        station.epoch_limit = epoch_limit;
        station.epoch_length_ms = epoch_length_ms;
        event::emit(PolicyChanged { station_id: object::id(station) });
    }

    public entry fun admin_set_allowlist(
        station: &mut AgentStation, cap: &AdminCap,
        enabled: bool, allowlist: vector<address>,
    ) {
        assert!(cap.station_id == object::id(station), E_WRONG_STATION);
        station.allowlist_enabled = enabled;
        station.allowlist = vec_set::from_keys(allowlist);
        event::emit(PolicyChanged { station_id: object::id(station) });
    }

    /// Sofortiger Not-Aus: friert `spend()` ein, ohne die SpendCap zu
    /// widerrufen (der Agent-Token bleibt für Read/Propose nutzbar).
    public entry fun admin_set_paused(station: &mut AgentStation, cap: &AdminCap, paused: bool) {
        assert!(cap.station_id == object::id(station), E_WRONG_STATION);
        station.paused = paused;
        event::emit(Paused { station_id: object::id(station), paused });
    }

    /// Nutzer holt sich (einen Teil) des Restguthabens zurück – z. B. beim
    /// endgültigen Abschalten eines Agenten.
    public entry fun admin_withdraw(
        station: &mut AgentStation, cap: &AdminCap,
        amount: u64, ctx: &mut TxContext,
    ) {
        assert!(cap.station_id == object::id(station), E_WRONG_STATION);
        assert!(balance::value(&station.balance) >= amount, E_INSUFFICIENT_BALANCE);
        let out = coin::from_balance(balance::split(&mut station.balance, amount), ctx);
        transfer::public_transfer(out, tx_context::sender(ctx));
    }

    // ---------- Read-only Helper (für devInspect / off-chain Anzeige) ----------

    public fun balance_value(station: &AgentStation): u64 { balance::value(&station.balance) }
    public fun spent_this_epoch(station: &AgentStation): u64 { station.spent_this_epoch }
    public fun is_paused(station: &AgentStation): bool { station.paused }
}
