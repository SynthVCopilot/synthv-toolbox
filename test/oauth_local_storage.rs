use super::*;

#[test]
fn local_storage_persists_and_rolls_back_oauth_credentials() {
    const CHILD_MARKER: &str = "TOOLBOX_LOCAL_STORAGE_TEST_CHILD";
    if std::env::var_os(CHILD_MARKER).is_none() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/.tmp")
            .join(format!("toolbox-oauth-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "oauth::local_storage_tests::local_storage_persists_and_rolls_back_oauth_credentials", "--nocapture"])
            .env(CHILD_MARKER, "1")
            .env("HOME", &root)
            .env("USERPROFILE", &root)
            .output().unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(
            output.status.success(),
            "isolated OAuth persistence test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }
    let metadata = OAuthAccountMetadata {
        id: "oauth:openai-codex:fixture-account".into(),
        provider: AiProviderId::OpenaiCodex,
        label: "Fixture".into(),
        expires_at: now_ms() + 3_600_000,
        enabled: true,
        weight: 1,
    };
    let mut account = AuthorizedAccount {
        metadata: metadata.clone(),
        credential: OAuthCredential {
            access: "fixture-access".into(),
            refresh: "first-refresh".into(),
            expires_at: metadata.expires_at,
            account_id: Some("fixture-account".into()),
        },
    };
    let empty = install_authorized(&account).unwrap();
    assert!(empty.persisted.is_none());
    assert_eq!(
        load_ready_credential(&metadata).unwrap().access,
        "fixture-access"
    );
    account.credential.refresh = "second-refresh".into();
    let previous = install_authorized(&account).unwrap();
    assert_eq!(load_secret(&metadata).unwrap().refresh, "second-refresh");
    restore_credential(&metadata, &previous).unwrap();
    CREDENTIAL_CACHE
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .remove(&metadata.id);
    let restored = load_secret(&metadata).unwrap();
    assert_eq!(restored.refresh, "first-refresh");
    assert_eq!(restored.account_id.as_deref(), Some("fixture-account"));
    let removed = take_credential(&metadata).unwrap();
    assert!(load_secret(&metadata).is_err());
    restore_credential(&metadata, &removed).unwrap();
    assert_eq!(load_secret(&metadata).unwrap().refresh, "first-refresh");
    restore_credential(&metadata, &empty).unwrap();
    assert!(load_secret(&metadata).is_err());
}
