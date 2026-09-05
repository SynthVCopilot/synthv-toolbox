use super::*;

fn account_probe(
    session_status: Sv2SessionInspectionStatus,
    remote_use: Sv2RemoteUseStatus,
) -> Sv2AccountProbeView {
    Sv2AccountProbeView {
        session_status,
        remote_use,
        authorization_status: Sv2AuthorizationStatus::Unknown,
        authorized_voice_count: 0,
        authorized_voices: Vec::new(),
        account_display_name: None,
        account_email: None,
        checked_at_utc: Utc::now().to_rfc3339(),
        detail: String::new(),
    }
}

fn fixture() -> (PathBuf, SlotPaths) {
    let root = std::env::temp_dir().join(format!("sv2-slot-test-{}", Uuid::new_v4()));
    let paths = SlotPaths::for_test(&root);
    fs::create_dir_all(&paths.metadata).unwrap();
    (root, paths)
}

#[cfg(target_os = "macos")]
#[test]
fn macos_paths_stay_under_the_current_users_application_support() {
    let home = PathBuf::from("/private/tmp/sv2-slot-home");
    let paths = SlotPaths::from_macos_home(&home);
    let support = home.join("Library/Application Support");
    assert_eq!(
        paths.canonical,
        support.join("Dreamtonics/Synthesizer V Studio 2")
    );
    assert_eq!(
        paths.vault,
        support.join("Dreamtonics/Synthesizer V Studio 2.toolbox-slots")
    );
    assert_eq!(
        paths.shared_databases,
        support.join("Dreamtonics/Synthesizer V Studio 2.shared-databases")
    );
    assert_eq!(paths.metadata, support.join("SynthVToolbox/sv2-slots"));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_standalone_detector_matches_only_the_sv2_executable() {
    assert_eq!(
        macos_guard::parse_process(
            "  812 /Applications/Synthesizer V Studio 2 Pro.app/Contents/MacOS/synthv-studio"
        ),
        Some((
            812,
            "/Applications/Synthesizer V Studio 2 Pro.app/Contents/MacOS/synthv-studio"
        ))
    );
    assert!(macos_guard::is_sv2_standalone(
        "/Applications/Synthesizer V Studio 2 Pro.app/Contents/MacOS/synthv-studio"
    ));
    assert!(!macos_guard::is_sv2_standalone(
        "/Applications/Other.app/Contents/MacOS/other"
    ));
}

#[test]
fn account_summary_prefers_a_usable_environment_over_a_stale_copy() {
    let available = account_probe(Sv2SessionInspectionStatus::Ready, Sv2RemoteUseStatus::Clear);
    let stale = account_probe(
        Sv2SessionInspectionStatus::Expired,
        Sv2RemoteUseStatus::Unknown,
    );
    let busy = account_probe(
        Sv2SessionInspectionStatus::Ready,
        Sv2RemoteUseStatus::Detected,
    );

    assert!(account_probe_rank(&available) > account_probe_rank(&stale));
    assert!(account_probe_rank(&available) > account_probe_rank(&busy));
}

fn import_fixture(paths: &SlotPaths, name: &str) -> SlotManifest {
    fs::create_dir_all(paths.canonical.join("license")).unwrap();
    fs::write(paths.canonical.join("license/session"), b"session").unwrap();
    let id = Uuid::new_v4().to_string();
    write_marker(&paths.canonical, &id).unwrap();
    let manifest = SlotManifest {
        schema_version: SCHEMA_VERSION,
        active_slot_id: Some(id.clone()),
        slots: vec![SlotRecord {
            id,
            display_name: name.to_string(),
            username: String::new(),
            email: String::new(),
            manually_confirmed_voices: Vec::new(),
            color: SLOT_COLORS[0].to_string(),
            created_at_utc: Utc::now().to_rfc3339(),
            last_activated_at_utc: None,
            concurrent_content: Sv2ConcurrentContentPreferences::default(),
        }],
        concurrent_defaults: Sv2ConcurrentDefaults::default(),
    };
    save_manifest(paths, &manifest).unwrap();
    manifest
}

fn add_parked(paths: &SlotPaths, manifest: &mut SlotManifest, name: &str) -> String {
    let id = Uuid::new_v4().to_string();
    let parked = paths.parked(&id);
    fs::create_dir_all(&parked).unwrap();
    write_marker(&parked, &id).unwrap();
    fs::write(parked.join("identity.txt"), name.as_bytes()).unwrap();
    manifest.slots.push(SlotRecord {
        id: id.clone(),
        display_name: name.to_string(),
        username: String::new(),
        email: String::new(),
        manually_confirmed_voices: Vec::new(),
        color: SLOT_COLORS[1].to_string(),
        created_at_utc: Utc::now().to_rfc3339(),
        last_activated_at_utc: None,
        concurrent_content: Sv2ConcurrentContentPreferences::default(),
    });
    save_manifest(paths, manifest).unwrap();
    id
}

#[test]
fn switches_whole_roots_without_copying_session_state() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    fs::write(paths.canonical.join("identity.txt"), b"A").unwrap();
    let a = manifest.active_slot_id.clone().unwrap();
    let b = add_parked(&paths, &mut manifest, "B");

    switch_slot(&paths, &mut manifest, &b).unwrap();

    assert_eq!(
        fs::read(paths.canonical.join("identity.txt")).unwrap(),
        b"B"
    );
    assert_eq!(
        fs::read(paths.parked(&a).join("identity.txt")).unwrap(),
        b"A"
    );
    assert_eq!(manifest.active_slot_id.as_deref(), Some(b.as_str()));
    assert!(!paths.journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn voice_databases_remain_account_local_across_slot_switches() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let a = manifest.active_slot_id.clone().unwrap();
    let b = add_parked(&paths, &mut manifest, "B");
    fs::create_dir_all(paths.canonical.join("databases/voice-a")).unwrap();
    fs::write(paths.canonical.join("databases/voice-a/model"), b"a").unwrap();
    fs::create_dir_all(paths.parked(&b).join("databases/voice-b")).unwrap();
    fs::write(paths.parked(&b).join("databases/voice-b/model"), b"b").unwrap();

    assert_eq!(
        fs::read(paths.canonical.join("databases/voice-a/model")).unwrap(),
        b"a"
    );
    assert_eq!(
        fs::read(paths.parked(&b).join("databases/voice-b/model")).unwrap(),
        b"b"
    );

    switch_slot(&paths, &mut manifest, &b).unwrap();
    assert_eq!(
        fs::read(paths.canonical.join("databases/voice-b/model")).unwrap(),
        b"b"
    );
    assert_eq!(
        fs::read(paths.parked(&a).join("databases/voice-a/model")).unwrap(),
        b"a"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn first_empty_slot_becomes_the_canonical_default() {
    let (root, paths) = fixture();
    let mut manifest = SlotManifest::default();
    let slot = add_parked(&paths, &mut manifest, "First");

    switch_slot(&paths, &mut manifest, &slot).unwrap();

    assert_eq!(manifest.active_slot_id.as_deref(), Some(slot.as_str()));
    assert_eq!(
        read_marker(&paths.canonical).unwrap().unwrap().slot_id,
        slot
    );
    assert!(!paths.journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_finishes_after_current_slot_was_parked() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let a = manifest.active_slot_id.clone().unwrap();
    let b = add_parked(&paths, &mut manifest, "B");
    let journal = SwitchJournal {
        schema_version: SCHEMA_VERSION,
        transaction_id: Uuid::new_v4().to_string(),
        current_slot_id: Some(a.clone()),
        target_slot_id: b.clone(),
        phase: SwitchPhase::Prepared,
    };
    save_journal(&paths, &journal).unwrap();
    fs::rename(&paths.canonical, paths.parked(&a)).unwrap();

    recover_if_needed(&paths).unwrap();

    assert_eq!(read_marker(&paths.canonical).unwrap().unwrap().slot_id, b);
    assert_eq!(load_manifest(&paths).unwrap().active_slot_id, Some(b));
    assert!(!paths.journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_commits_when_target_is_already_canonical() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let a = manifest.active_slot_id.clone().unwrap();
    let b = add_parked(&paths, &mut manifest, "B");
    save_journal(
        &paths,
        &SwitchJournal {
            schema_version: SCHEMA_VERSION,
            transaction_id: Uuid::new_v4().to_string(),
            current_slot_id: Some(a.clone()),
            target_slot_id: b.clone(),
            phase: SwitchPhase::CurrentParked,
        },
    )
    .unwrap();
    fs::rename(&paths.canonical, paths.parked(&a)).unwrap();
    fs::rename(paths.parked(&b), &paths.canonical).unwrap();

    recover_if_needed(&paths).unwrap();

    assert_eq!(load_manifest(&paths).unwrap().active_slot_id, Some(b));
    assert!(!paths.journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_does_not_overwrite_an_unknown_canonical_directory() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let a = manifest.active_slot_id.clone().unwrap();
    let b = add_parked(&paths, &mut manifest, "B");
    let journal = SwitchJournal {
        schema_version: SCHEMA_VERSION,
        transaction_id: Uuid::new_v4().to_string(),
        current_slot_id: Some(a.clone()),
        target_slot_id: b,
        phase: SwitchPhase::CurrentParked,
    };
    save_journal(&paths, &journal).unwrap();
    fs::rename(&paths.canonical, paths.parked(&a)).unwrap();
    fs::create_dir_all(&paths.canonical).unwrap();
    fs::write(paths.canonical.join("external.txt"), b"keep").unwrap();

    assert!(recover_if_needed(&paths).is_err());
    assert_eq!(
        fs::read(paths.canonical.join("external.txt")).unwrap(),
        b"keep"
    );
    assert!(paths.journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn names_and_slot_ids_are_strictly_validated() {
    assert!(validate_display_name(" ").is_err());
    assert!(validate_display_name(&"x".repeat(65)).is_err());
    assert!(validate_slot_id("../../escape").is_err());
    assert!(validate_slot_id(&Uuid::new_v4().to_string()).is_ok());
    assert!(validate_color("#6D5CE7").is_ok());
    assert!(validate_color("red;display:none").is_err());
    assert_eq!(
        validate_optional_username("  Producer  ").unwrap(),
        "Producer"
    );
    assert!(validate_optional_username(&"x".repeat(101)).is_err());
    assert_eq!(
        validate_optional_email(" name@example.com ").unwrap(),
        "name@example.com"
    );
    assert!(validate_optional_email("not-an-email").is_err());
}

#[test]
fn invalid_manifest_color_is_rejected() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    manifest.slots[0].color = "red;display:none".to_string();
    save_manifest(&paths, &manifest).unwrap();

    assert!(load_manifest(&paths).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn precheck_reports_a_protected_session_loss_as_remote_conflict_evidence() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let slot_id = manifest.active_slot_id.clone().unwrap();
    let store = Sv2SessionGuardStore::new(&paths.metadata);
    store.prepare_launch(&slot_id, &paths.canonical).unwrap();
    fs::remove_file(paths.canonical.join("license/session")).unwrap();

    let service = Sv2ProfileService {
        paths: Ok(paths),
        gate: Mutex::new(()),
    };
    let snapshot = service.account_usage_snapshot().unwrap();
    let precheck = snapshot.precheck;

    assert!(precheck.recovery_pending);
    assert_eq!(precheck.remote_use, Sv2RemoteUseStatus::Detected);
    assert_eq!(precheck.slot_id.as_deref(), Some(slot_id.as_str()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn usage_snapshot_keeps_profile_and_precheck_evidence_consistent() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let active_slot_id = manifest.active_slot_id.clone().unwrap();
    let service = Sv2ProfileService {
        paths: Ok(paths),
        gate: Mutex::new(()),
    };

    let snapshot = service.account_usage_snapshot().unwrap();
    let active_slot = snapshot
        .profiles
        .slots
        .iter()
        .find(|slot| slot.is_active)
        .unwrap();

    assert_eq!(
        snapshot.profiles.active_slot_id,
        Some(active_slot_id.clone())
    );
    assert_eq!(snapshot.precheck.slot_id, Some(active_slot_id));
    assert_eq!(
        snapshot.precheck.local_processes,
        snapshot.profiles.blockers
    );
    assert_eq!(
        snapshot.precheck.concurrent_pids,
        active_slot.concurrent.running_pids
    );
    fs::remove_dir_all(root).unwrap();
}
