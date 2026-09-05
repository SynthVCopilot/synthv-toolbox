use synthv_toolbox_lib::credential_balancer::AiProviderId;
use synthv_toolbox_lib::opencode_catalog::{
    parse_catalog, runtime_catalog_from_bytes, RuntimeCatalogSource,
};

const FIXTURE: &[u8] = br#"{
  "anthropic": {
    "name": "Anthropic",
    "npm": "@ai-sdk/anthropic",
    "models": {
      "claude-sonnet-5": {"tool_call": true, "release_date": "2026-06-29", "modalities": {"output": ["text"]}},
      "claude-old": {"tool_call": true, "status": "deprecated", "modalities": {"output": ["text"]}},
      "claude-no-tools": {"tool_call": false, "modalities": {"output": ["text"]}}
    }
  },
  "openai": {
    "name": "OpenAI",
    "npm": "@ai-sdk/openai",
    "models": {
      "gpt-5.6-terra": {"tool_call": true, "release_date": "2026-07-09", "modalities": {"output": ["text"]}},
      "gpt-5.3-chat-latest": {"tool_call": true, "status": "deprecated", "modalities": {"output": ["text"]}},
      "gpt-4.1": {"tool_call": true, "modalities": {"output": ["text"]}},
      "unsafe/model": {"tool_call": true, "modalities": {"output": ["text"]}}
    }
  }
}"#;

#[test]
fn parses_agent_capable_models_from_models_dev_schema() {
    let catalog = parse_catalog(FIXTURE).expect("valid models.dev fixture");
    let anthropic = catalog
        .providers
        .iter()
        .find(|provider| provider.id == "anthropic")
        .expect("anthropic provider");
    assert_eq!(anthropic.models, ["claude-sonnet-5"]);
    let openai = catalog
        .providers
        .iter()
        .find(|provider| provider.id == "openai")
        .expect("openai provider");
    assert_eq!(openai.models, ["gpt-5.6-terra", "gpt-4.1"]);
}

#[test]
fn deduplicates_model_ids_even_when_release_dates_separate_them() {
    let catalog = parse_catalog(
        br#"{
          "anthropic": {
            "npm": "@ai-sdk/anthropic",
            "models": {
              "newer": {"id": "claude-shared", "tool_call": true, "release_date": "2026-03-01", "modalities": {"output": ["text"]}},
              "middle": {"id": "claude-middle", "tool_call": true, "release_date": "2026-02-01", "modalities": {"output": ["text"]}},
              "older": {"id": "claude-shared", "tool_call": true, "release_date": "2026-01-01", "modalities": {"output": ["text"]}}
            }
          }
        }"#,
    )
    .expect("catalog with duplicate IDs");
    assert_eq!(
        catalog.providers[0].models,
        ["claude-shared", "claude-middle"]
    );
}

#[test]
fn binds_models_dev_catalog_to_implemented_runtime_providers() {
    let runtime = runtime_catalog_from_bytes(FIXTURE).expect("runtime catalog");
    assert_eq!(runtime.source, RuntimeCatalogSource::ModelsDev);
    assert_eq!(
        runtime.models_for(AiProviderId::Anthropic),
        ["claude-sonnet-5"]
    );
    assert_eq!(
        runtime.models_for(AiProviderId::OpenaiCodex),
        ["gpt-5.6-terra"]
    );
    assert_eq!(
        runtime.models_for(AiProviderId::Traecode),
        ["trae-account-default"]
    );
}
