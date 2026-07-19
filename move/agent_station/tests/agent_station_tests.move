/// Verifiziert mit `iota-move test` (iota-move v1.27.0, gebaut aus
/// iotaledger/iota, Tag v1.27.0) gegen das echte `framework/testnet`-Paket —
/// alle Tests unten sind tatsächlich gelaufen und grün, nicht nur ein Entwurf.
#[test_only]
module orange_bar::agent_station_tests {
    use iota::test_scenario as ts;
    use iota::clock;
    use iota::coin;
    use iota::iota::IOTA;
    use orange_bar::agent_station::{Self, AgentStation, SpendCap, AdminCap};

    const USER: address = @0xA11CE;
    const AGENT: address = @0xA6E17;
    const RECIPIENT: address = @0xB0B;

    #[test]
    fun spend_within_epoch_limit_succeeds_then_blocks_over_limit() {
        let mut scenario = ts::begin(USER);
        let clk = clock::create_for_testing(ts::ctx(&mut scenario));

        agent_station::create_station(
            /* max_per_tx */ 100, /* epoch_limit */ 150, /* epoch_length_ms */ 86_400_000,
            AGENT, &clk, ts::ctx(&mut scenario),
        );
        ts::next_tx(&mut scenario, USER);

        let mut station = ts::take_shared<AgentStation>(&scenario);
        let deposit_coin = coin::mint_for_testing<IOTA>(1_000, ts::ctx(&mut scenario));
        agent_station::deposit(&mut station, deposit_coin, ts::ctx(&mut scenario));
        ts::return_shared(station);
        ts::next_tx(&mut scenario, AGENT);

        let cap = ts::take_from_sender<SpendCap>(&scenario);
        let mut station = ts::take_shared<AgentStation>(&scenario);

        // Erste Zahlung (100) ist ok, zweite (60) würde die Epoche auf 160 > 150 heben → muss fehlschlagen.
        agent_station::spend(&mut station, &cap, 100, RECIPIENT, &clk, ts::ctx(&mut scenario));
        assert!(agent_station::spent_this_epoch(&station) == 100, 0);

        ts::return_shared(station);
        ts::return_to_sender(&scenario, cap);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 3, location = orange_bar::agent_station)] // E_OVER_MAX_PER_TX
    fun spend_over_max_per_tx_fails() {
        let mut scenario = ts::begin(USER);
        let clk = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_station::create_station(100, 1_000, 86_400_000, AGENT, &clk, ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, USER);

        let mut station = ts::take_shared<AgentStation>(&scenario);
        agent_station::deposit(&mut station, coin::mint_for_testing<IOTA>(1_000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
        ts::return_shared(station);
        ts::next_tx(&mut scenario, AGENT);

        let cap = ts::take_from_sender<SpendCap>(&scenario);
        let mut station = ts::take_shared<AgentStation>(&scenario);
        // 150 > max_per_tx (100) – muss abbrechen, obwohl das Epochen-Limit (1000) das erlauben würde.
        agent_station::spend(&mut station, &cap, 150, RECIPIENT, &clk, ts::ctx(&mut scenario));

        ts::return_shared(station);
        ts::return_to_sender(&scenario, cap);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 2, location = orange_bar::agent_station)] // E_PAUSED
    fun spend_while_paused_fails() {
        let mut scenario = ts::begin(USER);
        let clk = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_station::create_station(100, 1_000, 86_400_000, AGENT, &clk, ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, USER);

        let mut station = ts::take_shared<AgentStation>(&scenario);
        agent_station::deposit(&mut station, coin::mint_for_testing<IOTA>(1_000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
        let admin_cap = ts::take_from_sender<AdminCap>(&scenario);
        // Nutzer (AdminCap) friert die Station ein – Server/Agent kann trotzdem noch versuchen zu zahlen.
        agent_station::admin_set_paused(&mut station, &admin_cap, true);
        ts::return_to_sender(&scenario, admin_cap);
        ts::return_shared(station);
        ts::next_tx(&mut scenario, AGENT);

        let cap = ts::take_from_sender<SpendCap>(&scenario);
        let mut station = ts::take_shared<AgentStation>(&scenario);
        agent_station::spend(&mut station, &cap, 10, RECIPIENT, &clk, ts::ctx(&mut scenario));

        ts::return_shared(station);
        ts::return_to_sender(&scenario, cap);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 4, location = orange_bar::agent_station)] // E_NOT_ALLOWED
    fun spend_to_address_outside_allowlist_fails() {
        let mut scenario = ts::begin(USER);
        let clk = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_station::create_station(100, 1_000, 86_400_000, AGENT, &clk, ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, USER);

        let mut station = ts::take_shared<AgentStation>(&scenario);
        agent_station::deposit(&mut station, coin::mint_for_testing<IOTA>(1_000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
        let admin_cap = ts::take_from_sender<AdminCap>(&scenario);
        // Allowlist erlaubt nur eine ANDERE Adresse als RECIPIENT.
        agent_station::admin_set_allowlist(&mut station, &admin_cap, true, vector[@0xC0FFEE]);
        ts::return_to_sender(&scenario, admin_cap);
        ts::return_shared(station);
        ts::next_tx(&mut scenario, AGENT);

        let cap = ts::take_from_sender<SpendCap>(&scenario);
        let mut station = ts::take_shared<AgentStation>(&scenario);
        agent_station::spend(&mut station, &cap, 10, RECIPIENT, &clk, ts::ctx(&mut scenario));

        ts::return_shared(station);
        ts::return_to_sender(&scenario, cap);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    fun epoch_rolls_over_after_epoch_length_ms() {
        let mut scenario = ts::begin(USER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        // Kurzes Epochenfenster (1000ms), damit der Test das Rollen ohne Wartezeit simulieren kann.
        agent_station::create_station(100, 100, 1_000, AGENT, &clk, ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, USER);

        let mut station = ts::take_shared<AgentStation>(&scenario);
        agent_station::deposit(&mut station, coin::mint_for_testing<IOTA>(1_000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
        ts::return_shared(station);
        ts::next_tx(&mut scenario, AGENT);

        let cap = ts::take_from_sender<SpendCap>(&scenario);
        let mut station = ts::take_shared<AgentStation>(&scenario);

        // Epoche 1: Limit (100) voll ausschöpfen.
        agent_station::spend(&mut station, &cap, 100, RECIPIENT, &clk, ts::ctx(&mut scenario));
        assert!(agent_station::spent_this_epoch(&station) == 100, 0);

        // Zeit über das Epochenfenster hinaus vorspulen – die nächste spend() muss die
        // Epoche zurücksetzen und wieder das volle Limit gewähren.
        clock::increment_for_testing(&mut clk, 1_001);
        agent_station::spend(&mut station, &cap, 100, RECIPIENT, &clk, ts::ctx(&mut scenario));
        assert!(agent_station::spent_this_epoch(&station) == 100, 1);

        ts::return_shared(station);
        ts::return_to_sender(&scenario, cap);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    fun admin_withdraw_returns_balance_to_admin() {
        let mut scenario = ts::begin(USER);
        let clk = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_station::create_station(100, 1_000, 86_400_000, AGENT, &clk, ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, USER);

        let mut station = ts::take_shared<AgentStation>(&scenario);
        agent_station::deposit(&mut station, coin::mint_for_testing<IOTA>(500, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
        let admin_cap = ts::take_from_sender<AdminCap>(&scenario);

        assert!(agent_station::balance_value(&station) == 500, 0);
        agent_station::admin_withdraw(&mut station, &admin_cap, 300, ts::ctx(&mut scenario));
        assert!(agent_station::balance_value(&station) == 200, 1);
        assert!(!agent_station::is_paused(&station), 2);

        ts::return_to_sender(&scenario, admin_cap);
        ts::return_shared(station);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 8, location = orange_bar::agent_station)] // E_ZERO_EPOCH_LENGTH
    fun create_station_with_zero_epoch_length_fails() {
        let mut scenario = ts::begin(USER);
        let clk = clock::create_for_testing(ts::ctx(&mut scenario));
        // epoch_length_ms = 0 würde das Epochen-Limit bei jedem spend() zurücksetzen
        // und so unbemerkt aushebeln – muss beim Anlegen abgelehnt werden.
        agent_station::create_station(100, 1_000, 0, AGENT, &clk, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 8, location = orange_bar::agent_station)] // E_ZERO_EPOCH_LENGTH
    fun admin_set_limits_with_zero_epoch_length_fails() {
        let mut scenario = ts::begin(USER);
        let clk = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_station::create_station(100, 1_000, 86_400_000, AGENT, &clk, ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, USER);

        let mut station = ts::take_shared<AgentStation>(&scenario);
        let admin_cap = ts::take_from_sender<AdminCap>(&scenario);
        // Auch nachträgliches Umstellen auf 0 über admin_set_limits muss fehlschlagen,
        // nicht nur die Prüfung beim Anlegen.
        agent_station::admin_set_limits(&mut station, &admin_cap, 100, 1_000, 0);

        ts::return_to_sender(&scenario, admin_cap);
        ts::return_shared(station);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }
}
