use synthv_toolbox_lib::credential_balancer::{
    AiAuthMethod, AiProviderId, CredentialBalancer, CredentialCandidate, CredentialRoute,
    FailureKind,
};

fn route(id: &str, auth_method: AiAuthMethod, models: &[&str]) -> CredentialRoute {
    CredentialRoute {
        id: id.to_string(),
        provider: AiProviderId::Anthropic,
        auth_method,
        models: models.iter().map(|model| (*model).to_string()).collect(),
    }
}

#[test]
fn mixed_oauth_and_api_keys_rotate_in_one_model_queue() {
    let mut balancer = CredentialBalancer::new([
        route("oauth-1", AiAuthMethod::OAuth, &["shared"]),
        route("key-1", AiAuthMethod::ApiKey, &["shared"]),
        route("key-2", AiAuthMethod::ApiKey, &["other"]),
    ]);
    let first = balancer.candidates(AiProviderId::Anthropic, "shared");
    assert_eq!(
        first,
        vec![
            CredentialCandidate {
                id: "key-1".to_string(),
                auth_method: AiAuthMethod::ApiKey
            },
            CredentialCandidate {
                id: "oauth-1".to_string(),
                auth_method: AiAuthMethod::OAuth
            },
        ]
    );
    let second = balancer.candidates(AiProviderId::Anthropic, "shared");
    assert_eq!(
        second,
        vec![
            CredentialCandidate {
                id: "oauth-1".to_string(),
                auth_method: AiAuthMethod::OAuth
            },
            CredentialCandidate {
                id: "key-1".to_string(),
                auth_method: AiAuthMethod::ApiKey
            },
        ]
    );
}

#[test]
fn status_failure_and_recovery_are_scoped_to_one_credential() {
    let mut balancer = CredentialBalancer::new([
        route("oauth-1", AiAuthMethod::OAuth, &["shared"]),
        route("key-1", AiAuthMethod::ApiKey, &["shared"]),
    ]);
    balancer.record_failure(AiAuthMethod::ApiKey, "key-1", FailureKind::RateLimited);
    let candidates = balancer.candidates(AiProviderId::Anthropic, "shared");
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].id, "oauth-1");
    balancer.record_failure(AiAuthMethod::OAuth, "oauth-1", FailureKind::Unauthorized);
    assert!(balancer
        .candidates(AiProviderId::Anthropic, "shared")
        .is_empty());
    balancer.upsert(route("oauth-1", AiAuthMethod::OAuth, &["shared"]));
    assert_eq!(
        balancer.candidates(AiProviderId::Anthropic, "shared").len(),
        1
    );
}
