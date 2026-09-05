use super::*;
use crate::sv2_account_probe::{Sv2AccountProbeView, Sv2AuthorizationStatus};
use crate::sv2_concurrent::{
    Sv2ConcurrentContentPreferences, Sv2ConcurrentDefaults, Sv2ConcurrentProviderView,
    Sv2ConcurrentSlotView,
};
use crate::sv2_session_guard::{Sv2SessionProtectionStatus, Sv2SessionProtectionView};
use uuid::Uuid;

fn write_project(project: Value) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("svp-router-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("voice project.svp");
    fs::write(&path, serde_json::to_vec(&project).unwrap()).unwrap();
    (root, path)
}

fn voice_project(name: &str) -> (PathBuf, PathBuf) {
    write_project(serde_json::json!({
        "tracks": [{
            "mainRef": {
                "database": {"name": name, "version": 100, "backendType": "sv2"}
            }
        }]
    }))
}

fn account_probe(
    remote_use: Sv2RemoteUseStatus,
    authorization_status: Sv2AuthorizationStatus,
    authorized_voices: &[&str],
) -> Sv2AccountProbeView {
    Sv2AccountProbeView {
        session_status: Sv2SessionInspectionStatus::Ready,
        remote_use,
        authorization_status,
        authorized_voice_count: authorized_voices.len(),
        checked_at_utc: "2026-08-30T00:00:00Z".to_string(),
        detail: "test probe".to_string(),
        authorized_voices: authorized_voices
            .iter()
            .map(|voice| (*voice).to_string())
            .collect(),
        account_display_name: None,
        account_email: None,
    }
}

fn ready_session_protection() -> Sv2SessionProtectionView {
    Sv2SessionProtectionView {
        status: Sv2SessionProtectionStatus::Ready,
        snapshot_available: true,
        last_detected_at_utc: None,
        last_restored_at_utc: None,
        detail: "ready".to_string(),
    }
}

fn route_slot(
    id: &str,
    display_name: &str,
    remote_use: Sv2RemoteUseStatus,
    authorization_status: Sv2AuthorizationStatus,
    authorized_voices: &[&str],
    manually_confirmed_voices: &[&str],
) -> Sv2ProfileSlotView {
    let defaults = Sv2ConcurrentDefaults::default();
    let probe = account_probe(remote_use, authorization_status, authorized_voices);
    Sv2ProfileSlotView {
        id: id.to_string(),
        display_name: display_name.to_string(),
        username: String::new(),
        email: String::new(),
        color: "#000000".to_string(),
        created_at_utc: "2026-08-30T00:00:00Z".to_string(),
        last_activated_at_utc: None,
        is_active: false,
        session_cached: true,
        data_path: format!("test/{id}"),
        session_protection: ready_session_protection(),
        concurrent_session_protection: ready_session_protection(),
        concurrent: Sv2ConcurrentSlotView {
            ready: false,
            data_path: String::new(),
            running_pids: Vec::new(),
            detail: String::new(),
            content: Sv2ConcurrentContentPreferences::default().resolve(defaults),
        },
        voice_inventory: Sv2VoiceInventoryView {
            status: if manually_confirmed_voices.is_empty() {
                Sv2VoiceInventoryStatus::Unknown
            } else {
                Sv2VoiceInventoryStatus::Manual
            },
            manually_confirmed_voices: manually_confirmed_voices
                .iter()
                .map(|voice| (*voice).to_string())
                .collect(),
            verified_authorized_voice_count: authorized_voices.len(),
            detail: String::new(),
        },
        account_probe: probe.clone(),
        concurrent_account_probe: probe,
    }
}

fn route_state(slots: Vec<Sv2ProfileSlotView>) -> Sv2ProfilesState {
    Sv2ProfilesState {
        supported: true,
        canonical_path: String::new(),
        vault_path: String::new(),
        active_slot_id: None,
        canonical_root_exists: true,
        can_import_current: false,
        recovery_required: false,
        recovery_detail: String::new(),
        slots,
        blockers: Vec::new(),
        concurrent_provider: Sv2ConcurrentProviderView {
            available: false,
            name: String::new(),
            edition: String::new(),
            version: String::new(),
            install_path: String::new(),
            detail: String::new(),
        },
        concurrent_defaults: Sv2ConcurrentDefaults::default(),
    }
}

#[test]
fn remote_detected_account_is_excluded_from_routing() {
    let (root, path) = voice_project("Mai 2");
    let state = route_state(vec![
        route_slot(
            "busy",
            "Busy account",
            Sv2RemoteUseStatus::Detected,
            Sv2AuthorizationStatus::Verified,
            &["Mai 2"],
            &[],
        ),
        route_slot(
            "available",
            "Available account",
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Verified,
            &["Mai 2"],
            &[],
        ),
    ]);

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();
    let busy = plan
        .candidates
        .iter()
        .find(|candidate| candidate.slot_id == "busy")
        .unwrap();

    assert!(!busy.idle);
    assert_eq!(busy.launch_mode, None);
    assert_eq!(plan.selected_slot_id.as_deref(), Some("available"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ready_clear_official_exact_match_is_selected_without_confirmation() {
    let (root, path) = voice_project("Mai 2");
    let state = route_state(vec![route_slot(
        "verified",
        "Verified account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    )]);

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("verified"));
    assert_eq!(plan.selected_launch_mode, Some(SvpLaunchMode::Normal));
    assert!(!plan.requires_confirmation);
    assert_eq!(
        plan.candidates[0].authorization_source,
        SvpAuthorizationSource::Session
    );
    assert!(plan.candidates[0].exact_authorization_match);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unknown_remote_use_requires_confirmation() {
    let (root, path) = voice_project("Mai 2");
    let state = route_state(vec![route_slot(
        "unknown",
        "Unknown account",
        Sv2RemoteUseStatus::Unknown,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    )]);

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("unknown"));
    assert!(plan.requires_confirmation);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn verified_official_authorization_is_preferred_over_manual_record() {
    let (root, path) = voice_project("Mai 2");
    let state = route_state(vec![
        route_slot(
            "manual",
            "A manual account",
            Sv2RemoteUseStatus::Clear,
            Sv2AuthorizationStatus::Unknown,
            &[],
            &["Mai 2"],
        ),
        route_slot(
            "official",
            "Z official account",
            Sv2RemoteUseStatus::Clear,
            Sv2AuthorizationStatus::Verified,
            &["Mai 2"],
            &[],
        ),
    ]);

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("official"));
    assert_eq!(
        plan.candidates[0].authorization_source,
        SvpAuthorizationSource::Session
    );
    assert!(!plan.requires_confirmation);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn normal_expired_and_concurrent_clear_selects_concurrent() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "dual-mode",
        "Dual-mode account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.account_probe.session_status = Sv2SessionInspectionStatus::Expired;
    slot.concurrent.ready = true;
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("dual-mode"));
    assert_eq!(plan.selected_launch_mode, Some(SvpLaunchMode::Concurrent));
    assert_eq!(
        plan.candidates[0].session_status,
        Sv2SessionInspectionStatus::Ready
    );
    assert!(!plan.requires_confirmation);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn concurrent_detected_and_normal_clear_selects_normal() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "dual-mode",
        "Dual-mode account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.concurrent.ready = true;
    slot.concurrent_account_probe.remote_use = Sv2RemoteUseStatus::Detected;
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("dual-mode"));
    assert_eq!(plan.selected_launch_mode, Some(SvpLaunchMode::Normal));
    assert_eq!(plan.candidates[0].remote_use, Sv2RemoteUseStatus::Clear);
    assert!(!plan.requires_confirmation);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn equally_healthy_modes_prefer_normal() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "dual-mode",
        "Dual-mode account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.concurrent.ready = true;
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("dual-mode"));
    assert_eq!(plan.selected_launch_mode, Some(SvpLaunchMode::Normal));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn running_concurrent_does_not_exclude_clear_normal() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "dual-mode",
        "Dual-mode account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.concurrent.ready = true;
    slot.concurrent.running_pids.push(4242);
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("dual-mode"));
    assert_eq!(plan.selected_launch_mode, Some(SvpLaunchMode::Normal));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn normal_blocker_does_not_exclude_clear_concurrent() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "dual-mode",
        "Dual-mode account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.concurrent.ready = true;
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;
    state.blockers.push(crate::sv2_profiles::Sv2ProcessBlocker {
        pid: Some(4242),
        name: "synthv-studio.exe".to_string(),
        reason: "test blocker".to_string(),
    });

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id.as_deref(), Some("dual-mode"));
    assert_eq!(plan.selected_launch_mode, Some(SvpLaunchMode::Concurrent));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn running_account_can_route_another_concurrent_instance() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "multi-instance",
        "Concurrent account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.concurrent.ready = true;
    slot.concurrent.running_pids = vec![4242, 4343];
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;
    state.blockers.push(crate::sv2_profiles::Sv2ProcessBlocker {
        pid: Some(4444),
        name: "synthv-studio.exe".to_string(),
        reason: "normal process uses the main slot".to_string(),
    });

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();
    assert_eq!(plan.selected_slot_id.as_deref(), Some("multi-instance"));
    assert_eq!(plan.selected_launch_mode, Some(SvpLaunchMode::Concurrent));
    assert!(!plan.requires_confirmation);

    state.slots[0].concurrent_account_probe.remote_use = Sv2RemoteUseStatus::Detected;
    let conflicted = build_route_plan(path.to_str().unwrap(), &state).unwrap();
    assert_eq!(conflicted.selected_slot_id, None);

    state.slots[0].concurrent_account_probe.remote_use = Sv2RemoteUseStatus::Clear;
    state.slots[0].concurrent_session_protection.status =
        Sv2SessionProtectionStatus::RecoveryPending;
    let recovering = build_route_plan(path.to_str().unwrap(), &state).unwrap();
    assert_eq!(recovering.selected_slot_id, None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn account_mismatch_environment_is_never_routable() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "mismatch",
        "Mismatch account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.concurrent.ready = true;
    slot.concurrent_account_probe.session_status = Sv2SessionInspectionStatus::AccountMismatch;
    slot.concurrent_account_probe.remote_use = Sv2RemoteUseStatus::Unknown;
    slot.concurrent_account_probe.authorization_status = Sv2AuthorizationStatus::Unknown;
    slot.concurrent_account_probe.authorized_voices.clear();
    slot.concurrent_account_probe.authorized_voice_count = 0;
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;
    state.blockers.push(crate::sv2_profiles::Sv2ProcessBlocker {
        pid: Some(4242),
        name: "synthv-studio.exe".to_string(),
        reason: "test blocker".to_string(),
    });

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id, None);
    assert_eq!(plan.candidates[0].launch_mode, None);
    assert_eq!(
        plan.candidates[0].session_status,
        Sv2SessionInspectionStatus::AccountMismatch
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unsynchronized_environment_is_never_routable() {
    let (root, path) = voice_project("Mai 2");
    let mut slot = route_slot(
        "sync-failed",
        "Unsynchronized account",
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        &["Mai 2"],
        &[],
    );
    slot.concurrent.ready = true;
    slot.concurrent_account_probe.session_status = Sv2SessionInspectionStatus::SyncFailed;
    slot.concurrent_account_probe.remote_use = Sv2RemoteUseStatus::Unknown;
    slot.concurrent_account_probe.authorization_status = Sv2AuthorizationStatus::Unknown;
    slot.concurrent_account_probe.authorized_voices.clear();
    slot.concurrent_account_probe.authorized_voice_count = 0;
    let mut state = route_state(vec![slot]);
    state.concurrent_provider.available = true;
    state.blockers.push(crate::sv2_profiles::Sv2ProcessBlocker {
        pid: Some(4242),
        name: "synthv-studio.exe".to_string(),
        reason: "test blocker".to_string(),
    });

    let plan = build_route_plan(path.to_str().unwrap(), &state).unwrap();

    assert_eq!(plan.selected_slot_id, None);
    assert_eq!(plan.candidates[0].launch_mode, None);
    assert_eq!(
        plan.candidates[0].session_status,
        Sv2SessionInspectionStatus::SyncFailed
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn extracts_main_and_group_voice_requirements_without_instrumentals() {
    let (root, path) = write_project(serde_json::json!({
        "version": 187,
        "tracks": [{
            "mainRef": {"database": {"name": "Mai 2", "version": 104, "backendType": "sv2"}},
            "groups": [
                {"database": {"name": "SOLARIA", "version": "101", "backendType": "sv2"}},
                {"isInstrumental": true, "database": {"name": "Not a voice", "version": 1}}
            ]
        }]
    }));

    let (_, voices) = analyze_svp_project(path.to_str().unwrap()).unwrap();

    assert_eq!(voices.len(), 2);
    assert_eq!(voices[0].name, "Mai 2");
    assert_eq!(voices[0].version, Some(104));
    assert_eq!(voices[1].name, "SOLARIA");
    assert_eq!(voices[1].version, Some(101));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn confirmed_voice_names_are_deduplicated_without_fuzzy_aliasing() {
    let voices = validate_confirmed_voice_names(vec![
        "  Mai   2 ".to_string(),
        "mai 2".to_string(),
        "Mai".to_string(),
    ])
    .unwrap();
    assert_eq!(voices, vec!["Mai", "Mai 2"]);
}

#[test]
fn local_databases_are_not_treated_as_account_authorization() {
    let root = std::env::temp_dir().join(format!("svp-inventory-test-{}", Uuid::new_v4()));
    let version = root.join("databases").join("opaque-license-id").join("104");
    fs::create_dir_all(&version).unwrap();
    fs::write(version.join("model.dnni"), b"opaque").unwrap();

    let inventory = inspect_voice_inventory(&root, &[]);

    assert_eq!(inventory.status, Sv2VoiceInventoryStatus::Unknown);
    assert!(!inventory.detail.contains("opaque-license-id"));
    assert!(!inventory.detail.contains("安装"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn activation_resolves_one_relative_project_against_callback_cwd() {
    let (root, path) = write_project(serde_json::json!({"tracks": []}));
    let args = vec![
        "synthv-toolbox.exe".to_string(),
        "--svp-route".to_string(),
        path.file_name().unwrap().to_string_lossy().into_owned(),
    ];

    let activation = parse_svp_activation(&args, root.to_str()).unwrap().unwrap();

    assert_eq!(
        PathBuf::from(activation.project_path),
        path.canonicalize().unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn activation_ignores_normal_start_and_rejects_ambiguous_route_args() {
    assert!(
        parse_svp_activation(&["synthv-toolbox.exe".to_string()], None)
            .unwrap()
            .is_none()
    );
    let duplicate = vec![
        "--svp-route".to_string(),
        "first.svp".to_string(),
        "--svp-route".to_string(),
        "second.svp".to_string(),
    ];
    assert!(parse_svp_activation(&duplicate, None).is_err());
    let extra = vec![
        "--svp-route".to_string(),
        "project.svp".to_string(),
        "unexpected".to_string(),
    ];
    assert!(parse_svp_activation(&extra, None).is_err());
}

#[test]
fn project_route_requires_an_existing_svp_regular_file() {
    let root = std::env::temp_dir().join(format!("svp-path-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let wrong_extension = root.join("project.json");
    let uppercase_extension = root.join("project.SVP");
    fs::write(&wrong_extension, b"{}").unwrap();
    fs::write(&uppercase_extension, b"{}").unwrap();

    assert!(resolve_project_path(wrong_extension.to_str().unwrap(), None).is_err());
    assert!(resolve_project_path(root.to_str().unwrap(), None).is_err());
    assert!(resolve_project_path(uppercase_extension.to_str().unwrap(), None).is_ok());
    assert!(resolve_project_path(root.join("missing.svp").to_str().unwrap(), None).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn original_handler_cannot_point_back_to_toolbox() {
    assert!(validate_original_prog_id(TOOLBOX_SVP_PROG_ID).is_err());
    assert!(validate_original_prog_id("synthvtoolbox.svp\\shell").is_err());
    assert_eq!(
        validate_original_prog_id("Dreamtonics.svpfile").unwrap(),
        "Dreamtonics.svpfile"
    );
}
