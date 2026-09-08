use super::*;

fn account_probe(
    session_status: Sv2SessionInspectionStatus,
    remote_use: Sv2RemoteUseStatus,
    authorization_status: Sv2AuthorizationStatus,
) -> Sv2AccountProbeView {
    Sv2AccountProbeView {
        session_status,
        remote_use,
        authorization_status,
        authorized_voice_count: 0,
        authorized_voices: Vec::new(),
        authorized_voice_products: Vec::new(),
        account_display_name: None,
        account_email: None,
        account_key: None,
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

#[test]
fn recent_project_settings_include_canonical_and_managed_slot_roots() {
    let (root, paths) = fixture();
    let slot_id = Uuid::new_v4().to_string();
    let manifest = SlotManifest {
        slots: vec![SlotRecord {
            id: slot_id.clone(),
            display_name: "Slot".to_string(),
            color: "#6D5CE7".to_string(),
            created_at_utc: Utc::now().to_rfc3339(),
            last_activated_at_utc: None,
            concurrent_content: Sv2ConcurrentContentPreferences::default(),
        }],
        ..SlotManifest::default()
    };
    let discovered = recent_project_settings_files_for(&paths, &manifest);
    assert_eq!(
        discovered,
        vec![
            paths.canonical.join("settings/settings.xml"),
            paths.parked(&slot_id).join("settings/settings.xml"),
        ]
    );
    let _ = fs::remove_dir_all(root);
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
    let available = account_probe(
        Sv2SessionInspectionStatus::InUse,
        Sv2RemoteUseStatus::Unknown,
        Sv2AuthorizationStatus::Verified,
    );
    let stale = account_probe(
        Sv2SessionInspectionStatus::Expired,
        Sv2RemoteUseStatus::Unknown,
        Sv2AuthorizationStatus::Unknown,
    );
    let busy = account_probe(
        Sv2SessionInspectionStatus::Ready,
        Sv2RemoteUseStatus::Detected,
        Sv2AuthorizationStatus::Verified,
    );

    assert!(account_probe_rank(&available) > account_probe_rank(&stale));
    assert!(account_probe_rank(&available) > account_probe_rank(&busy));
}

#[test]
fn state_reports_each_slots_installed_voice_ids() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let active_id = manifest.active_slot_id.clone().unwrap();
    let other_id = add_parked(&paths, &mut manifest, "B");
    let installed = "00000000-0000-4000-8000-000000000007";
    let version =
        slot_data_root(&paths, &manifest, &active_id).join(format!("databases/{installed}/101"));
    fs::create_dir_all(&version).unwrap();
    fs::write(version.join("m"), b"manifest").unwrap();
    fs::write(version.join("model.dnni"), b"model").unwrap();

    let state = build_state(&paths, &manifest, false, String::new()).unwrap();
    assert_eq!(
        state
            .slots
            .iter()
            .find(|slot| slot.id == active_id)
            .unwrap()
            .installed_voice_ids,
        vec![installed]
    );
    assert!(state
        .slots
        .iter()
        .find(|slot| slot.id == other_id)
        .unwrap()
        .installed_voice_ids
        .is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cached_state_reads_manifest_without_recovery_or_voice_scan() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let active_id = manifest.active_slot_id.clone().unwrap();
    let other_id = add_parked(&paths, &mut manifest, "B");
    let installed = "00000000-0000-4000-8000-000000000008";
    let version =
        slot_data_root(&paths, &manifest, &active_id).join(format!("databases/{installed}/101"));
    fs::create_dir_all(&version).unwrap();
    fs::write(version.join("m"), b"manifest").unwrap();
    fs::write(version.join("model.dnni"), b"model").unwrap();
    fs::write(&paths.journal, b"unfinished recovery must remain untouched").unwrap();

    let service = Sv2ProfileService {
        paths: Ok(paths.clone()),
        gate: Mutex::new(()),
    };
    let state = service.cached_state().unwrap();

    assert_eq!(state.active_slot_id.as_deref(), Some(active_id.as_str()));
    assert_eq!(state.slots.len(), 2);
    assert!(state.slots.iter().any(|slot| slot.id == other_id));
    assert!(state
        .slots
        .iter()
        .all(|slot| slot.installed_voice_ids.is_empty()));
    assert!(paths.journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cached_state_rejects_a_malformed_manifest() {
    let (root, paths) = fixture();
    fs::write(&paths.manifest, b"not json").unwrap();
    let service = Sv2ProfileService {
        paths: Ok(paths),
        gate: Mutex::new(()),
    };

    assert!(service.cached_state().is_err());
    fs::remove_dir_all(root).unwrap();
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
            color: SLOT_COLORS[0].to_string(),
            created_at_utc: Utc::now().to_rfc3339(),
            last_activated_at_utc: None,
            concurrent_content: Sv2ConcurrentContentPreferences::default(),
        }],
        concurrent_defaults: Sv2ConcurrentDefaults::default(),
    };
    save_manifest(paths, &manifest).unwrap();
    #[cfg(windows)]
    {
        let id = manifest.active_slot_id.as_deref().unwrap();
        fs::create_dir_all(&paths.slots).unwrap();
        fs::rename(&paths.canonical, paths.parked(id)).unwrap();
        create_canonical_junction(paths, id).unwrap();
    }
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
    #[cfg(not(windows))]
    fs::rename(&paths.canonical, paths.parked(&a)).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&paths.canonical).unwrap();

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
    #[cfg(not(windows))]
    fs::rename(&paths.canonical, paths.parked(&a)).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&paths.canonical).unwrap();
    #[cfg(not(windows))]
    fs::rename(paths.parked(&b), &paths.canonical).unwrap();
    #[cfg(windows)]
    junction::create(paths.parked(&b), &paths.canonical).unwrap();

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
    #[cfg(not(windows))]
    fs::rename(&paths.canonical, paths.parked(&a)).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&paths.canonical).unwrap();
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
    assert_eq!(validate_display_name(" ").unwrap(), "");
    assert!(validate_display_name(&"x".repeat(65)).is_err());
    assert!(validate_slot_id("../../escape").is_err());
    assert!(validate_slot_id(&Uuid::new_v4().to_string()).is_ok());
    assert!(validate_color("#ABCDEF").is_ok());
    assert!(validate_color("red;display:none").is_err());
}

#[test]
fn legacy_manual_fields_are_ignored_and_not_reserialized() {
    let (root, paths) = fixture();
    let manifest_path = &paths.manifest;
    fs::write(
        manifest_path,
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "slots": [{
                "id": Uuid::new_v4().to_string(),
                "displayName": "备注",
                "manuallyConfirmedVoices": ["Mai 2"],
                "username": "obsolete-name",
                "email": "obsolete@example.test",
                "color": "#ABCDEF",
                "createdAtUtc": Utc::now().to_rfc3339()
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let manifest = load_manifest(&paths).unwrap();
    assert_eq!(manifest.slots[0].display_name, "备注");
    let serialized = serde_json::to_value(manifest).unwrap();
    assert!(serialized["slots"][0]
        .get("manuallyConfirmedVoices")
        .is_none());
    assert!(serialized["slots"][0].get("username").is_none());
    assert!(serialized["slots"][0].get("email").is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn account_remark_can_be_cleared_without_changing_the_slot() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "Remark");
    let id = manifest.slots[0].id.clone();
    let service = Sv2ProfileService {
        paths: Ok(paths),
        gate: Mutex::new(()),
    };
    let state = service.rename_slot(id.clone(), String::new()).unwrap();
    assert_eq!(state.slots[0].id, id);
    assert!(state.slots[0].display_name.is_empty());
    assert!(load_manifest(service.paths.as_ref().unwrap())
        .unwrap()
        .slots[0]
        .display_name
        .is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn verified_in_use_account_remains_usable_when_remote_use_is_unknown() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let mut state = build_state(&paths, &manifest, false, String::new()).unwrap();
    let active = state.slots.iter_mut().find(|slot| slot.is_active).unwrap();
    active.concurrent.running_pids = vec![1234];
    active.account_probe = account_probe(
        Sv2SessionInspectionStatus::InUse,
        Sv2RemoteUseStatus::Unknown,
        Sv2AuthorizationStatus::Verified,
    );
    active.account_probe.authorized_voice_count = 2;

    let precheck = build_account_precheck(&state);
    assert!(precheck.local_use);
    assert_eq!(precheck.remote_use, Sv2RemoteUseStatus::Unknown);
    assert_eq!(precheck.summary, "账号可用。");
    assert!(precheck.detail.contains("可以继续启动"));
    fs::remove_dir_all(root).unwrap();
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
    let data_root = slot_data_root(&paths, &manifest, &slot_id);
    store.prepare_launch(&slot_id, &data_root).unwrap();
    fs::remove_file(data_root.join("license/session")).unwrap();
    store.view(&slot_id, &data_root, false).unwrap();

    let service = Sv2ProfileService {
        paths: Ok(paths),
        gate: Mutex::new(()),
    };
    let snapshot = service.account_usage_snapshot().unwrap();
    let precheck = snapshot.precheck;

    assert!(precheck.recovery_pending, "{:?}", snapshot.profiles);
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

#[cfg(windows)]
fn legacy_fixture(paths: &SlotPaths, slot_id: &str, long: bool) -> (PathBuf, PathBuf) {
    let compact = Uuid::parse_str(slot_id).unwrap().simple().to_string();
    let root = if long {
        paths.vault.join("concurrent").join(slot_id).join("box")
    } else {
        paths.vault.join("c").join(&compact[..16])
    };
    let data = root.join("user/current/AppData/Roaming/Dreamtonics/Synthesizer V Studio 2");
    fs::create_dir_all(data.join("license")).unwrap();
    write_marker(&data, slot_id).unwrap();
    fs::write(data.join("license/session"), b"sandbox-session").unwrap();
    fs::write(
        root.join(".synthv-toolbox-concurrent.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "slotId": slot_id, "boxName": format!("SV2TB{}", &compact[..24])
        }))
        .unwrap(),
    )
    .unwrap();
    (root, data)
}

#[cfg(windows)]
#[test]
fn convergence_is_repeatable_and_retains_account_voice_files() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let id = manifest.active_slot_id.as_deref().unwrap();
    fs::create_dir_all(paths.parked(id).join("databases/voice")).unwrap();
    fs::write(
        paths.parked(id).join("databases/voice/model"),
        b"account-a-watermark",
    )
    .unwrap();
    let (_, source) = legacy_fixture(&paths, id, false);
    let plan = slot_convergence_plan(&paths, &manifest).unwrap();
    apply_slot_convergence(&paths, &manifest, plan).unwrap();
    assert!(!source.exists());
    assert_eq!(
        fs::read(paths.canonical.join("license/session")).unwrap(),
        b"sandbox-session"
    );
    assert_eq!(
        fs::read(paths.parked(id).join("databases/voice/model")).unwrap(),
        b"account-a-watermark"
    );
    assert_eq!(
        fs::read(paths.vault.join("retired").join(id).join("license/session")).unwrap(),
        b"session"
    );
    let second = slot_convergence_plan(&paths, &manifest).unwrap();
    assert!(second.is_empty());
    apply_slot_convergence(&paths, &manifest, second).unwrap();
    assert_eq!(
        paths.canonical.canonicalize().unwrap(),
        paths.parked(id).canonicalize().unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn convergence_conflicts_never_move_existing_voice_files() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let id = manifest.active_slot_id.as_deref().unwrap();
    let (_, source) = legacy_fixture(&paths, id, false);
    fs::create_dir_all(paths.parked(id).join("databases")).unwrap();
    fs::write(paths.parked(id).join("databases/model"), b"keep").unwrap();
    fs::create_dir_all(paths.vault.join("retired").join(id)).unwrap();
    assert!(slot_convergence_plan(&paths, &manifest).is_err());
    assert_eq!(
        fs::read(paths.parked(id).join("databases/model")).unwrap(),
        b"keep"
    );
    assert!(!source.join("databases").exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn convergence_rejects_two_legacy_sources_and_redirected_parents() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let id = manifest.active_slot_id.as_deref().unwrap();
    let (_, source) = legacy_fixture(&paths, id, false);
    legacy_fixture(&paths, id, true);
    assert!(slot_convergence_plan(&paths, &manifest).is_err());
    assert!(source.exists());
    fs::remove_dir_all(root).unwrap();

    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let id = manifest.active_slot_id.as_deref().unwrap();
    let (legacy, _) = legacy_fixture(&paths, id, false);
    let outside = root.join("outside");
    fs::rename(legacy.join("user"), &outside).unwrap();
    junction::create(&outside, legacy.join("user")).unwrap();
    assert!(slot_convergence_plan(&paths, &manifest).is_err());
    fs::remove_dir(legacy.join("user")).unwrap();
    assert!(outside.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn launch_defaults_follow_latest_primary_settings_and_skip_running_targets() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let b = add_parked(&paths, &mut manifest, "B");
    fs::create_dir_all(paths.canonical.join("settings")).unwrap();
    fs::write(paths.canonical.join("settings/settings.xml"), b"first").unwrap();
    sync_defaults_before_launch(&paths, &manifest, &b, false).unwrap();
    assert_eq!(
        fs::read(paths.parked(&b).join("settings/settings.xml")).unwrap(),
        b"first"
    );
    fs::write(paths.canonical.join("settings/settings.xml"), b"second").unwrap();
    sync_defaults_before_launch(&paths, &manifest, &b, true).unwrap();
    assert_eq!(
        fs::read(paths.parked(&b).join("settings/settings.xml")).unwrap(),
        b"first"
    );
    sync_defaults_before_launch(&paths, &manifest, &b, false).unwrap();
    assert_eq!(
        fs::read(paths.parked(&b).join("settings/settings.xml")).unwrap(),
        b"second"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn prepared_switch_recovery_keeps_the_current_managed_link() {
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
            target_slot_id: b,
            phase: SwitchPhase::Prepared,
        },
    )
    .unwrap();
    recover_if_needed(&paths).unwrap();
    assert_eq!(
        load_manifest(&paths).unwrap().active_slot_id,
        Some(a.clone())
    );
    assert_eq!(
        paths.canonical.canonicalize().unwrap(),
        paths.parked(&a).canonicalize().unwrap()
    );
    assert!(!paths.journal.exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn changing_primary_keeps_existing_instance_on_its_account() {
    let (root, paths) = fixture();
    let mut manifest = import_fixture(&paths, "A");
    let a = manifest.active_slot_id.clone().unwrap();
    let b = add_parked(&paths, &mut manifest, "B");
    let instance = root.join("existing-instance");
    junction::create(paths.parked(&a), &instance).unwrap();
    switch_slot(&paths, &mut manifest, &b).unwrap();
    fs::write(instance.join("project-state"), b"still-account-a").unwrap();
    assert_eq!(
        fs::read(paths.parked(&a).join("project-state")).unwrap(),
        b"still-account-a"
    );
    assert!(!paths.canonical.join("project-state").exists());
    assert_eq!(
        paths.canonical.canonicalize().unwrap(),
        paths.parked(&b).canonicalize().unwrap()
    );
    fs::remove_dir(instance).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn a_matching_marker_in_another_directory_is_not_the_primary_slot() {
    let (root, paths) = fixture();
    let manifest = import_fixture(&paths, "A");
    let id = manifest.active_slot_id.as_deref().unwrap();
    let outside = root.join("other-copy");
    fs::create_dir(&outside).unwrap();
    write_marker(&outside, id).unwrap();
    fs::remove_dir(&paths.canonical).unwrap();
    junction::create(&outside, &paths.canonical).unwrap();
    assert!(slot_convergence_plan(&paths, &manifest).is_err());
    assert!(paths.parked(id).join("license/session").is_file());
    fs::remove_dir(&paths.canonical).unwrap();
    fs::remove_dir_all(root).unwrap();
}
