use super::*;

#[cfg(windows)]
#[test]
#[ignore = "refreshes the explicitly supplied real SV2 session"]
fn expired_real_session_refreshes_before_license_access() {
    assert_eq!(
        std::env::var("SV2_DIAGNOSTIC_REFRESH").as_deref(),
        Ok("true"),
        "set SV2_DIAGNOSTIC_REFRESH=true to allow token refresh and session writeback"
    );
    let root = PathBuf::from(std::env::var("SV2_DIAGNOSTIC_ROOT").expect("explicit root required"));
    assert!(root.is_absolute());
    let key = read_machine_key().expect("machine key unavailable");
    let (encrypted, before) = read_stable_session(&root)
        .unwrap()
        .expect("session missing");
    let original = decrypt_session(encrypted, &key)
        .and_then(parse_session_plaintext)
        .expect("session unavailable");
    assert!(
        original.access_expires_at <= Utc::now(),
        "requires expired access"
    );
    let expected_account = account_group_key(original.access_token()).expect("account missing");

    let view = refresh_sv2_account_probe(&root, true);
    let (encrypted, after) = read_stable_session(&root)
        .unwrap()
        .expect("session missing");
    let current = decrypt_session(encrypted, &key)
        .and_then(parse_session_plaintext)
        .expect("written session unreadable");
    let renewed = current.access_expires_at > Utc::now() + ChronoDuration::seconds(60);
    eprintln!(
        "SV2 refresh diagnostic: renewed={renewed}, session_changed={}, status={:?}, authorization={:?}, authorized_count={}",
        before != after,
        view.session_status,
        view.authorization_status,
        view.authorized_voice_count,
    );
    assert!(
        renewed,
        "token refresh did not produce a usable access token"
    );
    assert!(before != after, "refreshed session was not persisted");
    assert!(account_group_key(current.access_token()) == Some(expected_account));
    assert!(current.refresh_token() != original.refresh_token());
    assert_eq!(view.authorization_status, Sv2AuthorizationStatus::Verified);
}
