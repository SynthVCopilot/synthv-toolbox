use super::*;

#[test]
fn unauthorised_oauth_providers_remain_runtime_available() {
    let summary = model_summary(
        &ToolboxSettings::default(),
        &CredentialBalancer::new([]),
        &RuntimeModelCatalog::fallback(None),
    );
    for provider_id in [
        AiProviderId::Anthropic,
        AiProviderId::OpenaiCodex,
        AiProviderId::Workbuddy,
    ] {
        let provider = summary
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .expect("provider summary");
        assert!(
            provider.available,
            "{provider_id:?} runtime should be available"
        );
        assert!(
            !provider.connected,
            "{provider_id:?} must remain disconnected"
        );
    }
}
