use super::*;

#[test]
fn oauth_model_requires_account_and_available_catalog() {
    let model = "gpt-6-astra";
    let mut settings = ToolboxSettings::default();
    let unavailable = RuntimeModelCatalog::unavailable(None);
    let catalog = crate::opencode_catalog::runtime_catalog_from_bytes(
        br#"{
        "openai": {"name":"OpenAI","npm":"@ai-sdk/openai","models":{
            "gpt-6-astra":{"tool_call":true,"modalities":{"output":["text"]}}
        }}
    }"#,
    )
    .unwrap();
    assert!(validate_ai_model(&settings, AiProviderId::OpenaiCodex, model, &catalog).is_err());
    settings.oauth_accounts.push(OAuthAccountMetadata {
        id: "oauth:openai-codex:test".to_string(),
        provider: AiProviderId::OpenaiCodex,
        label: "Test account".to_string(),
        expires_at: 0,
        enabled: true,
        weight: 1,
    });
    assert!(validate_ai_model(&settings, AiProviderId::OpenaiCodex, model, &unavailable).is_err());
    assert!(validate_ai_model(&settings, AiProviderId::OpenaiCodex, model, &catalog).is_ok());
    assert!(validate_ai_model(
        &settings,
        AiProviderId::OpenaiCodex,
        "invented-model",
        &catalog
    )
    .is_err());
}
