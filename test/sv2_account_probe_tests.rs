use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::TimeZone;

static PROBE_TEST_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn make_jwt(exp: Option<i64>, iat: i64) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&serde_json::json!({ "exp": exp, "iat": iat })).unwrap());
    format!("{header}.{payload}.c3ludGhldGljLXNpZw")
}

fn make_claims_jwt(claims: serde_json::Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    format!("{header}.{payload}.c3ludGhldGljLXNpZw")
}

fn make_identity_jwt(
    exp: Option<i64>,
    iat: i64,
    subject: Option<&str>,
    sid: Option<&str>,
    session_state: Option<&str>,
) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "exp": exp,
            "iat": iat,
            "sub": subject,
            "sid": sid,
            "session_state": session_state,
        }))
        .unwrap(),
    );
    format!("{header}.{payload}.c3ludGhldGljLXNpZw")
}

fn make_plaintext(
    access_exp: DateTime<Utc>,
    refresh_exp: DateTime<Utc>,
    issued: DateTime<Utc>,
) -> String {
    let access = make_jwt(Some(access_exp.timestamp()), issued.timestamp());
    let refresh = make_jwt(Some(refresh_exp.timestamp()), issued.timestamp());
    format!(
        "{access}\n{refresh}\n{}\n{}\n",
        access_exp.to_rfc3339(),
        issued.to_rfc3339()
    )
}

fn make_identity_plaintext(
    access_exp: DateTime<Utc>,
    issued: DateTime<Utc>,
    subject: &str,
    sid: &str,
    extension: &str,
) -> String {
    let access = make_identity_jwt(
        Some(access_exp.timestamp()),
        issued.timestamp(),
        Some(subject),
        Some(sid),
        None,
    );
    let refresh = make_jwt(None, issued.timestamp());
    format!(
        "{access}\n{refresh}\n{}\n{}\n{extension}",
        access_exp.to_rfc3339(),
        issued.to_rfc3339()
    )
}

#[cfg(windows)]
fn batch_session(
    request_index: usize,
    account_scope: usize,
    preferred_source: bool,
    subject: &str,
    sid: &str,
    issued_offset_minutes: i64,
) -> BatchSession {
    let base = Utc.with_ymd_and_hms(2099, 1, 2, 3, 0, 0).single().unwrap();
    let issued = base + ChronoDuration::minutes(issued_offset_minutes);
    let credentials = parse_session_plaintext(Zeroizing::new(
        make_identity_plaintext(
            issued + ChronoDuration::hours(1),
            issued,
            subject,
            sid,
            "device-id",
        )
        .into_bytes(),
    ))
    .unwrap();
    let subject_key = account_group_key(credentials.access_token()).unwrap();
    let slot_id = format!("slot-{account_scope}");
    BatchSession {
        request_index,
        data_root: PathBuf::from(format!("synthetic-{request_index}")),
        fingerprint: SessionCacheKey {
            canonical_root: PathBuf::from(format!("synthetic-{request_index}")),
            session_len: 8,
            last_write_time: request_index as u64,
        },
        root_key: ProbeRootKey::AccountEnvironment {
            slot_id: slot_id.clone(),
            concurrent: !preferred_source,
        },
        quarantine_key: SyncQuarantineKey::AccountSlot(slot_id),
        credentials,
        group: BatchGroupKey::Account(account_scope, subject_key),
        account_scope: Some(account_scope),
        preferred_source,
        sync_quarantined: false,
    }
}

fn encrypt_fixture(plaintext: &[u8], key: &[u8; 8]) -> Zeroizing<Vec<u8>> {
    encrypt_session(plaintext, key).unwrap()
}

fn smbios_structure(kind: u8, mut formatted: Vec<u8>, strings: &[&str]) -> Vec<u8> {
    formatted[0] = kind;
    formatted[1] = formatted.len() as u8;
    let mut structure = formatted;
    for value in strings {
        structure.extend_from_slice(value.as_bytes());
        structure.push(0);
    }
    structure.push(0);
    if strings.is_empty() {
        structure.push(0);
    }
    structure
}

fn synthetic_smbios() -> Vec<u8> {
    let mut table = Vec::new();

    let mut type1 = vec![0u8; 0x19];
    type1[4] = 1;
    type1[5] = 2;
    for (index, byte) in type1[8..24].iter_mut().enumerate() {
        *byte = index as u8;
    }
    table.extend(smbios_structure(1, type1, &["SysMaker", "SysProduct"]));

    let mut type2 = vec![0u8; 0x09];
    type2[4] = 1;
    type2[5] = 2;
    type2[6] = 3;
    type2[7] = 4;
    type2[8] = 5;
    table.extend(smbios_structure(
        2,
        type2,
        &[
            "BoardMaker",
            "BoardName",
            "BoardVer",
            "BoardSerial",
            "BoardAsset",
        ],
    ));

    let mut type4 = vec![0u8; 0x23];
    type4[7] = 1;
    type4[0x10] = 2;
    type4[0x21] = 3;
    type4[0x22] = 4;
    table.extend(smbios_structure(
        4,
        type4,
        &["CpuSocket", "CpuVersion", "CpuSerial", "CpuAsset"],
    ));
    table.extend(smbios_structure(127, vec![0u8; 4], &[]));

    let mut raw = vec![0u8, 3, 8, 0];
    raw.extend_from_slice(&(table.len() as u32).to_le_bytes());
    raw.extend(table);
    raw
}

#[test]
fn juce_hash_and_smbios_machine_key_are_deterministic() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    assert_eq!(juce_hash64("abc"), 999_494);
    let raw = synthetic_smbios();
    let material = collect_juce_machine_material(&raw).unwrap();
    assert_eq!(
        &*material,
        concat!(
            "SysMaker\nSysProduct\n000102030405060708090A0B0C0D0E0F\n",
            "BoardMaker\nBoardName\nBoardVer\nBoardSerial\nBoardAsset\n",
            "CpuSocket\nCpuVersion\nCpuSerial\nCpuAsset\n"
        )
    );
    let key = derive_machine_key_from_raw_smbios(&raw).unwrap();
    let first = juce_hash64(&material) as i64;
    assert_eq!(&*key, &juce_hash64(&first.to_string()).to_le_bytes());
}

#[test]
fn blowfish_codec_uses_juce_word_order_and_strict_pkcs7() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let key = *b"12345678";
    let plaintext = b"synthetic session fixture";
    let encrypted = encrypt_fixture(plaintext, &key);
    let decrypted = decrypt_session(encrypted.clone(), &key).unwrap();
    assert_eq!(&*decrypted, plaintext);

    let mut corrupted = encrypted;
    let last = corrupted.len() - 1;
    corrupted[last] ^= 0x01;
    assert!(decrypt_session(corrupted, &key).is_err());
}

#[test]
fn session_parser_accepts_device_extensions_and_validates_token_times() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let issued = DateTime::<Utc>::from_timestamp(Utc::now().timestamp(), 0).unwrap();
    let access_expires = issued + ChronoDuration::hours(1);
    let refresh_expires = issued + ChronoDuration::days(31);
    let plaintext = make_plaintext(access_expires, refresh_expires, issued);
    let credentials =
        parse_session_plaintext(Zeroizing::new(plaintext.clone().into_bytes())).unwrap();
    assert!(credentials.access_token().starts_with("ey"));
    assert!(credentials.refresh_token().starts_with("ey"));
    assert_eq!(credentials.access_expires_at, access_expires);
    assert!(credentials.device_id().is_none());
    assert!(!credentials.has_full_cache());

    let missing_device_field = plaintext.trim_end_matches('\n').to_string();
    assert!(parse_session_plaintext(Zeroizing::new(missing_device_field.into_bytes())).is_err());

    let mut full_cache = plaintext.trim_end_matches('\n').to_string();
    full_cache.push_str("\ndevice-id\nuser-id\ncache-record-a\ncache-record-b");
    let full = parse_session_plaintext(Zeroizing::new(full_cache.into_bytes())).unwrap();
    assert_eq!(full.device_id(), Some("device-id"));
    assert_eq!(full.user_id(), Some("user-id"));
    assert!(full.has_full_cache());
    let updated = full
        .with_enrollment_identity("new-device-id", "new-user-id")
        .unwrap();
    assert_eq!(updated.device_id(), Some("new-device-id"));
    assert_eq!(updated.user_id(), Some("new-user-id"));
    assert!(updated.buffer.ends_with("cache-record-a\ncache-record-b"));

    let mismatch = plaintext.replacen(&access_expires.to_rfc3339(), &issued.to_rfc3339(), 1);
    assert!(parse_session_plaintext(Zeroizing::new(mismatch.into_bytes())).is_err());

    let invalid_written_time = plaintext.replacen(&issued.to_rfc3339(), "not-a-time", 1);
    assert!(parse_session_plaintext(Zeroizing::new(invalid_written_time.into_bytes())).is_err());

    let key = *b"12345678";
    let mut encrypted = encrypt_fixture(plaintext.as_bytes(), &key);
    let last = encrypted.len() - 1;
    encrypted[last] = 0;
    assert!(decrypt_session(encrypted, &key).is_err());
}

#[test]
fn account_group_uses_subject_not_environment_login_id() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let issued = 4_070_908_800_i64;
    let first = make_identity_jwt(
        Some(issued + 1800),
        issued,
        Some("synthetic-subject"),
        Some("synthetic-login"),
        None,
    );
    let rotated = make_identity_jwt(
        Some(issued + 3600),
        issued + 1800,
        Some("synthetic-subject"),
        Some("synthetic-login"),
        None,
    );
    let fallback = make_identity_jwt(
        Some(issued + 3600),
        issued + 1800,
        Some("synthetic-subject"),
        None,
        Some("synthetic-login"),
    );
    let other_login = make_identity_jwt(
        Some(issued + 3600),
        issued + 1800,
        Some("synthetic-subject"),
        Some("other-login"),
        None,
    );
    let other_subject = make_identity_jwt(
        Some(issued + 3600),
        issued + 1800,
        Some("other-subject"),
        Some("synthetic-login"),
        None,
    );
    let missing_login = make_identity_jwt(
        Some(issued + 3600),
        issued + 1800,
        Some("synthetic-subject"),
        None,
        None,
    );
    let missing_subject = make_identity_jwt(
        Some(issued + 3600),
        issued + 1800,
        None,
        Some("synthetic-login"),
        None,
    );

    let first_key: [u8; 32] = account_group_key(&first).unwrap();
    assert_eq!(account_group_key(&rotated), Some(first_key));
    assert_eq!(account_group_key(&fallback), Some(first_key));
    assert_eq!(account_group_key(&other_login), Some(first_key));
    assert_ne!(account_group_key(&other_subject), Some(first_key));
    assert_eq!(account_group_key(&missing_login), Some(first_key));
    assert_eq!(account_group_key(&missing_subject), None);
    #[cfg(windows)]
    assert_ne!(
        BatchGroupKey::Account(0, first_key),
        BatchGroupKey::Account(1, first_key),
        "the same account in different slots must never share file writes",
    );
}

#[test]
fn account_identity_extracts_sanitized_standard_claims_without_echoing_the_jwt() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let access_token = make_claims_jwt(serde_json::json!({
        "sub": "synthetic-subject",
        "name": "  音制   夏师傅  ",
        "preferred_username": "unused-fallback",
        "email": "  account@example.test  ",
        "private": "DO_NOT_EXPOSE_PRIVATE_CLAIM"
    }));

    let identity = account_identity(&access_token).unwrap();
    assert_eq!(identity.display_name.as_deref(), Some("音制 夏师傅"));
    assert_eq!(identity.email.as_deref(), Some("account@example.test"));

    let view = Sv2AccountProbeView::not_checked(true).with_account_identity(&access_token);
    let serialized = serde_json::to_string(&view).unwrap();
    assert_eq!(view.account_display_name.as_deref(), Some("音制 夏师傅"));
    assert_eq!(view.account_email.as_deref(), Some("account@example.test"));
    let public_view: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(public_view["accountDisplayName"], "音制 夏师傅");
    assert_eq!(public_view["accountEmail"], "account@example.test");
    assert!(!serialized.contains(&access_token));
    assert!(!serialized.contains("DO_NOT_EXPOSE_PRIVATE_CLAIM"));
}

#[test]
fn account_identity_rejects_unsafe_claims_and_uses_username_fallback() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let overlong_name = "x".repeat(161);
    let access_token = make_claims_jwt(serde_json::json!({
        "name": overlong_name,
        "preferred_username": "  safe   fallback  ",
        "email": "unsafe <account@example.test>"
    }));
    let identity = account_identity(&access_token).unwrap();
    assert_eq!(identity.display_name.as_deref(), Some("safe fallback"));
    assert_eq!(identity.email, None);

    assert_eq!(normalize_account_name("\t\n"), None);
    assert_eq!(normalize_account_name(&"x".repeat(161)), None);
    assert_eq!(normalize_account_email("missing-at.example.test"), None);
    assert_eq!(normalize_account_email("a b@example.test"), None);
    assert!(account_identity("not-a-jwt").is_none());
    assert!(account_identity(&make_claims_jwt(serde_json::json!({}))).is_none());
}

#[cfg(windows)]
#[test]
fn batch_plan_merges_different_login_ids_only_within_one_slot() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let same_slot = vec![
        batch_session(0, 7, true, "same-subject", "normal-login", 0),
        batch_session(1, 7, false, "same-subject", "sandbox-login", 20),
    ];
    let plan = plan_batch_sessions(&same_slot);
    assert_eq!(plan.groups.len(), 1);
    assert_eq!(plan.groups.values().next().unwrap(), &vec![0, 1]);
    assert!(plan.mismatches.is_empty());

    let different_slots = vec![
        batch_session(0, 7, true, "same-subject", "first-login", 0),
        batch_session(1, 8, true, "same-subject", "second-login", 20),
    ];
    let plan = plan_batch_sessions(&different_slots);
    assert_eq!(plan.groups.len(), 2);
    assert!(plan.mismatches.is_empty());
}

#[cfg(windows)]
#[test]
fn batch_plan_quarantines_a_different_account_without_a_second_group() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let sessions = vec![
        batch_session(0, 7, true, "primary-subject", "normal-login", 0),
        batch_session(1, 7, false, "other-subject", "sandbox-login", 20),
    ];
    let plan = plan_batch_sessions(&sessions);

    assert_eq!(plan.groups.len(), 1);
    assert_eq!(plan.groups.values().next().unwrap(), &vec![0]);
    assert_eq!(plan.mismatches, vec![1]);
    assert!(plan.invalid_scope_members.is_empty());
}

#[cfg(windows)]
#[test]
fn batch_plan_rejects_duplicate_primary_sources() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let sessions = vec![
        batch_session(0, 7, true, "same-subject", "first-login", 0),
        batch_session(1, 7, true, "same-subject", "second-login", 20),
    ];
    let plan = plan_batch_sessions(&sessions);

    assert!(plan.groups.is_empty());
    assert!(plan.mismatches.is_empty());
    assert_eq!(plan.invalid_scope_members, vec![0, 1]);
}

#[cfg(windows)]
#[test]
fn identical_slot_roots_are_one_physical_probe_authority() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let root = PathBuf::from("C:/synthetic/slot-authority");
    assert!(is_equivalent_session_root(Some(7), &root, Some(7), &root,));
    assert!(!is_equivalent_session_root(Some(7), &root, Some(8), &root,));
    assert!(!is_equivalent_session_root(
        Some(7),
        &root,
        Some(7),
        Path::new("C:/synthetic/another-slot"),
    ));
}

#[cfg(windows)]
#[test]
fn sync_quarantine_overrides_changed_fingerprints_until_repaired() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let unique = uuid::Uuid::new_v4();
    let slot_id = format!("slot-{unique}");
    let root_key = ProbeRootKey::AccountEnvironment {
        slot_id: slot_id.clone(),
        concurrent: false,
    };
    let concurrent_root_key = ProbeRootKey::AccountEnvironment {
        slot_id: slot_id.clone(),
        concurrent: true,
    };
    let quarantine_key = SyncQuarantineKey::AccountSlot(slot_id);
    let old_fingerprint = SessionCacheKey {
        canonical_root: PathBuf::from(format!("synthetic-canonical-{unique}")),
        session_len: 8,
        last_write_time: 10,
    };
    let moved_fingerprint = SessionCacheKey {
        canonical_root: PathBuf::from(format!("synthetic-parked-{unique}")),
        session_len: 16,
        last_write_time: 20,
    };
    let ready = Sv2AccountProbeView::not_checked(true);
    cache_put(moved_fingerprint.clone(), &root_key, &ready, None);
    cache_put(
        moved_fingerprint.clone(),
        &concurrent_root_key,
        &ready,
        None,
    );
    let failed = Sv2AccountProbeView::sync_failed("synthetic sync quarantine");
    set_sync_quarantine(&quarantine_key, &failed);

    assert_eq!(
        cached_view_for_fingerprint(&moved_fingerprint, &root_key)
            .unwrap()
            .session_status,
        Sv2SessionInspectionStatus::SyncFailed
    );
    assert_eq!(
        cached_view_for_fingerprint(&moved_fingerprint, &concurrent_root_key)
            .unwrap()
            .session_status,
        Sv2SessionInspectionStatus::SyncFailed
    );
    clear_sv2_account_probe_cache();
    assert_eq!(
        cached_view_for_fingerprint(&old_fingerprint, &root_key)
            .unwrap()
            .session_status,
        Sv2SessionInspectionStatus::SyncFailed
    );

    clear_sync_quarantine(&quarantine_key);
    assert!(cached_view_for_fingerprint(&moved_fingerprint, &root_key).is_none());
    assert!(cached_view_for_fingerprint(&moved_fingerprint, &concurrent_root_key).is_none());
}

#[cfg(windows)]
#[test]
fn missing_session_does_not_clear_slot_quarantine() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let slot_id = format!("slot-{}", uuid::Uuid::new_v4());
    let quarantine_key = SyncQuarantineKey::AccountSlot(slot_id.clone());
    let failed = Sv2AccountProbeView::sync_failed("synthetic sync quarantine");
    set_sync_quarantine(&quarantine_key, &failed);

    let missing_root = std::env::temp_dir().join(format!(
        "synthv-toolbox-missing-session-{}",
        uuid::Uuid::new_v4()
    ));
    let view = cached_sv2_account_probe_for_account(&missing_root, false, &slot_id, false);
    assert_eq!(view.session_status, Sv2SessionInspectionStatus::Missing);
    assert_eq!(
        sync_quarantine_get(&quarantine_key).unwrap().session_status,
        Sv2SessionInspectionStatus::SyncFailed
    );

    clear_sync_quarantine(&quarantine_key);
}

#[cfg(windows)]
#[test]
fn slot_quarantine_repair_requires_every_requested_copy() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let root_a = PathBuf::from("synthetic-normal");
    let root_b = PathBuf::from("synthetic-concurrent");
    let requests = vec![
        Sv2AccountProbeRequest::for_account(&root_a, false, 7, true, "slot-7", false),
        Sv2AccountProbeRequest::for_account(&root_b, false, 7, false, "slot-7", true),
    ];
    let mut sessions = vec![
        batch_session(0, 7, true, "same-subject", "first-login", 0),
        batch_session(1, 7, false, "same-subject", "second-login", 20),
    ];
    for session in &mut sessions {
        session.sync_quarantined = false;
    }
    let quarantine_key = SyncQuarantineKey::AccountSlot("slot-7".to_string());
    let incomplete = vec![None, Some(Sv2AccountProbeView::not_checked(false))];
    assert!(!quarantine_repair_complete(
        &requests,
        &incomplete,
        &sessions,
        &quarantine_key
    ));

    let complete = vec![None, None];
    assert!(quarantine_repair_complete(
        &requests,
        &complete,
        &sessions,
        &quarantine_key
    ));
}

#[test]
fn authority_selection_prefers_latest_iat_then_access_expiry() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let older_issued = Utc.with_ymd_and_hms(2099, 1, 2, 3, 0, 0).single().unwrap();
    let newer_issued = older_issued + ChronoDuration::minutes(20);
    let older = parse_session_plaintext(Zeroizing::new(
        make_identity_plaintext(
            older_issued + ChronoDuration::hours(2),
            older_issued,
            "same-subject",
            "same-login",
            "old-device",
        )
        .into_bytes(),
    ))
    .unwrap();
    let newer = parse_session_plaintext(Zeroizing::new(
        make_identity_plaintext(
            newer_issued + ChronoDuration::minutes(30),
            newer_issued,
            "same-subject",
            "same-login",
            "new-device",
        )
        .into_bytes(),
    ))
    .unwrap();

    assert_eq!(
        choose_authority([(0, &older, true), (1, &newer, false)]),
        Some(1),
        "a longer-lived but older access token must not outrank a rotated token",
    );
    assert_eq!(
        choose_authority([(0, &newer, true), (1, &newer, false)]),
        Some(0),
        "the ordinary account source wins an exact timestamp tie",
    );
    assert_eq!(
        choose_authority([(0, &newer, false), (1, &newer, false)]),
        Some(0),
        "otherwise the lowest stable request index wins an exact tie",
    );
}

#[test]
fn token_core_sync_preserves_each_copy_extension_and_full_cache_shape() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let issued = Utc.with_ymd_and_hms(2099, 1, 2, 3, 0, 0).single().unwrap();
    let authority = parse_session_plaintext(Zeroizing::new(
        make_identity_plaintext(
            issued + ChronoDuration::hours(1),
            issued,
            "same-subject",
            "same-login",
            "authority-device",
        )
        .into_bytes(),
    ))
    .unwrap();
    let sibling = parse_session_plaintext(Zeroizing::new(
        make_identity_plaintext(
            issued + ChronoDuration::minutes(30),
            issued - ChronoDuration::minutes(30),
            "same-subject",
            "older-environment-login",
            "sibling-device\nsibling-user\ncache-a\ncache-b",
        )
        .into_bytes(),
    ))
    .unwrap();
    let old_extension = sibling.extension_text().to_string();
    assert_ne!(sibling.access_token(), authority.access_token());
    assert_eq!(
        account_group_key(sibling.access_token()),
        account_group_key(authority.access_token())
    );

    let token_only = sibling
        .with_token_core_and_identity(authority.token_core(), None)
        .unwrap();
    assert_eq!(token_only.token_core(), authority.token_core());
    assert_eq!(token_only.extension_text(), old_extension);

    let enrolled = sibling
        .with_token_core_and_identity(
            authority.token_core(),
            Some(("server-device", "server-user")),
        )
        .unwrap();
    assert_eq!(enrolled.token_core(), authority.token_core());
    assert_eq!(enrolled.device_id(), Some("server-device"));
    assert_eq!(enrolled.user_id(), Some("server-user"));
    assert!(enrolled.buffer.ends_with("cache-a\ncache-b"));

    let compact = authority
        .with_token_core_and_identity(
            authority.token_core(),
            Some(("server-device", "server-user")),
        )
        .unwrap();
    assert_eq!(compact.device_id(), Some("server-device"));
    assert_eq!(compact.user_id(), None);
    assert!(!compact.has_full_cache());
}

#[cfg(windows)]
#[test]
fn refreshed_session_is_atomically_replaced_and_readable() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let root = std::env::temp_dir().join(format!(
        "sv2-account-session-write-test-{}",
        uuid::Uuid::new_v4()
    ));
    let license = root.join("license");
    fs::create_dir_all(&license).unwrap();
    let issued = DateTime::<Utc>::from_timestamp(Utc::now().timestamp(), 0).unwrap();
    let plaintext = make_plaintext(
        issued + ChronoDuration::hours(1),
        issued + ChronoDuration::days(31),
        issued,
    );
    let credentials = parse_session_plaintext(Zeroizing::new(plaintext.into_bytes())).unwrap();
    let key = *b"12345678";
    fs::write(
        license.join("session"),
        &*encrypt_session(credentials.buffer.as_bytes(), &key).unwrap(),
    )
    .unwrap();
    let (_, fingerprint) = read_stable_session(&root).unwrap().unwrap();
    let updated = credentials
        .with_enrollment_identity("persisted-device", "ignored-user")
        .unwrap();

    let _new_fingerprint = persist_refreshed_session(&root, &fingerprint, &updated, &key).unwrap();
    let (ciphertext, _) = read_stable_session(&root).unwrap().unwrap();
    let parsed = parse_session_plaintext(decrypt_session(ciphertext, &key).unwrap()).unwrap();
    assert_eq!(parsed.device_id(), Some("persisted-device"));
    assert_eq!(parsed.user_id(), None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn license_filter_is_active_voice_only_deduplicated_and_sorted() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let body = br#"{
            "status":"success",
            "data":[
                {"status":"active","valid_to":"2100-01-01T00:00:00Z","product":{"name":"  Beta   Voice ","type":"Voice Databases 2","tags":[]}},
                {"status":"active","product":{"name":"Alpha Voice","type":"Voice Database","tags":[]}},
                {"status":"active","product":{"name":"alpha voice","type":"Voice Database","tags":[]}},
                {"status":"active","product":{"name":"Tagged Singer","type":"other","tags":"singer"}},
                {"status":"Active","product":{"name":"Wrong Status","type":"Voice Database","tags":[]}},
                {"status":"expired","product":{"name":"Expired Voice","type":"Voice Database","tags":[]}},
                {"status":"active","product":{"name":"Editor","type":"Synthesizer V Editor","tags":[]}},
                {"status":"active","product":{"name":"Legacy Alias","type":"voice_database","tags":[]}}
            ]
        }"#;
    let voices = extract_authorized_voices(body).unwrap();
    assert_eq!(voices, vec!["Alpha Voice", "Beta Voice"]);
}

#[test]
fn concurrent_error_codes_are_detected_without_exposing_body() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    for code in [CONCURRENT_ERROR, KICKOUT_ERROR] {
        let body = Zeroizing::new(
            format!("{{\"error\":\"{}\"}}", std::str::from_utf8(code).unwrap()).into_bytes(),
        );
        assert!(matches!(
            interpret_license_response(409, body),
            RemoteOutcome::ConcurrentUse
        ));
    }
}

#[cfg(windows)]
#[test]
fn enroll_request_is_always_non_kickout_and_matches_both_device_shapes() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let cold = EnrollRequest {
        payload: EnrollPayload {
            device_id: None,
            device_hash: "0123456789abcdef",
            editor_version: EDITOR_VERSION,
            device_name: "fixture-host",
            kickout_other_sessions: false,
        },
    };
    let cold = serde_json::to_value(cold).unwrap();
    assert_eq!(cold["payload"]["editor_version"], 131_585);
    assert_eq!(cold["payload"]["kickout_other_sessions"], false);
    assert!(cold["payload"].get("device_id").is_none());

    let known = EnrollRequest {
        payload: EnrollPayload {
            device_id: Some("known-device"),
            device_hash: "",
            editor_version: EDITOR_VERSION,
            device_name: "fixture-host",
            kickout_other_sessions: false,
        },
    };
    let known = serde_json::to_value(known).unwrap();
    assert_eq!(known["payload"]["device_id"], "known-device");
    assert_eq!(known["payload"]["device_hash"], "");
    assert_eq!(known["payload"]["kickout_other_sessions"], false);
}

#[cfg(windows)]
#[test]
fn enroll_response_only_marks_clear_with_server_identity() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let clear = interpret_enrollment_response(
        200,
        Zeroizing::new(
            br#"{"data":{"status":"ok","device_id":"device","user_id":"user"}}"#.to_vec(),
        ),
        None,
    );
    match clear {
        EnrollAttempt::Checked(result) => {
            assert!(matches!(result.outcome, EnrollOutcome::Clear));
            let identity = result.identity.unwrap();
            assert_eq!(&*identity.device_id, "device");
            assert_eq!(&*identity.user_id, "user");
        }
        EnrollAttempt::DeviceNotFound => panic!("unexpected device-not-found"),
    }

    let kickout = interpret_enrollment_response(
            200,
            Zeroizing::new(
                br#"{"data":{"status":"device-require-session-kickout-confirmation","kickout_devices":[]}}"#
                    .to_vec(),
            ),
            None,
        );
    assert!(matches!(
        kickout,
        EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::ConcurrentUse,
            identity: None,
        })
    ));

    let missing = interpret_enrollment_response(
        400,
        Zeroizing::new(br#"{"error":{"code":"device-not-found"}}"#.to_vec()),
        Some("stale-device"),
    );
    assert!(matches!(missing, EnrollAttempt::DeviceNotFound));

    let incomplete = interpret_enrollment_response(
        200,
        Zeroizing::new(br#"{"data":{"status":"ok"}}"#.to_vec()),
        None,
    );
    assert!(matches!(
        incomplete,
        EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::Unknown,
            identity: None,
        })
    ));
}

#[test]
fn public_views_never_echo_secret_or_response_sentinels() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    const SENTINEL: &str = "DO_NOT_LEAK_THIS_SECRET";
    let malformed = Zeroizing::new(format!("{SENTINEL}\n").into_bytes());
    assert!(parse_session_plaintext(malformed).is_err());
    let invalid = Sv2AccountProbeView::invalid();
    assert!(!serde_json::to_string(&invalid).unwrap().contains(SENTINEL));

    let response =
        Zeroizing::new(format!("{{\"data\":[],\"private\":\"{SENTINEL}\"}}").into_bytes());
    let view = view_from_remote(
        interpret_license_response(200, response),
        EnrollOutcome::Unknown,
    );
    let serialized = serde_json::to_string(&view).unwrap();
    assert!(!serialized.contains(SENTINEL));
    assert_eq!(view.remote_use, Sv2RemoteUseStatus::Unknown);
}

#[cfg(windows)]
#[test]
fn active_session_reuses_only_fresh_cached_authorization() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let cached = Sv2AccountProbeView::new(
        Sv2SessionInspectionStatus::Ready,
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        vec!["Synthetic Voice".to_string()],
        "cached",
    );
    let active = Sv2AccountProbeView::in_use_with_cached_authorization(Some(&cached));

    assert_eq!(active.session_status, Sv2SessionInspectionStatus::InUse);
    assert_eq!(
        active.authorization_status,
        Sv2AuthorizationStatus::Verified
    );
    assert_eq!(active.authorized_voices, vec!["Synthetic Voice"]);
    assert_eq!(active.remote_use, Sv2RemoteUseStatus::Unknown);

    let uncached = Sv2AccountProbeView::in_use_with_cached_authorization(None);
    assert_eq!(uncached.session_status, Sv2SessionInspectionStatus::InUse);
    assert_eq!(
        uncached.authorization_status,
        Sv2AuthorizationStatus::Unknown
    );
    assert!(uncached.authorized_voices.is_empty());
}

#[cfg(windows)]
#[test]
fn shared_slot_alias_receives_authority_result_without_quarantine() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    clear_sv2_account_probe_cache();
    let root = PathBuf::from("C:/synthetic/slot-authority");
    let fingerprint = SessionCacheKey {
        canonical_root: root,
        session_len: 8,
        last_write_time: 1,
    };
    let authority = Sv2AccountProbeView::new(
        Sv2SessionInspectionStatus::Ready,
        Sv2RemoteUseStatus::Clear,
        Sv2AuthorizationStatus::Verified,
        vec!["Synthetic Voice".to_string()],
        "authority",
    );
    let mut results = vec![Some(authority.clone()), None];
    let aliases = vec![
        None,
        Some(EquivalentSessionAlias {
            leader_request_index: 0,
            fingerprint: fingerprint.clone(),
            root_key: ProbeRootKey::AccountEnvironment {
                slot_id: "slot-authority".to_string(),
                concurrent: true,
            },
        }),
    ];

    apply_equivalent_session_aliases(&mut results, &aliases);

    assert_eq!(
        results[1].as_ref().unwrap().session_status,
        Sv2SessionInspectionStatus::Ready
    );
    assert_eq!(
        results[1].as_ref().unwrap().authorization_status,
        Sv2AuthorizationStatus::Verified
    );
    assert_eq!(
        cache_get(
            &fingerprint,
            &ProbeRootKey::AccountEnvironment {
                slot_id: "slot-authority".to_string(),
                concurrent: true,
            },
        )
        .unwrap()
        .session_status,
        Sv2SessionInspectionStatus::Ready
    );
    assert!(sync_quarantine_get(&SyncQuarantineKey::AccountSlot(
        "slot-authority".to_string()
    ))
    .is_none());
    clear_sv2_account_probe_cache();
}

#[cfg(windows)]
#[test]
#[ignore = "requires an explicitly supplied local SV2 data root"]
fn diagnostic_real_session_root_is_read_only() {
    let root = PathBuf::from(
        std::env::var("SV2_DIAGNOSTIC_ROOT")
            .expect("set SV2_DIAGNOSTIC_ROOT to an absolute SV2 data root"),
    );
    assert!(root.is_absolute(), "SV2_DIAGNOSTIC_ROOT must be absolute");

    let (ciphertext, first) = read_stable_session(&root)
        .expect("stable read failed")
        .expect("session is missing");
    let key = read_machine_key().expect("machine key unavailable");
    let credentials = decrypt_session(ciphertext, &key)
        .and_then(parse_session_plaintext)
        .expect("session decrypt or parse failed");
    let (_, second) = read_stable_session(&root)
        .expect("second stable read failed")
        .expect("session disappeared");
    let access_payload = decode_base64url(
        credentials.access_token().split('.').nth(1).expect("access token payload missing"),
    )
    .expect("access token payload is not base64url");
    let refresh_payload = decode_base64url(
        credentials.refresh_token().split('.').nth(1).expect("refresh token payload missing"),
    )
    .expect("refresh token payload is not base64url");
    let access_claims: serde_json::Value = serde_json::from_slice(&access_payload)
        .expect("access token payload is not JSON");
    let refresh_claims: serde_json::Value = serde_json::from_slice(&refresh_payload)
        .expect("refresh token payload is not JSON");
    let issuer = access_claims
        .get("iss")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            url::Url::parse(value).is_ok_and(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            })
        })
        .unwrap_or("<invalid>");
    let access_azp_matches = access_claims
        .get("azp")
        .and_then(serde_json::Value::as_str)
        == Some(TOKEN_CLIENT_ID);
    let access_azp = access_claims
        .get("azp")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 160
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-._".contains(character))
        })
        .unwrap_or("<invalid>");
    let refresh_expired = refresh_claims
        .get("exp")
        .and_then(serde_json::Value::as_i64)
        .and_then(|timestamp| DateTime::<Utc>::from_timestamp(timestamp, 0))
        .is_some_and(|expiry| expiry <= Utc::now());
    let read_licenses = std::env::var("SV2_DIAGNOSTIC_READ_LICENSES")
        .ok()
        .as_deref()
        == Some("true");
    let license_result = if read_licenses && credentials.access_expires_at > Utc::now() {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(3))
            .timeout_read(Duration::from_secs(5))
            .timeout_write(Duration::from_secs(5))
            .redirects(0)
            .build();
        match query_license_snapshot_with_agent(&agent, credentials.access_token()) {
            RemoteOutcome::Authorized(voices) => format!("authorized:{}", voices.len()),
            RemoteOutcome::ConcurrentUse => "concurrent".to_string(),
            RemoteOutcome::Unauthorized => "unauthorized".to_string(),
            RemoteOutcome::Offline => "offline".to_string(),
            RemoteOutcome::Unknown => "unknown".to_string(),
        }
    } else if read_licenses {
        "skipped-expired-access".to_string()
    } else {
        "disabled".to_string()
    };
    let (_, after_license) = read_stable_session(&root)
        .expect("post-license stable read failed")
        .expect("session disappeared after read-only diagnostic");

    eprintln!(
        "SV2 diagnostic: stable={}, stable_after_license={}, full_cache={}, device_present={}, user_present={}, access_expired={}, refresh_expired={}, issuer={}, access_azp={}, access_azp_matches={}, license={}",
        first == second,
        second == after_license,
        credentials.has_full_cache(),
        credentials.device_id().is_some(),
        credentials.user_id().is_some(),
        credentials.access_expires_at <= Utc::now(),
        refresh_expired,
        issuer,
        access_azp,
        access_azp_matches,
        license_result,
    );
}

#[cfg(windows)]
#[test]
fn refreshed_session_persists_and_reloads_in_an_isolated_fixture() {
    let root = std::env::temp_dir().join(format!("sv2-probe-persist-{}", uuid::Uuid::new_v4()));
    let data_root = root.join("data");
    let license = data_root.join("license");
    fs::create_dir_all(&license).unwrap();
    let key = *b"fixture8";
    let issued = DateTime::<Utc>::from_timestamp(Utc::now().timestamp() - 60, 0).unwrap();
    let initial = make_plaintext(
        issued + ChronoDuration::minutes(2),
        issued + ChronoDuration::days(31),
        issued,
    );
    let initial_credentials = parse_session_plaintext(Zeroizing::new(initial.clone().into_bytes())).unwrap();
    let initial_encrypted = encrypt_session(initial_credentials.buffer.as_bytes(), &key).unwrap();
    fs::write(license.join("session"), &*initial_encrypted).unwrap();
    let (_, fingerprint) = read_stable_session(&data_root).unwrap().unwrap();
    let updated = parse_session_plaintext(Zeroizing::new(initial.into_bytes())).unwrap();

    let persisted = persist_refreshed_session(&data_root, &fingerprint, &updated, &key).unwrap();
    let (ciphertext, reloaded_fingerprint) = read_stable_session(&data_root).unwrap().unwrap();
    let reloaded = decrypt_session(ciphertext, &key)
        .and_then(parse_session_plaintext)
        .unwrap();
    assert!(persisted == reloaded_fingerprint);
    assert_eq!(reloaded.token_core(), updated.token_core());
    assert_eq!(reloaded.device_id(), updated.device_id());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn active_license_decision_is_network_free_and_preserves_failures() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    let authorized = view_from_active_license(RemoteOutcome::Authorized(vec![
        "Synthetic Voice".to_string()
    ]));
    assert_eq!(authorized.session_status, Sv2SessionInspectionStatus::InUse);
    assert_eq!(
        authorized.authorization_status,
        Sv2AuthorizationStatus::Verified
    );
    assert_eq!(authorized.authorized_voices, vec!["Synthetic Voice"]);

    let offline = view_from_active_license(RemoteOutcome::Offline);
    assert_eq!(offline.session_status, Sv2SessionInspectionStatus::InUse);
    assert_eq!(
        offline.authorization_status,
        Sv2AuthorizationStatus::Unknown
    );
    assert!(offline.detail.contains("不可达"));

    let unauthorized = view_from_active_license(RemoteOutcome::Unauthorized);
    assert_eq!(
        unauthorized.session_status,
        Sv2SessionInspectionStatus::Invalid
    );
}

#[cfg(windows)]
#[test]
fn active_license_cache_requires_matching_fingerprint_and_unexpired_access() {
    let _guard = PROBE_TEST_GATE.lock().unwrap();
    clear_sv2_account_probe_cache();
    let root = ProbeRootKey::AccountEnvironment {
        slot_id: "slot-cache".to_string(),
        concurrent: true,
    };
    let fingerprint = SessionCacheKey {
        canonical_root: PathBuf::from("C:/synthetic/slot-cache"),
        session_len: 8,
        last_write_time: 1,
    };
    let view = Sv2AccountProbeView::new(
        Sv2SessionInspectionStatus::InUse,
        Sv2RemoteUseStatus::Unknown,
        Sv2AuthorizationStatus::Verified,
        vec!["Synthetic Voice".to_string()],
        "cached",
    );
    cache_put(
        fingerprint.clone(),
        &root,
        &view,
        Some(Utc::now() - ChronoDuration::seconds(1)),
    );
    assert!(cache_get(&fingerprint, &root).is_none());
    cache_put(
        fingerprint.clone(),
        &root,
        &view,
        Some(Utc::now() + ChronoDuration::minutes(1)),
    );
    assert!(cache_get(&fingerprint, &root).is_some());
    let changed = SessionCacheKey {
        last_write_time: 2,
        ..fingerprint
    };
    assert!(cache_get(&changed, &root).is_none());
    clear_sv2_account_probe_cache();
}
