use super::*;

#[cfg(windows)]
#[test]
#[ignore = "inspects license metadata using explicitly supplied unexpired sessions without writes"]
fn inspect_official_license_metadata() {
    let roots = std::env::var_os("SV2_CATALOG_ROOTS").expect("explicit roots required");
    let key = read_machine_key().expect("machine key unavailable");
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(12))
        .build();
    let mut checked = 0;
    for (index, root) in std::env::split_paths(&roots).enumerate() {
        assert!(root.is_absolute());
        let Some((encrypted, before)) = read_stable_session(&root).expect("session read failed")
        else {
            continue;
        };
        let SessionDecode::Credentials(credentials) = decode_session_credentials(encrypted, &key)
        else {
            continue;
        };
        if credentials.access_expires_at <= Utc::now() {
            eprintln!("slot_index={index}, access_expired=true");
            continue;
        }
        let authorization = Zeroizing::new(format!("Bearer {}", credentials.access_token()));
        let response = match agent
            .get(LICENSES_URL)
            .set("Accept", "application/json")
            .set("Authorization", &authorization)
            .call()
        {
            Ok(response) => response,
            Err(_) => {
                eprintln!("slot_index={index}, license_request_failed=true");
                continue;
            }
        };
        let body =
            read_bounded_response(response).unwrap_or_else(|_| panic!("response unreadable"));
        let value: serde_json::Value = serde_json::from_slice(&body).expect("invalid JSON");
        let rows = value
            .get("data")
            .and_then(|value| value.as_array())
            .expect("missing license list");
        let mut schema = std::collections::BTreeSet::new();
        for row in rows {
            if let Some(timestamp) = row.get("valid_to").and_then(|value| value.as_i64()) {
                schema.insert(format!("valid_to_digits={}", timestamp.to_string().len()));
                if let Some(date) = DateTime::from_timestamp(timestamp, 0) {
                    schema.insert(format!("valid_to_as_seconds={}", date.to_rfc3339()));
                }
            }
            for (field, value) in row.as_object().expect("invalid license") {
                let kind = match value {
                    serde_json::Value::Null => "null",
                    serde_json::Value::Bool(_) => "bool",
                    serde_json::Value::Number(_) => "number",
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Array(_) => "array",
                    serde_json::Value::Object(_) => "object",
                };
                schema.insert(format!("{field}:{kind}"));
                if matches!(
                    field.as_str(),
                    "type" | "status" | "licenseType" | "license_type"
                ) {
                    if let Some(text) = value.as_str().filter(|text| {
                        text.len() <= 40
                            && text
                                .chars()
                                .all(|ch| ch.is_ascii_alphanumeric() || " _-".contains(ch))
                    }) {
                        schema.insert(format!("{field}={text}"));
                    }
                }
                let lower = field.to_lowercase();
                if lower.contains("trial") || lower.contains("expir") || lower.contains("duration")
                {
                    if let Some(flag) = value.as_bool() {
                        schema.insert(format!("{field}={flag}"));
                    }
                    if let Some(date) = value
                        .as_str()
                        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
                    {
                        schema.insert(format!("{field}={}", date.to_rfc3339()));
                    }
                }
            }
        }
        eprintln!(
            "slot_index={index}, license_rows={}, schema={schema:?}",
            rows.len()
        );
        assert!(
            inspect_session_fingerprint(&root).ok().flatten().as_ref() == Some(&before),
            "session changed during read-only inspection"
        );
        checked += 1;
    }
    assert!(
        checked > 0,
        "no unexpired session available for read-only inspection"
    );
}

#[cfg(windows)]
#[test]
#[ignore = "reads official product IDs using explicitly supplied unexpired sessions"]
fn existing_sessions_match_official_products_to_local_artwork() {
    let roots = std::env::var_os("SV2_CATALOG_ROOTS").expect("explicit roots required");
    let roots = std::env::split_paths(&roots).collect::<Vec<_>>();
    assert!(!roots.is_empty() && roots.iter().all(|root| root.is_absolute()));
    let catalog = crate::sv2_voice_catalog::read_catalog(&roots);
    let key = read_machine_key().expect("machine key unavailable");
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(12))
        .build();
    let mut checked = 0;
    let mut expired = 0;
    let mut login_required = 0;
    for (index, root) in roots.iter().enumerate() {
        let Some((encrypted, before)) = read_stable_session(root).expect("session read failed")
        else {
            continue;
        };
        let plaintext = decrypt_session(encrypted, &key).expect("session cannot be decrypted");
        if is_login_required_session_placeholder(&plaintext) {
            login_required += 1;
            continue;
        }
        let credentials = parse_session_plaintext(plaintext).expect("session unavailable");
        if credentials.access_expires_at <= Utc::now() {
            expired += 1;
            continue;
        }
        let view = view_from_active_license(query_license_snapshot_with_agent(
            &agent,
            credentials.access_token(),
        ));
        let products = &view.authorized_voice_products;
        let matches = products
            .iter()
            .filter(|product| {
                catalog
                    .iter()
                    .any(|voice| voice.id == product.id && voice.image_data_url.is_some())
            })
            .count();
        let image_only = products
            .iter()
            .filter(|product| {
                catalog.iter().any(|voice| {
                    voice.id == product.id && voice.name.is_none() && voice.image_data_url.is_some()
                })
            })
            .count();
        let unchanged = inspect_session_fingerprint(root).ok().flatten().as_ref() == Some(&before);
        eprintln!("SV2 product mapping: slot_index={index}, authorization={:?}, voices={}, product_ids={}, images={matches}, image_only={image_only}, session_unchanged={unchanged}", view.authorization_status, view.authorized_voice_count, products.len());
        assert_eq!(view.authorization_status, Sv2AuthorizationStatus::Verified);
        assert!(unchanged, "session changed during read-only product lookup");
        assert!(
            !products.is_empty(),
            "official authorization did not return product IDs"
        );
        checked += 1;
    }
    eprintln!("SV2 product mapping totals: checked={checked}, expired_skipped={expired}, login_required_skipped={login_required}");
    assert!(
        checked > 0,
        "no unexpired session available for read-only product lookup"
    );
}

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
