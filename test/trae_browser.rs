use super::*;
use p256::ecdsa::signature::Verifier;
fn credential() -> TraeCredential {
    TraeCredential {
        access: "access".into(),
        refresh: "refresh".into(),
        expires: now() + 600_000,
        refresh_expires: now() + 3_600_000,
        host: HOSTS[0].into(),
        client_id: CLIENT_ID.into(),
        device: device().unwrap(),
        account_id: "account".into(),
        label: "Account".into(),
        store_country: "CA".into(),
        models: vec!["model".into()],
    }
}
fn state() -> CallbackState {
    CallbackState {
        authority: "127.0.0.1:45454".into(),
        trace: "trace".into(),
        sender: Mutex::new(None),
    }
}
fn target(trace: &str) -> String {
    let mut url = Url::parse("http://127.0.0.1:45454/authorize").unwrap();
    url.query_pairs_mut().extend_pairs(&[
        ("loginTraceID", trace),
        ("authCodeInfo", r#"{"AuthCode":"code"}"#),
        ("userTag", "row"),
        ("scope", "trae"),
    ]);
    format!("/authorize?{}", url.query().unwrap())
}
#[test]
fn callback_requires_exact_host_trace_path_and_unique_fields() {
    let state = state();
    let valid = target("trace");
    assert_eq!(
        callback_value("GET", &state.authority, &valid, &state).unwrap(),
        Some(("code".into(), "row".into()))
    );
    for (method, host, uri) in [
        ("POST", state.authority.as_str(), valid.clone()),
        ("GET", "localhost:45454", valid.clone()),
        ("GET", "evil.test", valid.clone()),
        ("GET", state.authority.as_str(), target("wrong")),
        (
            "GET",
            state.authority.as_str(),
            format!("{valid}&loginTraceID=trace"),
        ),
        (
            "GET",
            state.authority.as_str(),
            format!("{valid}&authCodeInfo=%7B%7D"),
        ),
        (
            "GET",
            state.authority.as_str(),
            format!("{valid}&scope=trae"),
        ),
        (
            "GET",
            state.authority.as_str(),
            format!("http://evil.test{valid}"),
        ),
        (
            "GET",
            state.authority.as_str(),
            valid.replacen("/authorize", "/authorize/", 1),
        ),
    ] {
        assert!(callback_value(method, host, &uri, &state).is_err());
    }
    assert!(callback_value(
        "GET",
        &state.authority,
        &format!("{valid}&error_code=denied"),
        &state
    )
    .unwrap()
    .is_none());
}
#[test]
fn signed_refresh_binds_exact_client_refresh_path_and_device() {
    let credential = credential();
    let body = refresh_body(&credential, 123, "nonce").unwrap();
    let encoded = body["DeviceProof"]["Signature"].as_str().unwrap();
    let bytes = STANDARD.decode(encoded).unwrap();
    let signature = Signature::from_der(&bytes).unwrap();
    let key = validate(&credential).unwrap();
    let message = format!("POST\n{EXCHANGE}\n{CLIENT_ID}\nrefresh\n123\nnonce");
    assert!(key
        .verifying_key()
        .verify(message.as_bytes(), &signature)
        .is_ok());
    assert!(key
        .verifying_key()
        .verify(message.replace("refresh", "other").as_bytes(), &signature)
        .is_err());
    assert_eq!(
        body["DeviceInfo"]["DevicePublicKey"],
        credential.device.public_key_pem
    );
    assert_eq!(body["ClientID"], credential.client_id);
}
#[test]
fn credentials_reject_untrusted_hosts_and_mismatched_keys() {
    let mut credential = credential();
    for host in [
        "http://growsg-normal.trae.ai",
        "https://growsg-normal.trae.ai.evil.test",
        "https://growsg-normal.trae.ai/",
        "https://user@growsg-normal.trae.ai",
    ] {
        credential.host = host.into();
        assert!(validate(&credential).is_err());
    }
    credential.host = HOSTS[0].into();
    credential.device.public_key_pem = device().unwrap().public_key_pem.clone();
    assert!(validate(&credential).is_err());
}
#[test]
fn account_country_routes_without_default_region() {
    let mut c = credential();
    assert_eq!(inference_host(&c).unwrap(), "https://coresg-normal.trae.ai");
    c.store_country = "US".into();
    assert_eq!(
        inference_host(&c).unwrap(),
        "https://core-normal.traeapi.us"
    );
    for country in ["", "us", "USTTP", "USA"] {
        c.store_country = country.into();
        assert!(inference_host(&c).is_err());
    }
}
#[test]
fn wire_encryption_matches_protocol_and_rejects_tool_history() {
    let message = ChatMessage::user("hello");
    let encoded = encrypted_messages(
        std::slice::from_ref(&message),
        &[],
        &[0; 8],
        &[0; 12],
        "123",
    )
    .unwrap();
    assert_eq!(encoded, "AAAAAAAAAAAAAAAAV1Rw1Z1yra+YsIgatPaf3/FMvz0MYTL+Mp+MVF4rO6ZoHr67j/+dR/NT2XaDIgXaZSAkF9ysfLCfAYllbbpm1qO2ICLIcDd4kJls0A==");
    let bytes = STANDARD.decode(encoded).unwrap();
    let key = [
        0x61, 0x95, 0xf2, 0x4c, 0xa4, 0xd4, 0x30, 0xf8, 0xa4, 0x83, 0x3d, 0xe7, 0xdb, 0x8d, 0xac,
        0x37, 0xd1, 0x48, 0xa0, 0x84, 0xe7, 0x46, 0x4a, 0x35, 0x1f, 0xfa, 0x68, 0x58, 0x5c, 0x16,
        0xb9, 0x55,
    ];
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let plain = cipher
        .decrypt(
            (&[0; 12]).into(),
            Payload {
                msg: &bytes[12..],
                aad: b"123",
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&plain).unwrap(),
        json!([{"role":"user","content":[{"type":"text","text":"hello"}]}])
    );
    assert!(cipher
        .decrypt(
            (&[0; 12]).into(),
            Payload {
                msg: &bytes[12..],
                aad: b"124"
            }
        )
        .is_err());
    let mut tool_message = message;
    tool_message.role = Role::Tool;
    assert!(encrypted_messages(&[tool_message], &[], &[0; 8], &[0; 12], "123").is_err());
    assert!(encrypted_messages(
        &[ChatMessage::user("x")],
        &[ToolDefinition {
            name: "tool".into(),
            description: String::new(),
            input_schema_json: "{}".into()
        }],
        &[0; 8],
        &[0; 12],
        "123"
    )
    .is_err());
}
#[test]
fn stream_filters_metadata_validates_usage_and_rejects_tools() {
    let mut c = Completion::default();
    c.event("metadata", r#"{"response":"private metadata"}"#)
        .unwrap();
    c.event("progress_notice", r#"{"response":"progress"}"#)
        .unwrap();
    c.event(
        "message",
        r#"{"response":"text","reasoning_content":"reasoning"}"#,
    )
    .unwrap();
    c.event(
        "token_usage",
        r#"{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}"#,
    )
    .unwrap();
    c.event("done", r#"{"finish_reason":"stop"}"#).unwrap();
    assert_eq!(c.text, "text");
    assert_eq!(c.reasoning, "reasoning");
    assert!(c.done);
    for value in [
        r#"{"tool_calls":[]}"#,
        r#"{"finish_reason":"tool_calls"}"#,
        r#"{"response":123}"#,
        "[]",
    ] {
        assert!(c.event("message", value).is_err());
    }
    assert!(c
        .event(
            "token_usage",
            r#"{"prompt_tokens":-1,"completion_tokens":2,"total_tokens":1}"#
        )
        .is_err());
}
#[test]
fn token_expiry_and_cancel_are_fail_closed() {
    assert!(expiry(&json!(0), None).is_err());
    assert!(expiry(&json!(0), Some(&json!(-1))).is_err());
    assert!(expiry(&json!(0), Some(&json!(1000))).unwrap() > now());
    let cancelled = AtomicBool::new(true);
    let result = run(
        async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok(())
        },
        Some(&cancelled),
        Duration::from_secs(1),
    );
    assert!(result.unwrap_err().to_string().contains("cancelled"));
}
#[test]
fn event_source_rejects_truncation_after_done() {
    let complete = b"event: done\ndata: {\"finish_reason\":\"stop\"}\n\n".to_vec();
    assert!(
        run(parse_events(complete.clone()), None, Duration::from_secs(1))
            .unwrap()
            .done
    );
    let mut truncated = complete;
    truncated.extend_from_slice(b"data: {\"response\":\"partial");
    assert!(run(parse_events(truncated), None, Duration::from_secs(1)).is_err());
}
#[test]
fn browser_flow_uses_pkce_and_closes_callback_after_cancellation() {
    let cancelled = AtomicBool::new(false);
    let captured = Mutex::new(None);
    let result = authorize(Some(&cancelled), |external| {
        let url = Url::parse(external).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://www.trae.ai");
        let pairs = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(pairs["client_id"], CLIENT_ID);
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["auth_from"], "trae");
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(pairs["code_challenge"].as_bytes())
                .unwrap()
                .len(),
            32
        );
        assert!(!pairs.contains_key("code_verifier"));
        let callback = Url::parse(&pairs["auth_callback_url"]).unwrap();
        assert_eq!(callback.host_str(), Some("127.0.0.1"));
        assert_eq!(callback.path(), "/authorize");
        *captured.lock().unwrap() = Some(format!("127.0.0.1:{}", callback.port().unwrap()));
        cancelled.store(true, Ordering::Relaxed);
        Ok(())
    });
    assert!(result.err().unwrap().to_string().contains("cancelled"));
    let address = captured.lock().unwrap().clone().unwrap();
    assert!(std::net::TcpListener::bind(address).is_ok());
}
#[test]
fn browser_callback_rejects_foreign_trace_before_accepting_denial() {
    let result = authorize(None, |external| {
        let url = Url::parse(external).unwrap();
        let pairs = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        let callback = pairs["auth_callback_url"].to_string();
        let trace = pairs["login_trace_id"].to_string();
        std::thread::spawn(move || {
            let wrong = format!("{callback}?loginTraceID=wrong&error_code=denied");
            assert!(matches!(
                ureq::get(&wrong).call(),
                Err(ureq::Error::Status(400, _))
            ));
            let valid = format!("{callback}?loginTraceID={trace}&error_code=denied");
            let _ = ureq::get(&valid).call();
        });
        Ok(())
    });
    assert!(result.err().unwrap().to_string().contains("rejected"));
}
#[test]
fn refreshed_tokens_preserve_account_client_and_device_binding() {
    let mut c = credential();
    let original = c.clone();
    update_tokens(&mut c,&json!({"Token":"new-access","RefreshToken":"new-refresh","TokenExpireAt":now()+600_000,"RefreshExpireAt":now()+3_600_000})).unwrap();
    assert_eq!(c.client_id, original.client_id);
    assert_eq!(c.device.private_key_pem, original.device.private_key_pem);
    assert_eq!(c.device.public_key_pem, original.device.public_key_pem);
    assert_eq!(c.account_id, original.account_id);
    assert_eq!(c.store_country, original.store_country);
    assert_eq!(c.models, original.models);
    assert!(update_tokens(
        &mut c,
        &json!({"Token":"invalid","RefreshToken":"invalid","TokenExpireAt":0,"RefreshExpireAt":0})
    )
    .is_err());
    assert_eq!(c.access, "new-access");
    assert_eq!(c.refresh, "new-refresh");
}
