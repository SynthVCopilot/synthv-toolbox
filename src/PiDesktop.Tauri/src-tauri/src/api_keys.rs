//! API-key persistence and provider validation.
//!
//! Keys never leave this module except as zeroizing strings handed directly to
//! an agent provider. Settings retain only non-secret model identifiers.

use std::io::Read;
use std::time::Duration;

use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

use crate::oauth::AiProviderId;

const API_KEY_SERVICE: &str = "com.synthvcopilot.toolbox.api-key";
const MAX_MODELS_RESPONSE_BYTES: usize = 1_048_576;
const MAX_DISCOVERED_MODELS: usize = 256;
const MODEL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const ANTHROPIC_KEY_HEADER: &str = "x-api-key";
const ANTHROPIC_VERSION_HEADER: &str = "anthropic-version";
const OPENAI_AUTHORIZATION_HEADER: &str = "authorization";

/// A restorable keyring snapshot used to keep delete/configure transactions honest.
pub struct ApiKeyBackup(Option<Zeroizing<Vec<u8>>>);

fn entry(credential_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(API_KEY_SERVICE, credential_id)
        .map_err(|error| format!("系统凭据库不可用：{error}"))
}

fn read_raw(
    _provider: AiProviderId,
    credential_id: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    match entry(credential_id)?.get_secret() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统 API Key：{error}")),
    }
}

pub fn load(_provider: AiProviderId, credential_id: &str) -> Result<Zeroizing<String>, String> {
    let bytes =
        read_raw(_provider, credential_id)?.ok_or_else(|| "尚未配置 API Key。".to_string())?;
    if bytes.is_empty() {
        return Err("系统凭据库中的 API Key 为空。请重新配置。".to_string());
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(value) if !value.trim().is_empty() => Ok(Zeroizing::new(value)),
        Ok(_) => Err("系统凭据库中的 API Key 为空。请重新配置。".to_string()),
        Err(error) => {
            let mut invalid = error.into_bytes();
            invalid.zeroize();
            Err("系统凭据库中的 API Key 不是有效 UTF-8。请重新配置。".to_string())
        }
    }
}

pub fn replace(
    _provider: AiProviderId,
    credential_id: &str,
    api_key: &Zeroizing<String>,
) -> Result<ApiKeyBackup, String> {
    if api_key.trim().is_empty() {
        return Err("API Key 不能为空。".to_string());
    }
    let backup = ApiKeyBackup(read_raw(_provider, credential_id)?);
    entry(credential_id)?
        .set_secret(api_key.as_bytes())
        .map_err(|error| format!("无法写入系统 API Key：{error}"))?;
    Ok(backup)
}

pub fn take(_provider: AiProviderId, credential_id: &str) -> Result<ApiKeyBackup, String> {
    let backup = ApiKeyBackup(read_raw(_provider, credential_id)?);
    match entry(credential_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(backup),
        Err(error) => Err(format!("无法从系统凭据库删除 API Key：{error}")),
    }
}

pub fn restore(
    _provider: AiProviderId,
    credential_id: &str,
    backup: ApiKeyBackup,
) -> Result<(), String> {
    match backup.0 {
        Some(secret) => entry(credential_id)?
            .set_secret(&secret)
            .map_err(|error| format!("无法恢复系统 API Key：{error}")),
        None => match entry(credential_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法清理系统 API Key：{error}")),
        },
    }
}

pub fn discover_models(
    provider: AiProviderId,
    api_key: &Zeroizing<String>,
) -> Result<Vec<String>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(MODEL_REQUEST_TIMEOUT)
        .build();
    let response = match provider {
        AiProviderId::Anthropic => agent
            .get(ANTHROPIC_MODELS_URL)
            .set(ANTHROPIC_KEY_HEADER, api_key.as_str())
            .set(ANTHROPIC_VERSION_HEADER, "2023-06-01")
            .call(),
        AiProviderId::OpenaiCodex => {
            let authorization = Zeroizing::new(format!("Bearer {}", api_key.as_str()));
            agent
                .get(OPENAI_MODELS_URL)
                .set(OPENAI_AUTHORIZATION_HEADER, authorization.as_str())
                .call()
        }
    };
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Err(format!("API Key 验证失败（HTTP {status}）。"));
        }
        Err(_) => return Err("无法连接模型服务，请检查网络后重试。".to_string()),
    };
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .into_reader()
        .take((MAX_MODELS_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取模型目录失败。".to_string())?;
    if bytes.len() > MAX_MODELS_RESPONSE_BYTES {
        return Err("模型目录响应超过安全大小限制。".to_string());
    }
    let document: Value =
        serde_json::from_slice(&bytes).map_err(|_| "模型目录响应不是有效 JSON。".to_string())?;
    let models = filter_model_ids(&document);
    if models.is_empty() {
        return Err("API Key 已验证，但服务未返回可用模型。".to_string());
    }
    Ok(models)
}

fn filter_model_ids(document: &Value) -> Vec<String> {
    let mut models = document
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| valid_model_id(id))
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models.truncate(MAX_DISCOVERED_MODELS);
    models
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_model_endpoints_and_keyring_service_are_separate() {
        assert_eq!(ANTHROPIC_MODELS_URL, "https://api.anthropic.com/v1/models");
        assert_eq!(OPENAI_MODELS_URL, "https://api.openai.com/v1/models");
        assert_eq!(ANTHROPIC_KEY_HEADER, "x-api-key");
        assert_eq!(ANTHROPIC_VERSION_HEADER, "anthropic-version");
        assert_eq!(OPENAI_AUTHORIZATION_HEADER, "authorization");
        assert_ne!(API_KEY_SERVICE, "com.synthvcopilot.toolbox.oauth");
    }

    #[test]
    fn model_response_filtering_is_bounded_and_safe() {
        let document = serde_json::json!({"data": [
            {"id": "gpt-5.4"}, {"id": "gpt-5.4"}, {"id": "bad model"},
            {"id": ""}, {"id": 42}, {"id": "claude-sonnet-4-6"}
        ]});
        assert_eq!(
            filter_model_ids(&document),
            vec!["claude-sonnet-4-6", "gpt-5.4"]
        );
    }
}
