use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppMode {
    #[default]
    Toolbox,
    Ai,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxSettings {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default)]
    pub mode: AppMode,
    #[serde(default)]
    pub scripts_path: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
}

#[derive(Debug, Clone)]
pub struct ModelSettings {
    pub base_url: String,
    pub model: String,
    pub auth_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub base_url: String,
    pub model: String,
    pub token_configured: bool,
}

impl Default for ToolboxSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            onboarding_completed: false,
            mode: AppMode::Toolbox,
            scripts_path: None,
            mcp_servers: Vec::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn schema_version() -> u32 {
    SETTINGS_SCHEMA_VERSION
}

pub fn settings_path() -> PathBuf {
    pi_agent_core::data_root().join("toolbox.json")
}

pub fn model_config_path() -> PathBuf {
    pi_agent_core::config_path()
}

pub fn load_settings() -> ToolboxSettings {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_settings(settings: &ToolboxSettings) -> Result<(), String> {
    let path = settings_path();
    let parent = path
        .parent()
        .ok_or_else(|| "设置路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建设置目录：{error}"))?;
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| format!("无法保存工具箱设置：{error}"))
}

pub fn load_model_settings() -> Option<ModelSettings> {
    let value: Value = serde_json::from_str(&fs::read_to_string(model_config_path()).ok()?).ok()?;
    let anthropic = value.get("anthropic")?;
    Some(ModelSettings {
        base_url: anthropic
            .get("base_url")
            .and_then(Value::as_str)
            .unwrap_or("https://api.anthropic.com")
            .to_string(),
        model: anthropic.get("model")?.as_str()?.to_string(),
        auth_token: anthropic
            .get("auth_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

pub fn model_summary() -> Option<ModelSummary> {
    load_model_settings().map(|settings| ModelSummary {
        base_url: settings.base_url,
        model: settings.model,
        token_configured: !settings.auth_token.is_empty(),
    })
}

pub fn save_model_settings(
    base_url: String,
    model: String,
    token: Option<String>,
) -> Result<(), String> {
    if base_url.trim().is_empty() || model.trim().is_empty() {
        return Err("API 地址与模型 ID 不能为空。".to_string());
    }
    let path = model_config_path();
    let mut value: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}));
    let root = value
        .as_object_mut()
        .ok_or_else(|| "现有模型配置不是 JSON 对象。".to_string())?;
    root.insert("provider".to_string(), json!("anthropic"));
    let anthropic = root
        .entry("anthropic".to_string())
        .or_insert_with(|| json!({}));
    let section = anthropic
        .as_object_mut()
        .ok_or_else(|| "anthropic 配置不是 JSON 对象。".to_string())?;
    section.insert("base_url".to_string(), json!(base_url.trim()));
    section.insert("model".to_string(), json!(model.trim()));
    if token
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        section.insert("auth_token".to_string(), json!(token.unwrap().trim()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "模型配置路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::write(
        path,
        serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("无法保存模型设置：{error}"))
}

pub fn validate_mcp_server(server: &McpServerConfig) -> Result<(), String> {
    if server.name.trim().is_empty() || server.command.trim().is_empty() {
        return Err("MCP 显示名称和命令不能为空。".to_string());
    }
    if server.id.is_empty()
        || !server.id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("MCP 配置 ID 只能包含字母、数字、点、横线和下划线。".to_string());
    }
    if server.args.len() > 64 || server.args.iter().any(|argument| argument.len() > 4096) {
        return Err("MCP 参数数量或长度超过限制。".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_safe_non_ai_mode() {
        let settings = ToolboxSettings::default();
        assert_eq!(settings.mode, AppMode::Toolbox);
        assert!(!settings.onboarding_completed);
        assert!(settings.mcp_servers.is_empty());
    }

    #[test]
    fn mcp_ids_cannot_escape_the_config_namespace() {
        let server = McpServerConfig {
            id: "../../unsafe".to_string(),
            name: "Unsafe".to_string(),
            command: "node".to_string(),
            args: Vec::new(),
            enabled: true,
        };
        assert!(validate_mcp_server(&server).is_err());
    }
}
