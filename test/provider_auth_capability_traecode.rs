use super::*;

#[test]
fn missing_cli_is_runtime_unavailable_but_not_logged_in() {
    let provider = TraeCodeProvider::new(TraeCodeConfig {
        model: "trae-account-default".to_string(),
        timeout_secs: 1,
        executable: Some(std::env::temp_dir().join("synthv-toolbox-missing-traecli-test")),
        home_dir: std::env::temp_dir().join("synthv-toolbox-trae-home-test"),
    });
    let status = provider
        .login_status()
        .expect("missing CLI is a status result");
    assert!(!status.available);
    assert!(!status.logged_in);
    assert!(status.detail.contains("TraeCode CLI"));
}
