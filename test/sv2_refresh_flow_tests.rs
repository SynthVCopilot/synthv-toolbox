use super::*;
use std::cell::{Cell, RefCell};

fn credentials(expired: bool, generation: &str) -> SessionCredentials {
    let issued = DateTime::<Utc>::from_timestamp(Utc::now().timestamp() - 120, 0).unwrap();
    let expiry = issued + ChronoDuration::seconds(if expired { 60 } else { 3600 });
    let token = |expiry: DateTime<Utc>| {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss": TOKEN_ISSUER, "azp": "svstudio2-agent", "sub": "fixture-account",
                "iat": issued.timestamp(), "exp": expiry.timestamp(), "jti": generation
            }))
            .unwrap(),
        );
        format!("{header}.{payload}.c3ludGhldGljLXNpZw")
    };
    parse_session_plaintext(Zeroizing::new(
        format!(
            "{}\n{}\n{}\n{}\n",
            token(expiry),
            token(issued + ChronoDuration::days(1)),
            expiry.to_rfc3339(),
            issued.to_rfc3339(),
        )
        .into_bytes(),
    ))
    .unwrap()
}

struct Fixture {
    path: PathBuf,
    root: ProbeRootKey,
    fingerprint: SessionCacheKey,
    original: SessionCredentials,
    key: [u8; 8],
}

impl Fixture {
    fn new(expired: bool) -> Self {
        let path = std::env::temp_dir().join(format!("sv2-refresh-flow-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("license")).unwrap();
        let key = *b"fixture8";
        let original = credentials(expired, "original");
        fs::write(
            path.join("license/session"),
            &*encrypt_session(original.buffer.as_bytes(), &key).unwrap(),
        )
        .unwrap();
        let (_, fingerprint) = read_stable_session(&path).unwrap().unwrap();
        let root = ProbeRootKey::CanonicalRoot(fingerprint.canonical_root.clone());
        Self {
            path,
            root,
            fingerprint,
            original,
            key,
        }
    }

    fn source(&self) -> SessionProbeSource<'_> {
        SessionProbeSource {
            data_root: &self.path,
            root: &self.root,
            fingerprint: &self.fingerprint,
            credentials: &self.original,
            key: &self.key,
        }
    }

    fn current(&self) -> SessionCredentials {
        let (encrypted, _) = read_stable_session(&self.path).unwrap().unwrap();
        decrypt_session(encrypted, &self.key)
            .and_then(parse_session_plaintext)
            .unwrap()
    }

    fn replace(&self, credentials: &SessionCredentials) -> Vec<u8> {
        let encrypted = encrypt_session(credentials.buffer.as_bytes(), &self.key).unwrap();
        fs::write(self.path.join("license/session"), &*encrypted).unwrap();
        encrypted.to_vec()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        clear_sync_quarantine(&self.root.quarantine_key());
        assert!(self.path.starts_with(std::env::temp_dir()));
        assert!(self
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("sv2-refresh-flow-"));
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn expired_active_and_idle_sessions_refresh_write_then_read_with_new_token() {
    let _guard = tests::PROBE_TEST_GATE.lock().unwrap();
    for active in [false, true] {
        let fixture = Fixture::new(true);
        let events = RefCell::new(Vec::new());
        let view = inspect_session_authorization(
            &fixture.source(),
            active,
            |original| {
                assert!(original.refresh_token() == fixture.original.refresh_token());
                events.borrow_mut().push("refresh");
                Ok(credentials(false, "renewed"))
            },
            |access| {
                events.borrow_mut().push("licenses");
                let current = fixture.current();
                assert!(access == current.access_token());
                assert!(current.refresh_token() != fixture.original.refresh_token());
                RemoteOutcome::Authorized(vec!["Fixture Voice".to_string()])
            },
        );
        assert_eq!(*events.borrow(), ["refresh", "licenses"]);
        assert_eq!(view.authorization_status, Sv2AuthorizationStatus::Verified);
        assert_eq!(
            view.session_status,
            if active {
                Sv2SessionInspectionStatus::InUse
            } else {
                Sv2SessionInspectionStatus::Ready
            }
        );
    }
}

#[test]
fn fresh_rejected_access_refreshes_once_and_never_loops_on_second_rejection() {
    let _guard = tests::PROBE_TEST_GATE.lock().unwrap();
    for active in [false, true] {
        for reject_again in [false, true] {
            let fixture = Fixture::new(false);
            let refreshes = Cell::new(0);
            let reads = Cell::new(0);
            let view = inspect_session_authorization(
                &fixture.source(),
                active,
                |_| {
                    refreshes.set(refreshes.get() + 1);
                    Ok(credentials(false, "renewed"))
                },
                |access| {
                    reads.set(reads.get() + 1);
                    if reads.get() == 1 {
                        assert_eq!(refreshes.get(), 0);
                        assert!(access == fixture.original.access_token());
                        RemoteOutcome::Unauthorized
                    } else {
                        assert_eq!(refreshes.get(), 1);
                        assert!(access == fixture.current().access_token());
                        if reject_again {
                            RemoteOutcome::Unauthorized
                        } else {
                            RemoteOutcome::Authorized(Vec::new())
                        }
                    }
                },
            );
            assert_eq!(refreshes.get(), 1);
            assert_eq!(reads.get(), 2);
            assert_eq!(
                view.authorization_status,
                if reject_again {
                    Sv2AuthorizationStatus::Unknown
                } else {
                    Sv2AuthorizationStatus::Verified
                }
            );
        }
    }
}

#[test]
fn expired_refresh_failures_stop_before_license_access_without_writing() {
    let _guard = tests::PROBE_TEST_GATE.lock().unwrap();
    for failure in [
        RefreshFailure::Expired,
        RefreshFailure::Unavailable(503),
        RefreshFailure::Ambiguous,
    ] {
        let fixture = Fixture::new(true);
        let before = fs::read(fixture.path.join("license/session")).unwrap();
        let view = inspect_session_authorization(
            &fixture.source(),
            true,
            |_| Err(failure),
            |_| panic!("must not query licenses"),
        );
        assert_eq!(
            fs::read(fixture.path.join("license/session")).unwrap(),
            before
        );
        assert_eq!(view.authorization_status, Sv2AuthorizationStatus::Unknown);
        assert_eq!(
            sync_quarantine_get(&fixture.root.quarantine_key()).is_some(),
            matches!(failure, RefreshFailure::Ambiguous)
        );
    }
}

#[test]
fn changed_session_before_refresh_does_not_send_a_stale_refresh_token() {
    let _guard = tests::PROBE_TEST_GATE.lock().unwrap();
    let fixture = Fixture::new(true);
    let external = fixture.replace(&credentials(false, "external"));
    inspect_session_authorization(
        &fixture.source(),
        true,
        |_| panic!("must not refresh a changed source"),
        |_| panic!("must not query licenses"),
    );
    assert_eq!(
        fs::read(fixture.path.join("license/session")).unwrap(),
        external
    );
}

#[test]
fn changed_session_during_refresh_is_not_overwritten_or_used_for_license_access() {
    let _guard = tests::PROBE_TEST_GATE.lock().unwrap();
    let fixture = Fixture::new(true);
    let external = RefCell::new(Vec::new());
    let view = inspect_session_authorization(
        &fixture.source(),
        true,
        |_| {
            *external.borrow_mut() = fixture.replace(&credentials(false, "external"));
            Ok(credentials(false, "renewed"))
        },
        |_| panic!("must not query licenses after failed writeback"),
    );
    assert_eq!(view.session_status, Sv2SessionInspectionStatus::SyncFailed);
    assert_eq!(
        fs::read(fixture.path.join("license/session")).unwrap(),
        *external.borrow()
    );
}

#[test]
fn renewed_token_rejected_by_license_service_is_not_refreshed_again() {
    let _guard = tests::PROBE_TEST_GATE.lock().unwrap();
    let fixture = Fixture::new(true);
    let reads = Cell::new(0);
    let view = inspect_session_authorization(
        &fixture.source(),
        true,
        |_| Ok(credentials(false, "renewed")),
        |_| {
            reads.set(reads.get() + 1);
            RemoteOutcome::Unauthorized
        },
    );
    assert_eq!(reads.get(), 1);
    assert_eq!(view.session_status, Sv2SessionInspectionStatus::Invalid);
    assert!(fixture.current().refresh_token() != fixture.original.refresh_token());
}
