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

#[cfg(windows)]
mod write_flow {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::cell::Cell;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct Server {
        enabled: Cell<bool>,
        posts: Cell<u32>,
        fail: bool,
    }
    impl OfflineTransport for Server {
        fn get(&self, url: &str, _: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
            let text = if url == LICENSES_URL {
                r#"{"status":200,"data":[{"id":"license","status":"active","license_type":"permanent","valid_to":null,"product":{"id":"product","name":"Synthesizer V Studio 2 Pro","vendor":"Dreamtonics","type":"Synthesizer V Editor","version":{"version_name":"2"}}}]}"#.to_owned()
            } else if self.enabled.get() {
                r#"{"status":200,"data":{"offline_license_devices":[{"id":"device","device_name":"test","offline_license_enabled":true}]}}"#.to_owned()
            } else {
                r#"{"status":200,"data":{"offline_license_devices":[]}}"#.to_owned()
            };
            Ok((200, Zeroizing::new(text.into_bytes())))
        }
        fn post(&self, url: &str, _: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
            self.posts.set(self.posts.get() + 1);
            if self.fail {
                return Err("synthetic timeout".to_string());
            }
            let enabled = url == ACTIVATE_URL;
            self.enabled.set(enabled);
            Ok((200, Zeroizing::new(format!(r#"{{"status":200,"data":{{"id":"device","native_product":"Synthesizer V Studio 2 Pro","offline_license_enabled":{enabled}}}}}"#).into_bytes())))
        }
    }
    fn root() -> PathBuf {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".tmp")
            .join("offline-license")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(path.join("data/license")).unwrap();
        fs::create_dir_all(path.join("backups")).unwrap();
        path
    }
    fn jwt(exp: i64, sub: &str) -> String {
        let head = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let body = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({"exp":exp,"iat":exp-60,"sub":sub})).unwrap(),
        );
        format!("{head}.{body}.c3ludGhldGljLXNpZw")
    }
    fn fixture(root: &std::path::Path, expired: bool) -> Vec<u8> {
        let now = Utc::now().timestamp();
        let exp = if expired { now - 10 } else { now + 3600 };
        let access = jwt(exp, "user");
        let refresh = jwt(now + 7200, "user");
        let plain = format!(
            "{access}\n{refresh}\n{}\n{}\ndevice",
            DateTime::<Utc>::from_timestamp(exp, 0)
                .unwrap()
                .to_rfc3339(),
            Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
        let key = read_machine_key().unwrap();
        let encrypted = encrypt_session(plain.as_bytes(), &key).unwrap();
        fs::write(root.join("data/license/session"), &*encrypted).unwrap();
        encrypted.to_vec()
    }
    #[test]
    fn enable_then_disable_preserves_tokens_and_creates_verified_backups() {
        let root = root();
        let initial = fixture(&root, false);
        let server = Server {
            enabled: Cell::new(false),
            posts: Cell::new(0),
            fail: false,
        };
        let on = set_with_transport(
            &root.join("data"),
            &root.join("backups"),
            true,
            false,
            &server,
        )
        .unwrap();
        assert!(on.status.enabled);
        assert_eq!(on.access_changed, false);
        let (enabled, _) = read_credentials(&root.join("data")).unwrap();
        assert!(enabled.has_full_cache());
        assert_eq!(enabled.buffer.lines().count(), 7);
        let off = set_with_transport(
            &root.join("data"),
            &root.join("backups"),
            false,
            false,
            &server,
        )
        .unwrap();
        assert!(!off.status.enabled);
        let now = fs::read(root.join("data/license/session")).unwrap();
        assert_ne!(now, initial);
        let (disabled, _) = read_credentials(&root.join("data")).unwrap();
        assert!(!disabled.has_full_cache());
        assert_eq!(disabled.buffer.lines().count(), 5);
        assert!(fs::read_dir(root.join("backups"))
            .unwrap()
            .all(|entry| entry
                .unwrap()
                .path()
                .join("sv2-data-backup-manifest.json")
                .is_file()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn post_failure_keeps_session_and_retains_backup() {
        let root = root();
        let initial = fixture(&root, false);
        let server = Server {
            enabled: Cell::new(false),
            posts: Cell::new(0),
            fail: true,
        };
        let error = set_with_transport(
            &root.join("data"),
            &root.join("backups"),
            true,
            false,
            &server,
        )
        .unwrap_err();
        assert_eq!(
            fs::read(root.join("data/license/session")).unwrap(),
            initial
        );
        assert!(error.contains("备份"));
        assert_eq!(server.posts.get(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn expired_and_in_use_never_post() {
        let root = root();
        fixture(&root, true);
        let server = Server {
            enabled: Cell::new(false),
            posts: Cell::new(0),
            fail: false,
        };
        assert!(set_with_transport(
            &root.join("data"),
            &root.join("backups"),
            true,
            false,
            &server
        )
        .is_err());
        assert!(set_with_transport(
            &root.join("data"),
            &root.join("backups"),
            true,
            true,
            &server
        )
        .is_err());
        assert_eq!(server.posts.get(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    struct CasServer {
        path: PathBuf,
    }
    impl OfflineTransport for CasServer {
        fn get(&self, url: &str, _: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
            Server {
                enabled: Cell::new(false),
                posts: Cell::new(0),
                fail: false,
            }
            .get(url, "")
        }
        fn post(&self, _: &str, _: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
            fs::write(&self.path, b"changed-by-post").unwrap();
            Ok((200, Zeroizing::new(br#"{"status":200,"data":{"id":"device","native_product":"Synthesizer V Studio 2 Pro","offline_license_enabled":true}}"#.to_vec())))
        }
    }
    #[test]
    fn post_time_session_change_is_not_overwritten() {
        let root = root();
        fixture(&root, false);
        let session = root.join("data/license/session");
        let server = CasServer {
            path: session.clone(),
        };
        assert!(set_with_transport(
            &root.join("data"),
            &root.join("backups"),
            true,
            false,
            &server
        )
        .is_err());
        assert_eq!(fs::read(session).unwrap(), b"changed-by-post");
        fs::remove_dir_all(root).unwrap();
    }
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
