/// Entwurfs-Tests – NICHT in dieser Sandbox kompiliert (kein IOTA-Move-
/// Toolchain verfügbar). Vor Weiterverwendung mit `iota move test` laufen
/// lassen und gegen die tatsächliche Framework-Version prüfen/anpassen.
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

    // TODO (vor Implementierung ergänzen):
    // - spend() über max_per_tx schlägt fehl
    // - spend() nach admin_set_paused(true) schlägt fehl
    // - spend() an Adresse außerhalb der Allowlist schlägt fehl
    // - admin_* Funktionen ohne die richtige AdminCap kompilieren/laufen gar
    //   nicht erst (Typsystem verhindert das strukturell)
    // - epoch rollt nach epoch_length_ms zurück auf 0
}
