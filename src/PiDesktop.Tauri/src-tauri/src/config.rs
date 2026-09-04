use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::credential_balancer::{cooldown_until_utc, CredentialBalancer, CredentialRoute};
use crate::oauth::{self, AiProviderId, OAuthAccountMetadata};

const SETTINGS_SCHEMA_VERSION: u32 = 2;
pub const DEFAULT_HTTP_API_PORT: u16 = 17_831;
static MODEL_CONFIG_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static SETTINGS_LOAD_ERROR: OnceLock<String> = OnceLock::new();

pub(crate) fn model_config_mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    MODEL_CONFIG_MUTATION_LOCK
        .lock()
        .map_err(|_| "模型配置写入锁已损坏。请重启 SynthV Toolbox 后重试。".to_string())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppMode {
    #[default]
    Toolbox,
    Ai,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentWorkMode {
    #[default]
    Edit,
    Solo,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiAuthMethod {
    #[default]
    #[serde(rename = "oauth")]
    OAuth,
    ApiKey,
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
    pub agent_work_mode: AgentWorkMode,
    #[serde(default)]
    pub scripts_path: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    #[serde(default)]
    pub concurrent_disclaimer_accepted: bool,
    #[serde(default = "default_true")]
    pub sv2_concurrent_enabled: bool,
    #[serde(default)]
    pub sv2_account_indicator_enabled: bool,
    #[serde(default)]
    pub smart_svp_launch_enabled: bool,
    #[serde(default)]
    pub original_svp_prog_id: Option<String>,
    #[serde(default)]
    pub ai_provider: AiProviderId,
    #[serde(default = "default_anthropic_model")]
    pub anthropic_model: String,
    #[serde(default = "default_codex_model")]
    pub codex_model: String,
    #[serde(default)]
    pub anthropic_api_keys: Vec<ApiKeyMetadata>,
    #[serde(default)]
    pub openai_api_keys: Vec<ApiKeyMetadata>,
    #[serde(default)]
    pub oauth_accounts: Vec<OAuthAccountMetadata>,
    #[serde(default)]
    pub http_api_enabled: bool,
    #[serde(default)]
    pub http_agent_enabled: bool,
    #[serde(default = "default_http_api_port")]
    pub http_api_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyMetadata {
    pub id: String,
    pub provider: AiProviderId,
    pub label: String,
    pub models: Vec<String>,
    pub created_at_utc: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAccountSummary {
    pub id: String,
    pub label: String,
    pub expires_at: i64,
    pub authorized: bool,
    pub healthy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderSummary {
    pub id: AiProviderId,
    pub display_name: String,
    pub description: String,
    pub active: bool,
    pub connected: bool,
    pub healthy_accounts: usize,
    pub total_accounts: usize,
    pub model: String,
    pub models: Vec<String>,
    pub oauth_models: Vec<String>,
    pub api_key_models: Vec<String>,
    pub accounts: Vec<OAuthAccountSummary>,
    pub api_keys: Vec<AiApiKeySummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApiKeySummary {
    pub id: String,
    pub label: String,
    pub models: Vec<String>,
    pub healthy: bool,
    pub cooldown_until_utc: Option<String>,
    pub created_at_utc: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub active_provider: AiProviderId,
    pub providers: Vec<AiProviderSummary>,
    pub legacy_configured: bool,
}

impl Default for ToolboxSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            onboarding_completed: false,
            mode: AppMode::Toolbox,
            agent_work_mode: AgentWorkMode::Edit,
            scripts_path: None,
            mcp_servers: Vec::new(),
            concurrent_disclaimer_accepted: false,
            sv2_concurrent_enabled: true,
            sv2_account_indicator_enabled: false,
            smart_svp_launch_enabled: false,
            original_svp_prog_id: None,
            ai_provider: AiProviderId::Anthropic,
            anthropic_model: default_anthropic_model(),
            codex_model: default_codex_model(),
            anthropic_api_keys: Vec::new(),
            openai_api_keys: Vec::new(),
            oauth_accounts: Vec::new(),
            http_api_enabled: false,
            http_agent_enabled: false,
            http_api_port: DEFAULT_HTTP_API_PORT,
        }
    }
}

fn default_true() -> bool {
    true
}

fn schema_version() -> u32 {
    SETTINGS_SCHEMA_VERSION
}

fn default_anthropic_model() -> String {
    AiProviderId::Anthropic.default_model().to_string()
}

fn default_codex_model() -> String {
    AiProviderId::OpenaiCodex.default_model().to_string()
}

fn default_http_api_port() -> u16 {
    DEFAULT_HTTP_API_PORT
}

impl ToolboxSettings {
    pub fn model_for(&self, provider: AiProviderId) -> &str {
        let value = match provider {
            AiProviderId::Anthropic => &self.anthropic_model,
            AiProviderId::OpenaiCodex => &self.codex_model,
        };
        if value.trim().is_empty() {
            provider.default_model()
        } else {
            value.trim()
        }
    }

    pub fn set_model_for(&mut self, provider: AiProviderId, model: String) {
        match provider {
            AiProviderId::Anthropic => self.anthropic_model = model,
            AiProviderId::OpenaiCodex => self.codex_model = model,
        }
    }

    pub fn api_keys_for(&self, provider: AiProviderId) -> &[ApiKeyMetadata] {
        match provider {
            AiProviderId::Anthropic => &self.anthropic_api_keys,
            AiProviderId::OpenaiCodex => &self.openai_api_keys,
        }
    }

    pub fn api_key_models_for(&self, provider: AiProviderId) -> Vec<String> {
        let mut models = self
            .api_keys_for(provider)
            .iter()
            .flat_map(|key| key.models.iter().cloned())
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        models
    }

    pub fn set_api_keys_for(&mut self, provider: AiProviderId, keys: Vec<ApiKeyMetadata>) {
        match provider {
            AiProviderId::Anthropic => self.anthropic_api_keys = keys,
            AiProviderId::OpenaiCodex => self.openai_api_keys = keys,
        }
    }

    pub fn credential_routes(&self) -> Vec<CredentialRoute> {
        let mut routes = self
            .oauth_accounts
            .iter()
            .map(|account| CredentialRoute {
                id: account.id.clone(),
                provider: account.provider,
                auth_method: AiAuthMethod::OAuth,
                models: account
                    .provider
                    .model_options()
                    .iter()
                    .map(|model| (*model).to_string())
                    .collect(),
            })
            .collect::<Vec<_>>();
        routes.extend(
            self.anthropic_api_keys
                .iter()
                .chain(self.openai_api_keys.iter())
                .map(|key| CredentialRoute {
                    id: key.id.clone(),
                    provider: key.provider,
                    auth_method: AiAuthMethod::ApiKey,
                    models: key.models.clone(),
                }),
        );
        routes
    }

    pub fn upsert_oauth_account(&mut self, account: OAuthAccountMetadata) {
        if let Some(existing) = self
            .oauth_accounts
            .iter_mut()
            .find(|existing| existing.id == account.id)
        {
            *existing = account;
        } else {
            self.oauth_accounts.push(account);
        }
    }
}

pub fn settings_path() -> PathBuf {
    crate::agent::data_root().join("toolbox.json")
}

pub fn model_config_path() -> PathBuf {
    crate::agent::config_path()
}

pub fn load_settings() -> Result<ToolboxSettings, String> {
    let result = load_settings_from(&settings_path());
    if let Err(error) = &result {
        let _ = SETTINGS_LOAD_ERROR.set(error.clone());
    }
    result
}

pub fn settings_load_error() -> Option<&'static str> {
    SETTINGS_LOAD_ERROR.get().map(String::as_str)
}

fn load_settings_from(path: &Path) -> Result<ToolboxSettings, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ToolboxSettings::default());
        }
        Err(error) => {
            return Err(format!(
                "无法读取工具箱设置 {}：{error}。原文件未被修改；请修复权限或恢复该文件后重启。",
                path.display()
            ));
        }
    };
    let value = serde_json::from_str::<Value>(&text).map_err(|error| {
        format!(
            "工具箱设置 {} 不是有效的 JSON：{error}。为保护 OAuth 账号映射，应用不会用默认设置覆盖它；请修复或恢复该文件后重启。",
            path.display()
        )
    })?;
    let schema = value
        .as_object()
        .and_then(|object| object.get("schemaVersion"))
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            format!(
                "工具箱设置 {} 缺少有效的 schemaVersion。为保护 OAuth 账号映射，应用不会覆盖该文件；请恢复已知版本的设置后重启。",
                path.display()
            )
        })?;
    if schema == 0 || schema > u64::from(SETTINGS_SCHEMA_VERSION) {
        return Err(format!(
            "工具箱设置 {} 使用不受支持的 schemaVersion {schema}（当前支持 1–{SETTINGS_SCHEMA_VERSION}）。应用不会覆盖来自未知版本的设置；请使用兼容版本打开或恢复该文件。",
            path.display()
        ));
    }
    let mut settings = serde_json::from_value::<ToolboxSettings>(value).map_err(|error| {
        format!(
            "工具箱设置 {} 的字段格式无效：{error}。为保护 OAuth 账号映射，应用不会覆盖该文件；请修复或恢复后重启。",
            path.display()
        )
    })?;
    // Version 1 did not contain provider/account fields; serde defaults are
    // its explicit migration path. Every subsequent save is version 2.
    settings.schema_version = SETTINGS_SCHEMA_VERSION;
    Ok(settings)
}

pub fn save_settings(settings: &ToolboxSettings) -> Result<(), String> {
    if let Some(load_error) = settings_load_error() {
        return Err(format!(
            "工具箱处于设置恢复保护模式，已阻止写入以免覆盖 OAuth 账号映射。请修复配置并重启。原始错误：{load_error}"
        ));
    }
    let path = settings_path();
    let parent = path
        .parent()
        .ok_or_else(|| "设置路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建设置目录：{error}"))?;
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".toolbox-{}.tmp", Uuid::new_v4().simple()));
    let result: Result<(), AtomicReplaceError> = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|error| {
            AtomicReplaceError::cleanup(format!("无法创建设置临时文件：{error}"))
        })?;
        file.write_all(text.as_bytes()).map_err(|error| {
            AtomicReplaceError::cleanup(format!("无法写入设置临时文件：{error}"))
        })?;
        file.sync_all().map_err(|error| {
            AtomicReplaceError::cleanup(format!("无法同步设置临时文件：{error}"))
        })?;
        drop(file);
        atomic_replace(&temporary, &path)
    })();
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            if !error.preserve_temporary {
                let _ = fs::remove_file(&temporary);
            }
            Err(error.message)
        }
    }
}

struct AtomicReplaceError {
    message: String,
    preserve_temporary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(windows)]
enum WindowsReplaceFailureAction {
    RestoreOriginal,
    CleanupTemporary,
    PreserveRecoveryCopies,
}

#[cfg(windows)]
fn windows_replace_failure_action(
    error_code: u32,
    target_exists: bool,
    backup_exists: bool,
) -> WindowsReplaceFailureAction {
    const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: u32 = 1177;
    if error_code == ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 && backup_exists && !target_exists {
        WindowsReplaceFailureAction::RestoreOriginal
    } else if target_exists && !backup_exists {
        WindowsReplaceFailureAction::CleanupTemporary
    } else {
        WindowsReplaceFailureAction::PreserveRecoveryCopies
    }
}

impl AtomicReplaceError {
    fn cleanup(message: String) -> Self {
        Self {
            message,
            preserve_temporary: false,
        }
    }

    fn preserve(message: String) -> Self {
        Self {
            message,
            preserve_temporary: true,
        }
    }
}

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, target: &Path) -> Result<(), AtomicReplaceError> {
    fs::rename(temporary, target).map_err(|error| {
        AtomicReplaceError::preserve(format!(
            "无法原子替换工具箱设置：{error}。完整的新设置保留在 {}。",
            temporary.display()
        ))
    })?;
    let parent = target
        .parent()
        .ok_or_else(|| AtomicReplaceError::cleanup("设置路径没有父目录".to_string()))?;
    // Persist the renamed directory entry as well as the file contents. Once
    // rename succeeds the in-memory settings must be committed too, so a
    // filesystem that cannot fsync directories is treated as best-effort.
    if let Err(error) = fs::File::open(parent).and_then(|directory| directory.sync_all()) {
        eprintln!("无法同步工具箱设置目录 {}：{error}", parent.display());
    }
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, target: &Path) -> Result<(), AtomicReplaceError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !target.exists() {
        return fs::rename(temporary, target).map_err(|error| {
            AtomicReplaceError::preserve(format!(
                "无法安装工具箱设置：{error}。完整的新设置保留在 {}。",
                temporary.display()
            ))
        });
    }
    let parent = target
        .parent()
        .ok_or_else(|| AtomicReplaceError::cleanup("设置路径没有父目录".to_string()))?;
    let backup = parent.join(format!(".toolbox-{}.bak", Uuid::new_v4().simple()));
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let backup_wide = backup
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced != 0 {
        let _ = fs::remove_file(backup);
        return Ok(());
    }

    let replace_error = std::io::Error::last_os_error();
    let error_code = replace_error.raw_os_error().unwrap_or_default() as u32;

    match windows_replace_failure_action(error_code, target.exists(), backup.exists()) {
        // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 means ReplaceFileW already moved
        // the original to the backup path. Restore it before returning.
        WindowsReplaceFailureAction::RestoreOriginal => match fs::rename(&backup, target) {
            Ok(()) => {
                Err(AtomicReplaceError::cleanup(format!(
                    "无法原子替换工具箱设置：{replace_error}。原设置已恢复。"
                )))
            }
            Err(restore_error) => Err(AtomicReplaceError::preserve(format!(
                    "无法原子替换工具箱设置：{replace_error}；原设置恢复也失败：{restore_error}。原设置保留在 {}，新设置保留在 {}。",
                    backup.display(),
                    temporary.display()
                ))),
        },
        // For documented 1175/1176 paths, both files retain their original
        // names when a backup name was supplied.
        WindowsReplaceFailureAction::CleanupTemporary => Err(AtomicReplaceError::cleanup(format!(
            "无法原子替换工具箱设置：{replace_error}"
        ))),
        WindowsReplaceFailureAction::PreserveRecoveryCopies => Err(AtomicReplaceError::preserve(format!(
            "无法原子替换工具箱设置：{replace_error}。为避免数据丢失，新设置保留在 {}{}。",
            temporary.display(),
            if backup.exists() {
                format!("，原设置保留在 {}", backup.display())
            } else {
                String::new()
            }
        ))),
    }
}

fn legacy_model_token_configured() -> bool {
    let Ok(text) = fs::read_to_string(model_config_path()) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get("anthropic")
        .and_then(|anthropic| anthropic.get("auth_token"))
        .and_then(Value::as_str)
        .is_some_and(|token| !token.trim().is_empty())
}

pub fn model_summary(settings: &ToolboxSettings, balancer: &CredentialBalancer) -> ModelSummary {
    let providers = [AiProviderId::Anthropic, AiProviderId::OpenaiCodex]
        .into_iter()
        .map(|provider| {
            let api_keys = settings
                .api_keys_for(provider)
                .iter()
                .map(|key| {
                    let health = balancer.health(AiAuthMethod::ApiKey, &key.id);
                    AiApiKeySummary {
                        id: key.id.clone(),
                        label: key.label.clone(),
                        models: key.models.clone(),
                        healthy: health.healthy,
                        cooldown_until_utc: cooldown_until_utc(health.cooldown_until_ms),
                        created_at_utc: key.created_at_utc.clone(),
                    }
                })
                .collect::<Vec<_>>();
            let account_metadata = settings
                .oauth_accounts
                .iter()
                .filter(|account| account.provider == provider)
                .cloned()
                .collect::<Vec<_>>();
            let discovered_codex_models = (provider == AiProviderId::OpenaiCodex)
                .then(|| oauth::discover_codex_models(&account_metadata).ok())
                .flatten();
            let accounts = account_metadata
                .iter()
                .map(|account| {
                    let authorized = oauth::credential_available(account);
                    OAuthAccountSummary {
                        id: account.id.clone(),
                        label: account.label.clone(),
                        expires_at: oauth::credential_expires_at(account).unwrap_or_default(),
                        authorized,
                        healthy: authorized && oauth::credential_healthy(account),
                    }
                })
                .collect::<Vec<_>>();
            let healthy_accounts = accounts.iter().filter(|account| account.healthy).count();
            let oauth_models = oauth_models_for(provider, discovered_codex_models.as_ref());
            let api_key_models = settings.api_key_models_for(provider);
            let mut models = oauth_models.clone();
            models.extend(api_key_models.iter().cloned());
            models.sort();
            models.dedup();
            let active = settings.ai_provider == provider;
            AiProviderSummary {
                id: provider,
                display_name: provider.display_name().to_string(),
                description: match provider {
                    AiProviderId::Anthropic => {
                        "支持 OAuth（Claude Pro / Max）或 Anthropic API Key。".to_string()
                    }
                    AiProviderId::OpenaiCodex => {
                        "支持 OAuth（ChatGPT Plus / Pro）或 OpenAI API Key。".to_string()
                    }
                },
                active,
                connected: accounts.iter().any(|account| account.authorized)
                    || !api_keys.is_empty(),
                healthy_accounts,
                total_accounts: accounts.len(),
                model: settings.model_for(provider).to_string(),
                models,
                oauth_models,
                api_key_models,
                accounts,
                api_keys,
            }
        })
        .collect();
    ModelSummary {
        active_provider: settings.ai_provider,
        providers,
        legacy_configured: legacy_model_token_configured(),
    }
}

fn oauth_models_for(
    provider: AiProviderId,
    discovered_codex_models: Option<&HashSet<String>>,
) -> Vec<String> {
    provider
        .model_options()
        .iter()
        .filter(|model| {
            **model != oauth::CODEX_SPARK_MODEL_ID
                || discovered_codex_models.is_some_and(|models| models.contains(**model))
        })
        .map(|model| (*model).to_string())
        .collect()
}

pub fn validate_ai_model(
    settings: &ToolboxSettings,
    provider: AiProviderId,
    model: &str,
) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() || model.len() > 120 {
        return Err("模型 ID 不能为空且不能超过 120 个字符。".to_string());
    }
    if !model.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
    }) {
        return Err("模型 ID 包含不受支持的字符。".to_string());
    }
    let oauth_available = provider.model_options().contains(&model);
    let api_key_available = settings
        .api_key_models_for(provider)
        .iter()
        .any(|available| available == model);
    if !oauth_available && !api_key_available {
        return Err("该模型不在当前供应商的 OAuth 或 API Key 模型目录中。".to_string());
    }
    Ok(model.to_string())
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
        assert!(!settings.concurrent_disclaimer_accepted);
        assert!(settings.sv2_concurrent_enabled);
        assert!(!settings.sv2_account_indicator_enabled);
        assert!(!settings.smart_svp_launch_enabled);
        assert!(settings.original_svp_prog_id.is_none());
        assert_eq!(settings.ai_provider, AiProviderId::Anthropic);
        assert_eq!(settings.anthropic_model, "claude-sonnet-4-6");
        assert_eq!(settings.codex_model, "gpt-5.6-terra");
        assert!(settings.oauth_accounts.is_empty());
    }

    #[test]
    fn missing_settings_file_uses_safe_defaults() {
        let path = std::env::temp_dir().join(format!(
            "synthv-toolbox-missing-settings-{}.json",
            Uuid::new_v4().simple()
        ));
        let settings = load_settings_from(&path).unwrap();
        assert_eq!(settings.mode, AppMode::Toolbox);
        assert!(settings.oauth_accounts.is_empty());
    }

    #[test]
    fn malformed_settings_are_not_silently_replaced() {
        let path = std::env::temp_dir().join(format!(
            "synthv-toolbox-invalid-settings-{}.json",
            Uuid::new_v4().simple()
        ));
        let original = b"{invalid-json";
        fs::write(&path, original).unwrap();

        let error = load_settings_from(&path).unwrap_err();

        assert!(error.contains("不会用默认设置覆盖"));
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn schema_one_settings_are_explicitly_migrated() {
        let path = std::env::temp_dir().join(format!(
            "synthv-toolbox-v1-settings-{}.json",
            Uuid::new_v4().simple()
        ));
        fs::write(
            &path,
            r#"{"schemaVersion":1,"onboardingCompleted":true,"mode":"ai"}"#,
        )
        .unwrap();

        let settings = load_settings_from(&path).unwrap();

        assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
        assert!(settings.onboarding_completed);
        assert_eq!(settings.mode, AppMode::Ai);
        assert!(settings.oauth_accounts.is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn missing_or_future_schema_is_recovery_only() {
        for document in [r#"{}"#, r#"{"schemaVersion":999,"futureField":true}"#] {
            let path = std::env::temp_dir().join(format!(
                "synthv-toolbox-unsupported-settings-{}.json",
                Uuid::new_v4().simple()
            ));
            fs::write(&path, document).unwrap();

            let error = load_settings_from(&path).unwrap_err();

            assert!(error.contains("不会覆盖"));
            assert_eq!(fs::read_to_string(&path).unwrap(), document);
            fs::remove_file(path).unwrap();
        }
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

    #[test]
    fn codex_model_must_come_from_the_subscription_catalog() {
        let settings = ToolboxSettings::default();
        assert!(validate_ai_model(&settings, AiProviderId::OpenaiCodex, "gpt-5.6-terra").is_ok());
        assert!(validate_ai_model(&settings, AiProviderId::OpenaiCodex, "invented-model").is_err());
    }

    #[test]
    fn auth_method_serializes_as_the_stable_frontend_contract() {
        assert_eq!(
            serde_json::to_string(&AiAuthMethod::OAuth).unwrap(),
            "\"oauth\""
        );
        assert_eq!(
            serde_json::to_string(&AiAuthMethod::ApiKey).unwrap(),
            "\"api-key\""
        );
    }

    #[test]
    fn provider_summary_has_generic_installation_labels() {
        assert_eq!(AiProviderId::Anthropic.display_name(), "Claude / Anthropic");
        assert_eq!(AiProviderId::OpenaiCodex.display_name(), "OpenAI / Codex");
        let balancer = CredentialBalancer::new([]);
        let encoded =
            serde_json::to_value(model_summary(&ToolboxSettings::default(), &balancer)).unwrap();
        let providers = encoded["providers"].as_array().unwrap();
        assert!(providers[0]["description"]
            .as_str()
            .unwrap()
            .contains("API Key"));
        assert!(providers[1]["description"]
            .as_str()
            .unwrap()
            .contains("API Key"));
    }

    #[test]
    fn provider_summary_exposes_configuration_state_not_secret_material() {
        let summary = AiProviderSummary {
            id: AiProviderId::Anthropic,
            display_name: "Claude API".to_string(),
            description: "Platform API".to_string(),
            active: true,
            connected: true,
            healthy_accounts: 0,
            total_accounts: 0,
            model: "claude-sonnet-4-6".to_string(),
            models: vec![
                "claude-opus-4-8".to_string(),
                "claude-sonnet-4-6".to_string(),
            ],
            oauth_models: vec!["claude-sonnet-4-6".to_string()],
            api_key_models: vec!["claude-opus-4-8".to_string()],
            accounts: Vec::new(),
            api_keys: Vec::new(),
        };
        let value = serde_json::to_value(summary).unwrap();
        assert_eq!(value["oauthModels"][0], "claude-sonnet-4-6");
        assert_eq!(value["apiKeyModels"][0], "claude-opus-4-8");
        assert_eq!(value["models"].as_array().unwrap().len(), 2);
        assert!(value.get("apiKey").is_none());
        assert!(!value.to_string().contains("sk-ant-"));
    }

    #[test]
    fn oauth_and_api_key_model_directories_never_mix() {
        let mut settings = ToolboxSettings::default();
        settings.anthropic_api_keys = vec![ApiKeyMetadata {
            id: "key-1".to_string(),
            provider: AiProviderId::Anthropic,
            label: "A".to_string(),
            models: vec!["claude-api-only".to_string()],
            created_at_utc: "2026-01-01T00:00:00Z".to_string(),
        }];
        settings.openai_api_keys = vec![ApiKeyMetadata {
            id: "key-2".to_string(),
            provider: AiProviderId::OpenaiCodex,
            label: "B".to_string(),
            models: vec!["gpt-api-only".to_string()],
            created_at_utc: "2026-01-01T00:00:00Z".to_string(),
        }];

        let oauth = oauth_models_for(AiProviderId::Anthropic, None);
        let api_key = settings.api_key_models_for(AiProviderId::Anthropic);
        assert!(oauth.contains(&"claude-sonnet-4-6".to_string()));
        assert!(!oauth.contains(&"claude-api-only".to_string()));
        assert_eq!(api_key, vec!["claude-api-only"]);
        assert_eq!(
            settings.api_key_models_for(AiProviderId::OpenaiCodex),
            vec!["gpt-api-only"]
        );
    }

    #[test]
    fn model_config_mutation_guard_is_exclusive() {
        let guard = model_config_mutation_guard().unwrap();
        assert!(MODEL_CONFIG_MUTATION_LOCK.try_lock().is_err());

        drop(guard);
        assert!(MODEL_CONFIG_MUTATION_LOCK.try_lock().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_failure_paths_preserve_a_recovery_copy() {
        assert_eq!(
            windows_replace_failure_action(1175, true, false),
            WindowsReplaceFailureAction::CleanupTemporary
        );
        assert_eq!(
            windows_replace_failure_action(1176, true, false),
            WindowsReplaceFailureAction::CleanupTemporary
        );
        assert_eq!(
            windows_replace_failure_action(1177, false, true),
            WindowsReplaceFailureAction::RestoreOriginal
        );
        assert_eq!(
            windows_replace_failure_action(1176, false, false),
            WindowsReplaceFailureAction::PreserveRecoveryCopies
        );
    }
}
