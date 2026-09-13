use super::*;

#[test]
fn offline_cache_format_uses_only_the_verified_permanent_layout() {
    let line = "K1=license;K2=product;K3=Synthesizer V Studio 2 Pro;K4=Dreamtonics;K5=editor;K6=2.2.1;K7=2;K8=0;K9=0";
    let parsed = parse_offline_cached_product(&line).unwrap();
    assert_eq!(parsed.database_id, "license");
    assert_eq!(parsed.attributes.len(), 3);
    assert_eq!(parsed.attributes[0].key, "K7");
}

#[test]
fn toggle_response_rejects_a_different_device_before_local_write() {
    let body = br#"{"status":200,"data":{"id":"other","native_product":"Synthesizer V Studio 2 Pro","offline_license_enabled":true}}"#;
    assert!(sv2_offline_license::parse_toggle_response(200, body, Some("current")).is_err());
}

#[test]
#[ignore = "requires explicit SV2_OFFLINE_LIVE_ACTION plus data and backup roots"]
fn live_offline_license_diagnostic() {
    let action = std::env::var("SV2_OFFLINE_LIVE_ACTION")
        .expect("set SV2_OFFLINE_LIVE_ACTION=inspect|activate|deactivate");
    let data_root = std::path::PathBuf::from(
        std::env::var("SV2_OFFLINE_LIVE_DATA_ROOT").expect("set SV2_OFFLINE_LIVE_DATA_ROOT"),
    );
    let backup_root = std::path::PathBuf::from(
        std::env::var("SV2_OFFLINE_LIVE_BACKUP_ROOT").expect("set SV2_OFFLINE_LIVE_BACKUP_ROOT"),
    );
    match action.as_str() {
        "inspect" => {
            let status = inspect_offline_license(&data_root, false).unwrap();
            eprintln!(
                "offline status enabled={} eligible={} current_device={}",
                status.enabled, status.eligible, status.current_device
            );
        }
        "activate" | "deactivate" => {
            let result =
                set_offline_license(&data_root, &backup_root, action == "activate", false).unwrap();
            eprintln!(
                "offline status enabled={} access_changed={} refresh_changed={} backup={}",
                result.status.enabled,
                result.access_changed,
                result.refresh_changed,
                result.backup_path
            );
        }
        _ => panic!("SV2_OFFLINE_LIVE_ACTION must be inspect, activate, or deactivate"),
    }
}
