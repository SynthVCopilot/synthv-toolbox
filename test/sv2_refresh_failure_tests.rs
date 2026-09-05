use super::*;
use base64::Engine;

fn fixture_credentials() -> SessionCredentials {
    let issued = DateTime::<Utc>::from_timestamp(Utc::now().timestamp() - 60, 0).unwrap();
    let encode = |claims| {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        format!("{header}.{payload}.c3ludGhldGljLXNpZw")
    };
    let access = encode(serde_json::json!({
        "exp": (issued + ChronoDuration::hours(1)).timestamp(),
        "iat": issued.timestamp(),
        "iss": TOKEN_ISSUER,
        "azp": "svstudio2-agent",
    }));
    let refresh = encode(serde_json::json!({
        "exp": (issued + ChronoDuration::days(1)).timestamp(),
        "iat": issued.timestamp(),
        "iss": TOKEN_ISSUER,
    }));
    parse_session_plaintext(Zeroizing::new(
        format!(
            "{access}\n{refresh}\n{}\n{}\n",
            (issued + ChronoDuration::hours(1)).to_rfc3339(),
            issued.to_rfc3339(),
        )
        .into_bytes(),
    ))
    .unwrap()
}

#[cfg(windows)]
#[test]
fn current_refresh_failure_is_visible_without_replacing_existing_quarantine() {
    let _guard = tests::PROBE_TEST_GATE.lock().unwrap();
    let fixture =
        std::env::temp_dir().join(format!("sv2-refresh-failure-{}", uuid::Uuid::new_v4()));
    let root = ProbeRootKey::AccountEnvironment {
        slot_id: "refresh-failure".to_string(),
        concurrent: false,
    };
    let fingerprint = SessionCacheKey {
        canonical_root: fixture.clone(),
        session_len: 12,
        last_write_time: 7,
    };
    let credentials = fixture_credentials();
    let old = Sv2AccountProbeView::sync_failed("previous rotation state");
    set_sync_quarantine(&root.quarantine_key(), &old);
    let current = record_session_refresh_failure(
        &root,
        &fingerprint,
        &credentials,
        refresh_failure_view(RefreshFailure::Unavailable(503)),
    );
    assert_eq!(current.session_status, Sv2SessionInspectionStatus::Offline);
    assert_eq!(
        sync_quarantine_get(&root.quarantine_key()).unwrap().detail,
        old.detail
    );
    assert_eq!(
        cached_view_for_fingerprint(&fingerprint, &root)
            .unwrap()
            .session_status,
        Sv2SessionInspectionStatus::Offline
    );
    probe_cache()
        .lock()
        .unwrap()
        .get_mut(&ProbeCacheKey::new(&fingerprint, &root))
        .unwrap()
        .stored_at = Instant::now() - Duration::from_secs(60);
    assert_eq!(
        cached_view_for_fingerprint(&fingerprint, &root)
            .unwrap()
            .session_status,
        Sv2SessionInspectionStatus::Offline
    );
    let request =
        Sv2AccountProbeRequest::for_account(&fixture, false, 0, false, "refresh-failure", false);
    assert_eq!(
        finish_batch_results(&[request], vec![Some(current)])[0].session_status,
        Sv2SessionInspectionStatus::Offline
    );
    let latest = Sv2AccountProbeView::sync_failed("latest rotation state");
    set_sync_quarantine(&root.quarantine_key(), &latest);
    assert_eq!(
        cached_view_for_fingerprint(&fingerprint, &root)
            .unwrap()
            .detail,
        latest.detail
    );
    clear_sync_quarantine(&root.quarantine_key());
    assert!(cached_view_for_fingerprint(&fingerprint, &root).is_none());
}
