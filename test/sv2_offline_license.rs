use super::*;

struct MockTransport {
    devices: &'static [u8],
}
impl OfflineTransport for MockTransport {
    fn get(&self, url: &str, _: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
        let body = if url == DEVICES_URL {
            self.devices
        } else {
            br#"{"status":200,"data":[]}"#
        };
        Ok((200, Zeroizing::new(body.to_vec())))
    }
    fn post(&self, _: &str, _: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
        Err("timeout".to_string())
    }
}

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
fn remote_device_state_separates_server_enablement_from_local_identity() {
    let other = MockTransport { devices: br#"{"status":200,"data":{"offline_license_devices":[{"id":"other","offline_license_enabled":true}]}}"# };
    let state = current_device(&other, "access", Some("current")).unwrap();
    assert!(state.enabled);
    assert!(!state.current_device);
    let empty = MockTransport {
        devices: br#"{"status":200,"data":{"offline_license_devices":[]}}"#,
    };
    let state = current_device(&empty, "access", Some("current")).unwrap();
    assert!(!state.enabled);
    assert!(state.current_device);
}

#[test]
fn body_status_must_confirm_the_http_success() {
    let body = br#"{"status":201,"data":{"id":"current","native_product":"Synthesizer V Studio 2 Pro","offline_license_enabled":true}}"#;
    assert!(parse_toggle_response(200, body, Some("current")).is_err());
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
