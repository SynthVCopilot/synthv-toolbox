//! Browser OAuth for the supported official subscription runtimes.
//!
//! The renderer only receives non-secret account metadata. Renewable credentials
//! are stored in the operating-system credential store and are loaded/refreshed
//! only by the Rust backend immediately before a model request.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const CREDENTIAL_SERVICE: &str = "com.synthvcopilot.toolbox.oauth";
const AUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_LIMIT: usize = 16 * 1024;
const TOKEN_RESPONSE_LIMIT: usize = 128 * 1024;
const CODEX_MODELS_RESPONSE_LIMIT: usize = 512 * 1024;
const CODEX_MODELS_TIMEOUT: Duration = Duration::from_secs(5);
const CODEX_MODELS_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const CODEX_MODELS_FAILURE_CACHE_TTL: Duration = Duration::from_secs(30);
const CODEX_MODELS_MAX_CONCURRENCY: usize = 4;
const MAX_TOKEN_LIFETIME_SECONDS: i64 = 365 * 24 * 60 * 60;
const REFRESH_EARLY_MS: i64 = 30_000;
const SECRET_CHUNK_BYTES: usize = 2_048;
const MAX_SECRET_CHUNKS: usize = 32;
const SECRET_MANIFEST_VERSION: u8 = 1;

const ANTHROPIC_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID_B64: &str = "OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl";
const ANTHROPIC_REDIRECT_URI: &str = "http://localhost:53692/callback";
const ANTHROPIC_SCOPE: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const CODEX_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_ID_B64: &str = "YXBwX0VNb2FtRUVaNzNmMENrWGFYcDdocmFubg==";
const CODEX_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CODEX_SCOPE: &str = "openid profile email offline_access";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiProviderId {
    #[default]
    Anthropic,
    OpenaiCodex,
    Workbuddy,
    Traecode,
}

impl AiProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenaiCodex => "openai-codex",
            Self::Workbuddy => "workbuddy",
            Self::Traecode => "traecode",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude / Anthropic",
            Self::OpenaiCodex => "OpenAI / Codex",
            Self::Workbuddy => "WorkBuddy",
            Self::Traecode => "TraeCode",
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-4-6",
            Self::OpenaiCodex => "gpt-5.6-terra",
            Self::Workbuddy => "glm-5.2",
            Self::Traecode => "trae-account-default",
        }
    }

    pub fn fallback_model_options(self) -> &'static [&'static str] {
        match self {
            Self::Anthropic => &[
                "claude-sonnet-4-6",
                "claude-sonnet-5",
                "claude-haiku-4-5",
                "claude-opus-4-8",
                "claude-opus-5",
            ],
            Self::OpenaiCodex => &[
                "gpt-5.6-luna",
                "gpt-5.6-terra",
                "gpt-5.6-sol",
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
                "gpt-5.3-codex-spark",
            ],
            Self::Workbuddy => &[
                "glm-5.2",
                "glm-5.1",
                "glm-5v-turbo",
                "kimi-k2.7",
                "minimax-m3-pay",
                "hy3",
                "deepseek-v4-pro",
                "deepseek-v4-flash",
            ],
            Self::Traecode => &["trae-account-default"],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAccountMetadata {
    pub id: String,
    pub provider: AiProviderId,
    pub label: String,
    pub expires_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCredential {
    pub access: String,
    pub refresh: String,
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

impl fmt::Debug for OAuthCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthCredential")
            .field("access", &"[REDACTED]")
            .field("refresh", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("account_id", &self.account_id)
            .finish()
    }
}

impl Drop for OAuthCredential {
    fn drop(&mut self) {
        self.access.zeroize();
        self.refresh.zeroize();
        if let Some(account_id) = &mut self.account_id {
            account_id.zeroize();
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthorizedAccount {
    pub metadata: OAuthAccountMetadata,
    credential: OAuthCredential,
}

pub struct CredentialBackup {
    persisted: RawCredentialBackup,
    cached: Option<OAuthCredential>,
    pending: bool,
}

struct RawCredentialBackup {
    root: Option<Vec<u8>>,
    slot_a: Vec<Option<Vec<u8>>>,
    slot_b: Vec<Option<Vec<u8>>>,
}

impl Drop for RawCredentialBackup {
    fn drop(&mut self) {
        if let Some(root) = &mut self.root {
            root.zeroize();
        }
        for value in self
            .slot_a
            .iter_mut()
            .chain(self.slot_b.iter_mut())
            .flatten()
        {
            value.zeroize();
        }
    }
}

/// Only the renewable, compact secret is persisted in the OS credential store.
///
/// Windows Generic Credentials cap a binary secret at 2560 bytes. Refresh
/// tokens are split into versioned entries when needed; access tokens stay in
/// process memory and are recreated lazily after a restart.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedOAuthSecret {
    refresh: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    // Backward-compatible reader for credentials written by early builds. New
    // writes deliberately omit these potentially large fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
}

impl Drop for PersistedOAuthSecret {
    fn drop(&mut self) {
        self.refresh.zeroize();
        if let Some(account_id) = &mut self.account_id {
            account_id.zeroize();
        }
        if let Some(access) = &mut self.access {
            access.zeroize();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretManifest {
    version: u8,
    generation: String,
    chunks: usize,
    total_len: usize,
    sha256: String,
}

#[derive(Debug, Clone, Copy)]
struct OAuthConfig {
    authorize_url: &'static str,
    token_url: &'static str,
    client_id_b64: &'static str,
    redirect_uri: &'static str,
    callback_path: &'static str,
    scope: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
enum CallbackOutcome {
    Code(String),
    ProviderError,
    Ignore,
}

impl OAuthConfig {
    fn for_provider(provider: AiProviderId) -> Self {
        match provider {
            AiProviderId::Anthropic => Self {
                authorize_url: ANTHROPIC_AUTHORIZE_URL,
                token_url: ANTHROPIC_TOKEN_URL,
                client_id_b64: ANTHROPIC_CLIENT_ID_B64,
                redirect_uri: ANTHROPIC_REDIRECT_URI,
                callback_path: "/callback",
                scope: ANTHROPIC_SCOPE,
            },
            AiProviderId::OpenaiCodex => Self {
                authorize_url: CODEX_AUTHORIZE_URL,
                token_url: CODEX_TOKEN_URL,
                client_id_b64: CODEX_CLIENT_ID_B64,
                redirect_uri: CODEX_REDIRECT_URI,
                callback_path: "/auth/callback",
                scope: CODEX_SCOPE,
            },
            AiProviderId::Workbuddy | AiProviderId::Traecode => {
                unreachable!("non-OAuth provider passed to the official OAuth flow")
            }
        }
    }

    fn client_id(self) -> Result<String, String> {
        let bytes = URL_SAFE
            .decode(self.client_id_b64)
            .map_err(|error| format!("OAuth 客户端标识无效：{error}"))?;
        String::from_utf8(bytes).map_err(|error| format!("OAuth 客户端标识不是 UTF-8：{error}"))
    }

    fn port(self) -> Result<u16, String> {
        Url::parse(self.redirect_uri)
            .map_err(|error| format!("OAuth 回调地址无效：{error}"))?
            .port()
            .ok_or_else(|| "OAuth 回调地址缺少端口。".to_string())
    }
}

static AUTHORIZING: OnceLock<Mutex<HashSet<AiProviderId>>> = OnceLock::new();
static CREDENTIAL_CACHE: OnceLock<Mutex<HashMap<String, OAuthCredential>>> = OnceLock::new();
static REFRESH_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
static PERSISTENCE_PENDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static OAUTH_AGENT: OnceLock<ureq::Agent> = OnceLock::new();
static CODEX_MODELS_AGENT: OnceLock<ureq::Agent> = OnceLock::new();
static CODEX_MODELS_CACHE: OnceLock<Mutex<HashMap<String, CodexModelsCacheEntry>>> =
    OnceLock::new();

#[derive(Clone)]
struct CodexModelsCacheEntry {
    checked_at: Instant,
    result: Result<HashSet<String>, String>,
}

struct AuthorizationGuard(AiProviderId);

impl AuthorizationGuard {
    fn acquire(provider: AiProviderId) -> Result<Self, String> {
        let mut active = AUTHORIZING
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| "OAuth 授权状态锁已损坏。".to_string())?;
        if !active.insert(provider) {
            return Err(format!("{} 正在等待浏览器授权。", provider.display_name()));
        }
        Ok(Self(provider))
    }
}

impl Drop for AuthorizationGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = AUTHORIZING
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
        {
            active.remove(&self.0);
        }
    }
}

pub fn authorize(provider: AiProviderId) -> Result<AuthorizedAccount, String> {
    if matches!(provider, AiProviderId::Workbuddy | AiProviderId::Traecode) {
        return Err(format!("{} 使用专用授权流程。", provider.display_name()));
    }
    let _guard = AuthorizationGuard::acquire(provider)?;
    let config = OAuthConfig::for_provider(provider);
    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let state = random_url_token();
    let listener = TcpListener::bind(("127.0.0.1", config.port()?)).map_err(|error| {
        format!(
            "无法启动 {} 的本地 OAuth 回调：{error}",
            provider.display_name()
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置 OAuth 回调：{error}"))?;

    let authorize_url = build_authorize_url(provider, config, &challenge, &state)?;
    open_external(&authorize_url)?;
    let code = wait_for_callback(&listener, config, &state, AUTH_TIMEOUT)?;
    let credential = exchange_code(provider, config, &code, &verifier, &state)?;
    let provider_account_id = credential
        .account_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let id = format!("oauth:{}:{provider_account_id}", provider.as_str());
    let metadata = OAuthAccountMetadata {
        id,
        provider,
        label: match provider {
            AiProviderId::Anthropic => "Claude official account".to_string(),
            AiProviderId::OpenaiCodex => "ChatGPT official account".to_string(),
            AiProviderId::Workbuddy => "WorkBuddy account".to_string(),
            AiProviderId::Traecode => "TraeCode account".to_string(),
        },
        expires_at: credential.expires_at,
    };
    Ok(AuthorizedAccount {
        metadata,
        credential,
    })
}

pub fn install_authorized(account: &AuthorizedAccount) -> Result<CredentialBackup, String> {
    let account_lock = account_lock(&account.metadata)?;
    let _account_guard = account_lock
        .lock()
        .map_err(|_| "OAuth 账号锁已损坏。".to_string())?;
    let backup = backup_credential(&account.metadata)?;
    let mutation = (|| {
        // A raw backup allows an explicitly re-authorized account to replace a
        // corrupt legacy manifest or a partially missing chunk set.
        delete_persisted_secret(&account.metadata)?;
        save_new_credential(&account.metadata, &account.credential)
    })();
    if let Err(mutation_error) = mutation {
        let rollback = restore_credential_locked(&account.metadata, &backup);
        return Err(with_rollback_error(mutation_error, rollback));
    }
    invalidate_codex_models_cache(&account.metadata);
    Ok(backup)
}

pub fn take_credential(metadata: &OAuthAccountMetadata) -> Result<CredentialBackup, String> {
    let account_lock = account_lock(metadata)?;
    let _account_guard = account_lock
        .lock()
        .map_err(|_| "OAuth 账号锁已损坏。".to_string())?;
    let backup = backup_credential(metadata)?;
    let mutation = (|| {
        delete_persisted_secret(metadata)?;
        CREDENTIAL_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "OAuth 凭据缓存锁已损坏。".to_string())?
            .remove(&metadata.id);
        set_persistence_pending(metadata, false)
    })();
    if let Err(mutation_error) = mutation {
        let rollback = restore_credential_locked(metadata, &backup);
        return Err(with_rollback_error(mutation_error, rollback));
    }
    invalidate_codex_models_cache(metadata);
    Ok(backup)
}

pub fn restore_credential(
    metadata: &OAuthAccountMetadata,
    backup: &CredentialBackup,
) -> Result<(), String> {
    let account_lock = account_lock(metadata)?;
    let _account_guard = account_lock
        .lock()
        .map_err(|_| "OAuth 账号锁已损坏。".to_string())?;
    restore_credential_locked(metadata, backup)
}

fn restore_credential_locked(
    metadata: &OAuthAccountMetadata,
    backup: &CredentialBackup,
) -> Result<(), String> {
    let mut rollback_errors = Vec::new();
    if let Err(error) = restore_raw_credential(metadata, &backup.persisted) {
        rollback_errors.push(error);
    }
    match CREDENTIAL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        Ok(mut cache) => {
            if let Some(credential) = &backup.cached {
                cache.insert(metadata.id.clone(), credential.clone());
            } else {
                cache.remove(&metadata.id);
            }
        }
        Err(_) => rollback_errors.push("OAuth 凭据缓存锁已损坏。".to_string()),
    }
    if let Err(error) = set_persistence_pending(metadata, backup.pending) {
        rollback_errors.push(error);
    }
    if rollback_errors.is_empty() {
        Ok(())
    } else {
        Err(rollback_errors.join("；"))
    }
}

fn with_rollback_error(mutation_error: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => mutation_error,
        Err(rollback_error) => format!("{mutation_error}；内部回滚也失败：{rollback_error}"),
    }
}

pub fn load_ready_credential(metadata: &OAuthAccountMetadata) -> Result<OAuthCredential, String> {
    if let Some(credential) = cached_credential(metadata)? {
        if credential.expires_at > now_ms() + REFRESH_EARLY_MS && !persistence_pending(metadata)? {
            return Ok(credential);
        }
    }

    // A refresh token can rotate, so only one request may read/refresh/write it
    // at a time. Recheck the cache after acquiring the lock in case another
    // request already completed the refresh.
    let account_lock = account_lock(metadata)?;
    let _account_guard = account_lock
        .lock()
        .map_err(|_| "OAuth 账号锁已损坏。".to_string())?;
    if let Some(credential) = cached_credential(metadata)? {
        if credential.expires_at > now_ms() + REFRESH_EARLY_MS {
            if persistence_pending(metadata)? {
                persist_refresh_secret(metadata, &credential.refresh).map_err(|error| {
                    format!("OAuth 刷新凭据仍无法持久化，请勿退出应用并尽快重试：{error}")
                })?;
                set_persistence_pending(metadata, false)?;
            }
            return Ok(credential);
        }
    }

    let mut stored = load_secret(metadata)?;
    let current = OAuthCredential {
        access: stored.access.take().unwrap_or_default(),
        refresh: std::mem::take(&mut stored.refresh),
        expires_at: stored.expires_at.take().unwrap_or_default(),
        account_id: stored.account_id.take(),
    };
    if !current.access.is_empty() && current.expires_at > now_ms() + REFRESH_EARLY_MS {
        // Migrate an early full-token entry to the compact refresh-only format.
        verify_account_binding(metadata, &current)?;
        save_new_credential(metadata, &current)?;
        return Ok(current);
    }

    let credential = refresh(metadata.provider, &current)?;
    verify_account_binding(metadata, &credential)?;
    save_refreshed_credential(metadata, &credential)?;
    Ok(credential)
}

pub fn credential_available(metadata: &OAuthAccountMetadata) -> bool {
    account_lock(metadata)
        .ok()
        .and_then(|account_lock| account_lock.lock().ok().map(|_guard| load_secret(metadata)))
        .is_some_and(|result| result.is_ok_and(|secret| !secret.refresh.trim().is_empty()))
}

pub fn credential_healthy(metadata: &OAuthAccountMetadata) -> bool {
    cached_credential(metadata)
        .ok()
        .flatten()
        .is_some_and(|credential| {
            credential.expires_at > now_ms() + REFRESH_EARLY_MS
                && !persistence_pending(metadata).unwrap_or(true)
        })
}

pub fn credential_expires_at(metadata: &OAuthAccountMetadata) -> Option<i64> {
    cached_credential(metadata)
        .ok()
        .flatten()
        .filter(|credential| credential.expires_at > now_ms())
        .map(|credential| credential.expires_at)
}

pub fn invalidate_access(metadata: &OAuthAccountMetadata) -> Result<(), String> {
    let account_lock = account_lock(metadata)?;
    let _account_guard = account_lock
        .lock()
        .map_err(|_| "OAuth 账号锁已损坏。".to_string())?;
    if let Some(credential) = CREDENTIAL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "OAuth 凭据缓存锁已损坏。".to_string())?
        .get_mut(&metadata.id)
    {
        credential.access.zeroize();
        credential.expires_at = 0;
    }
    invalidate_codex_models_cache(metadata);
    Ok(())
}

pub fn discover_codex_models(accounts: &[OAuthAccountMetadata]) -> Result<HashSet<String>, String> {
    let codex_accounts = accounts
        .iter()
        .filter(|account| account.provider == AiProviderId::OpenaiCodex)
        .collect::<Vec<_>>();
    if codex_accounts.is_empty() {
        return Ok(HashSet::new());
    }

    let mut union = HashSet::new();
    let mut failures = Vec::new();
    let mut succeeded = false;
    for batch in codex_accounts.chunks(CODEX_MODELS_MAX_CONCURRENCY) {
        let attempts = std::thread::scope(|scope| {
            batch
                .iter()
                .map(|account| {
                    let account = *account;
                    let handle = scope.spawn(move || codex_account_models(account));
                    (account, handle)
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|(account, handle)| {
                    let result = handle
                        .join()
                        .unwrap_or_else(|_| Err("Codex 模型目录线程异常退出。".to_string()));
                    (account, result)
                })
                .collect::<Vec<_>>()
        });
        for (account, models) in attempts {
            match models {
                Ok(models) => {
                    succeeded = true;
                    union.extend(models);
                }
                Err(error) => failures.push(format!("{}：{error}", account.label)),
            }
        }
    }
    if succeeded {
        Ok(union)
    } else {
        Err(failures.join("；"))
    }
}

pub fn codex_account_models(metadata: &OAuthAccountMetadata) -> Result<HashSet<String>, String> {
    if metadata.provider != AiProviderId::OpenaiCodex {
        return Err("账号不是 Codex OAuth 账号。".to_string());
    }
    if let Some(result) = cached_codex_models(metadata)? {
        return result;
    }
    let result = query_codex_models(metadata);
    let _ = cache_codex_models(metadata, &result);
    result
}

fn query_codex_models(metadata: &OAuthAccountMetadata) -> Result<HashSet<String>, String> {
    let credential = load_ready_credential(metadata)?;
    let account_id = credential
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex OAuth 凭据缺少 ChatGPT account id。".to_string())?;
    let response = codex_models_agent()
        .get(CODEX_MODELS_URL)
        .query("client_version", env!("CARGO_PKG_VERSION"))
        .set("accept", "application/json")
        .set("authorization", &format!("Bearer {}", credential.access))
        .set("ChatGPT-Account-ID", account_id)
        .set("originator", "pi")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(code @ (401 | 403), _) => {
                let _ = invalidate_access(metadata);
                format!("Codex 模型目录授权失效（HTTP {code}）。")
            }
            ureq::Error::Status(code, _) => {
                format!("Codex 模型目录请求失败（HTTP {code}）。")
            }
            ureq::Error::Transport(error) => format!("Codex 模型目录请求失败：{error}"),
        })?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((CODEX_MODELS_RESPONSE_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 Codex 模型目录：{error}"))?;
    if bytes.len() > CODEX_MODELS_RESPONSE_LIMIT {
        bytes.zeroize();
        return Err("Codex 模型目录超过 512 KiB 安全上限。".to_string());
    }
    let payload =
        serde_json::from_slice(&bytes).map_err(|_| "Codex 模型目录不是有效 JSON。".to_string());
    bytes.zeroize();
    parse_codex_models_payload(&payload?)
}

fn parse_codex_models_payload(payload: &Value) -> Result<HashSet<String>, String> {
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex 模型目录缺少 models 数组。".to_string())?;
    Ok(models
        .iter()
        .take(256)
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let id = object
                .get("slug")
                .or_else(|| object.get("id"))?
                .as_str()?
                .trim();
            let visibility = object
                .get("visibility")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            (!id.is_empty()
                && id.len() <= 120
                && !visibility.eq_ignore_ascii_case("none")
                && id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
                }))
            .then(|| id.to_string())
        })
        .collect())
}

fn cached_codex_models(
    metadata: &OAuthAccountMetadata,
) -> Result<Option<Result<HashSet<String>, String>>, String> {
    let cache = CODEX_MODELS_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Codex 模型目录缓存锁已损坏。".to_string())?;
    Ok(cache
        .get(&metadata.id)
        .filter(|entry| {
            entry.checked_at.elapsed()
                <= if entry.result.is_ok() {
                    CODEX_MODELS_CACHE_TTL
                } else {
                    CODEX_MODELS_FAILURE_CACHE_TTL
                }
        })
        .map(|entry| entry.result.clone()))
}

fn cache_codex_models(
    metadata: &OAuthAccountMetadata,
    result: &Result<HashSet<String>, String>,
) -> Result<(), String> {
    CODEX_MODELS_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Codex 模型目录缓存锁已损坏。".to_string())?
        .insert(
            metadata.id.clone(),
            CodexModelsCacheEntry {
                checked_at: Instant::now(),
                result: result.clone(),
            },
        );
    Ok(())
}

fn invalidate_codex_models_cache(metadata: &OAuthAccountMetadata) {
    if metadata.provider != AiProviderId::OpenaiCodex {
        return;
    }
    if let Ok(mut cache) = CODEX_MODELS_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.remove(&metadata.id);
    }
}

fn backup_credential(metadata: &OAuthAccountMetadata) -> Result<CredentialBackup, String> {
    let mut persisted = RawCredentialBackup {
        root: read_optional_secret(&credential_entry(metadata)?, "根凭据")?,
        slot_a: Vec::with_capacity(MAX_SECRET_CHUNKS),
        slot_b: Vec::with_capacity(MAX_SECRET_CHUNKS),
    };
    for index in 0..MAX_SECRET_CHUNKS {
        persisted.slot_a.push(read_optional_secret(
            &credential_chunk_entry(metadata, "a", index)?,
            &format!("分片 a/{index}"),
        )?);
        persisted.slot_b.push(read_optional_secret(
            &credential_chunk_entry(metadata, "b", index)?,
            &format!("分片 b/{index}"),
        )?);
    }
    Ok(CredentialBackup {
        persisted,
        cached: cached_credential(metadata)?,
        pending: persistence_pending(metadata)?,
    })
}

fn read_optional_secret(entry: &keyring::Entry, label: &str) -> Result<Option<Vec<u8>>, String> {
    match entry.get_secret() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法备份现有 OAuth {label}：{error}")),
    }
}

fn restore_raw_credential(
    metadata: &OAuthAccountMetadata,
    backup: &RawCredentialBackup,
) -> Result<(), String> {
    let mut errors = Vec::new();
    let mut failed_slots = HashSet::new();
    for (generation, values) in [("a", &backup.slot_a), ("b", &backup.slot_b)] {
        for index in 0..MAX_SECRET_CHUNKS {
            match credential_chunk_entry(metadata, generation, index) {
                Ok(entry) => {
                    if let Err(error) =
                        restore_raw_entry(&entry, values.get(index).and_then(Option::as_deref))
                    {
                        failed_slots.insert((generation.to_string(), index));
                        errors.push(format!("分片 {generation}/{index}：{error}"));
                    }
                }
                Err(error) => {
                    failed_slots.insert((generation.to_string(), index));
                    errors.push(format!("分片 {generation}/{index}：{error}"));
                }
            }
        }
    }

    let referenced_chunk_failed =
        manifest_references_failed_chunk(backup.root.as_deref(), &failed_slots);
    if referenced_chunk_failed {
        errors.push(
            "原凭据清单引用的分片未能全部恢复；为避免提交已知损坏的清单，根凭据保持未安装状态。"
                .to_string(),
        );
    }

    // Commit a valid root manifest last and only after every referenced chunk
    // is restored. Legacy/opaque roots are independent of the chunk slots and
    // are restored byte-for-byte even when an unrelated orphan slot failed.
    match credential_entry(metadata) {
        Ok(entry) => {
            let root = (!referenced_chunk_failed)
                .then_some(backup.root.as_deref())
                .flatten();
            if let Err(error) = restore_raw_entry(&entry, root) {
                errors.push(format!("根凭据：{error}"));
            }
        }
        Err(error) => errors.push(format!("根凭据：{error}")),
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("无法完整恢复系统凭据库：{}", errors.join("；")))
    }
}

fn manifest_references_failed_chunk(
    root: Option<&[u8]>,
    failed_slots: &HashSet<(String, usize)>,
) -> bool {
    root.and_then(|root| serde_json::from_slice::<SecretManifest>(root).ok())
        .filter(|manifest| {
            manifest.version == SECRET_MANIFEST_VERSION
                && matches!(manifest.generation.as_str(), "a" | "b")
                && manifest.chunks > 0
                && manifest.chunks <= MAX_SECRET_CHUNKS
        })
        .is_some_and(|manifest| {
            (0..manifest.chunks)
                .any(|index| failed_slots.contains(&(manifest.generation.clone(), index)))
        })
}

fn restore_raw_entry(entry: &keyring::Entry, value: Option<&[u8]>) -> Result<(), String> {
    if let Some(value) = value {
        set_secret_with_retry(entry, value)
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn save_new_credential(
    metadata: &OAuthAccountMetadata,
    credential: &OAuthCredential,
) -> Result<(), String> {
    persist_refresh_secret(metadata, &credential.refresh)?;
    CREDENTIAL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "OAuth 凭据缓存锁已损坏。".to_string())?
        .insert(metadata.id.clone(), credential.clone());
    set_persistence_pending(metadata, false)
}

fn save_refreshed_credential(
    metadata: &OAuthAccountMetadata,
    credential: &OAuthCredential,
) -> Result<(), String> {
    CREDENTIAL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "OAuth 凭据缓存锁已损坏。".to_string())?
        .insert(metadata.id.clone(), credential.clone());
    if let Err(error) = persist_refresh_secret(metadata, &credential.refresh) {
        set_persistence_pending(metadata, true)?;
        return Err(format!(
            "OAuth 已刷新，但旋转后的凭据无法写入系统凭据库；当前进程暂时保留新凭据：{error}"
        ));
    }
    set_persistence_pending(metadata, false)
}

fn load_secret(metadata: &OAuthAccountMetadata) -> Result<PersistedOAuthSecret, String> {
    let root = Zeroizing::new(credential_entry(metadata)?.get_secret().map_err(
        |error| match error {
            keyring::Error::NoEntry => "系统凭据库中没有此 OAuth 账号。".to_string(),
            other => format!("无法读取系统凭据库：{other}"),
        },
    )?);
    let secret = if let Ok(manifest) = serde_json::from_slice::<SecretManifest>(&root) {
        if manifest.version != SECRET_MANIFEST_VERSION
            || !matches!(manifest.generation.as_str(), "a" | "b")
            || manifest.chunks == 0
            || manifest.chunks > MAX_SECRET_CHUNKS
        {
            return Err("OAuth 凭据清单版本或分片数量无效。".to_string());
        }
        let mut refresh = Vec::with_capacity(manifest.chunks * SECRET_CHUNK_BYTES);
        for index in 0..manifest.chunks {
            let mut chunk = credential_chunk_entry(metadata, &manifest.generation, index)?
                .get_secret()
                .map_err(|error| format!("OAuth 凭据分片 {index} 无法读取：{error}"))?;
            refresh.append(&mut chunk);
        }
        if refresh.len() != manifest.total_len || sha256_hex(&refresh) != manifest.sha256 {
            refresh.zeroize();
            return Err("OAuth 凭据分片完整性校验失败。".to_string());
        }
        let refresh = match String::from_utf8(refresh) {
            Ok(refresh) => refresh,
            Err(error) => {
                let mut bytes = error.into_bytes();
                bytes.zeroize();
                return Err("OAuth 刷新凭据不是有效 UTF-8。".to_string());
            }
        };
        PersistedOAuthSecret {
            refresh,
            account_id: account_id_from_metadata(metadata),
            access: None,
            expires_at: None,
        }
    } else {
        // One-time compatibility with an early development build that stored a
        // complete credential JSON in the root entry.
        parse_legacy_secret(&root)?
    };
    if secret.refresh.trim().is_empty() {
        return Err("OAuth 刷新凭据为空。".to_string());
    }
    Ok(secret)
}

#[allow(unknown_lints, clippy::chunks_exact_to_as_chunks)]
fn parse_legacy_secret(bytes: &[u8]) -> Result<PersistedOAuthSecret, String> {
    if let Ok(secret) = serde_json::from_slice(bytes) {
        return Ok(secret);
    }
    if !bytes.len().is_multiple_of(2) {
        return Err("OAuth 凭据已损坏。".to_string());
    }
    let mut utf16 = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    let mut decoded = String::from_utf16(&utf16).map_err(|_| "OAuth 凭据已损坏。".to_string())?;
    utf16.zeroize();
    let parsed = serde_json::from_str(&decoded).map_err(|_| "OAuth 凭据已损坏。".to_string());
    decoded.zeroize();
    parsed
}

fn persist_refresh_secret(metadata: &OAuthAccountMetadata, refresh: &str) -> Result<(), String> {
    if refresh.is_empty() {
        return Err("OAuth 刷新凭据为空。".to_string());
    }
    let chunks = refresh
        .as_bytes()
        .chunks(SECRET_CHUNK_BYTES)
        .collect::<Vec<_>>();
    if chunks.len() > MAX_SECRET_CHUNKS {
        return Err(format!(
            "OAuth 刷新凭据超过安全存储上限（最多 {} bytes）。",
            SECRET_CHUNK_BYTES * MAX_SECRET_CHUNKS
        ));
    }

    let previous_manifest = existing_manifest(metadata)?;
    let generation = if previous_manifest
        .as_ref()
        .is_some_and(|value| value.generation == "a")
    {
        "b"
    } else {
        "a"
    };
    cleanup_slot(metadata, generation)?;
    let mut written = 0usize;
    for (index, chunk) in chunks.iter().enumerate() {
        let entry = credential_chunk_entry(metadata, generation, index)?;
        if let Err(error) = set_secret_with_retry(&entry, chunk) {
            cleanup_written_chunks(metadata, generation, written);
            return Err(format!("无法写入系统凭据库分片 {index}：{error}"));
        }
        written += 1;
    }

    let manifest = serde_json::to_vec(&SecretManifest {
        version: SECRET_MANIFEST_VERSION,
        generation: generation.to_string(),
        chunks: chunks.len(),
        total_len: refresh.len(),
        sha256: sha256_hex(refresh.as_bytes()),
    })
    .map_err(|error| format!("无法序列化 OAuth 凭据清单：{error}"))?;
    if manifest.len() > SECRET_CHUNK_BYTES {
        cleanup_written_chunks(metadata, generation, written);
        return Err("OAuth 凭据清单超过安全存储上限。".to_string());
    }
    if let Err(error) = set_secret_with_retry(&credential_entry(metadata)?, &manifest) {
        cleanup_written_chunks(metadata, generation, written);
        return Err(format!("无法提交 OAuth 凭据清单：{error}"));
    }
    if let Some(previous) = previous_manifest {
        let _ = cleanup_slot(metadata, &previous.generation);
    }
    Ok(())
}

fn existing_manifest(metadata: &OAuthAccountMetadata) -> Result<Option<SecretManifest>, String> {
    let root = match credential_entry(metadata)?.get_secret() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("无法读取现有 OAuth 凭据清单：{error}")),
    };
    if let Ok(manifest) = serde_json::from_slice::<SecretManifest>(&root) {
        if manifest.version != SECRET_MANIFEST_VERSION
            || !matches!(manifest.generation.as_str(), "a" | "b")
            || manifest.chunks == 0
            || manifest.chunks > MAX_SECRET_CHUNKS
        {
            return Err("现有 OAuth 凭据清单无效，已拒绝覆盖。".to_string());
        }
        return Ok(Some(manifest));
    }
    parse_legacy_secret(&root)
        .map(|_| None)
        .map_err(|_| "现有 OAuth 凭据损坏，已拒绝覆盖。".to_string())
}

fn delete_persisted_secret(metadata: &OAuthAccountMetadata) -> Result<(), String> {
    let entry = credential_entry(metadata)?;
    // Delete both deterministic slots first. Keeping the manifest until every
    // chunk is gone ensures a failed removal remains discoverable/retryable.
    cleanup_slot(metadata, "a")?;
    cleanup_slot(metadata, "b")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(format!("无法从系统凭据库删除 OAuth 账号：{error}")),
    }
    Ok(())
}

fn set_secret_with_retry(entry: &keyring::Entry, secret: &[u8]) -> Result<(), String> {
    match entry.set_secret(secret) {
        Ok(()) => Ok(()),
        Err(first) => entry
            .set_secret(secret)
            .map_err(|second| format!("{first}; 重试失败：{second}")),
    }
}

fn cleanup_written_chunks(metadata: &OAuthAccountMetadata, generation: &str, chunks: usize) {
    for index in 0..chunks.min(MAX_SECRET_CHUNKS) {
        if let Ok(entry) = credential_chunk_entry(metadata, generation, index) {
            let _ = entry.delete_credential();
        }
    }
}

fn cleanup_slot(metadata: &OAuthAccountMetadata, generation: &str) -> Result<(), String> {
    for index in 0..MAX_SECRET_CHUNKS {
        let entry = credential_chunk_entry(metadata, generation, index)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(format!(
                    "无法清理系统凭据库分片 {generation}/{index}：{error}"
                ))
            }
        }
    }
    Ok(())
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cached_credential(metadata: &OAuthAccountMetadata) -> Result<Option<OAuthCredential>, String> {
    Ok(CREDENTIAL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "OAuth 凭据缓存锁已损坏。".to_string())?
        .get(&metadata.id)
        .cloned())
}

fn account_lock(metadata: &OAuthAccountMetadata) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = REFRESH_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "OAuth 账号锁目录已损坏。".to_string())?;
    Ok(locks
        .entry(metadata.id.clone())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn persistence_pending(metadata: &OAuthAccountMetadata) -> Result<bool, String> {
    Ok(PERSISTENCE_PENDING
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| "OAuth 持久化状态锁已损坏。".to_string())?
        .contains(&metadata.id))
}

fn set_persistence_pending(metadata: &OAuthAccountMetadata, pending: bool) -> Result<(), String> {
    let mut entries = PERSISTENCE_PENDING
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| "OAuth 持久化状态锁已损坏。".to_string())?;
    if pending {
        entries.insert(metadata.id.clone());
    } else {
        entries.remove(&metadata.id);
    }
    Ok(())
}

fn account_id_from_metadata(metadata: &OAuthAccountMetadata) -> Option<String> {
    (metadata.provider == AiProviderId::OpenaiCodex)
        .then(|| {
            metadata
                .id
                .strip_prefix("oauth:openai-codex:")
                .unwrap_or_default()
                .trim()
                .to_string()
        })
        .filter(|value| !value.is_empty())
}

fn verify_account_binding(
    metadata: &OAuthAccountMetadata,
    credential: &OAuthCredential,
) -> Result<(), String> {
    if metadata.provider != AiProviderId::OpenaiCodex {
        return Ok(());
    }
    let expected = account_id_from_metadata(metadata)
        .ok_or_else(|| "Codex OAuth 账号元数据缺少 account id。".to_string())?;
    if credential.account_id.as_deref() != Some(expected.as_str()) {
        return Err("Codex OAuth 刷新返回了不同的 ChatGPT account id，已拒绝绑定。".to_string());
    }
    Ok(())
}

fn credential_entry(metadata: &OAuthAccountMetadata) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, &metadata.id)
        .map_err(|error| format!("系统凭据库不可用：{error}"))
}

fn credential_chunk_entry(
    metadata: &OAuthAccountMetadata,
    generation: &str,
    index: usize,
) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        CREDENTIAL_SERVICE,
        &format!("{}:refresh:{generation}:{index}", metadata.id),
    )
    .map_err(|error| format!("系统凭据库不可用：{error}"))
}

fn refresh(provider: AiProviderId, current: &OAuthCredential) -> Result<OAuthCredential, String> {
    let config = OAuthConfig::for_provider(provider);
    let client_id = config.client_id()?;
    let response = match provider {
        AiProviderId::Anthropic => oauth_agent()
            .post(config.token_url)
            .set("accept", "application/json")
            .set("content-type", "application/json")
            .send_json(json!({
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": current.refresh,
            })),
        AiProviderId::OpenaiCodex => oauth_agent()
            .post(config.token_url)
            .set("accept", "application/json")
            .send_form(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id.as_str()),
                ("refresh_token", current.refresh.as_str()),
            ]),
        AiProviderId::Workbuddy | AiProviderId::Traecode => {
            unreachable!("non-OAuth provider passed to OAuth refresh")
        }
    }
    .map_err(|error| describe_oauth_request("刷新", error))?;
    parse_token_response(provider, response, Some(current))
}

fn exchange_code(
    provider: AiProviderId,
    config: OAuthConfig,
    code: &str,
    verifier: &str,
    state: &str,
) -> Result<OAuthCredential, String> {
    let client_id = config.client_id()?;
    let response = match provider {
        AiProviderId::Anthropic => oauth_agent()
            .post(config.token_url)
            .set("accept", "application/json")
            .set("content-type", "application/json")
            .send_json(json!({
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "state": state,
                "redirect_uri": config.redirect_uri,
                "code_verifier": verifier,
            })),
        AiProviderId::OpenaiCodex => oauth_agent()
            .post(config.token_url)
            .set("accept", "application/json")
            .send_form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id.as_str()),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", config.redirect_uri),
            ]),
        AiProviderId::Workbuddy | AiProviderId::Traecode => {
            unreachable!("non-OAuth provider passed to OAuth exchange")
        }
    }
    .map_err(|error| describe_oauth_request("交换", error))?;
    parse_token_response(provider, response, None)
}

fn parse_token_response(
    provider: AiProviderId,
    response: ureq::Response,
    previous: Option<&OAuthCredential>,
) -> Result<OAuthCredential, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((TOKEN_RESPONSE_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 OAuth 令牌响应：{error}"))?;
    if bytes.len() > TOKEN_RESPONSE_LIMIT {
        bytes.zeroize();
        return Err("OAuth 令牌响应超过 128 KiB 安全上限。".to_string());
    }
    let payload =
        serde_json::from_slice(&bytes).map_err(|_| "OAuth 令牌响应不是有效 JSON。".to_string());
    bytes.zeroize();
    let mut payload: Value = payload?;
    let mut access = Zeroizing::new(take_json_string(&mut payload, "access_token"));
    let mut refresh = Zeroizing::new(take_json_string(&mut payload, "refresh_token"));
    if refresh.is_empty() {
        *refresh = previous
            .map(|value| value.refresh.clone())
            .unwrap_or_default();
    }
    zeroize_json_string(&mut payload, "id_token");
    let expires_in = payload
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    if access.is_empty()
        || refresh.is_empty()
        || refresh.len() > SECRET_CHUNK_BYTES * MAX_SECRET_CHUNKS
        || expires_in <= 0
        || expires_in > MAX_TOKEN_LIFETIME_SECONDS
    {
        return Err("OAuth 服务没有返回完整的可刷新凭据。".to_string());
    }
    let account_id = if provider == AiProviderId::OpenaiCodex {
        jwt_account_id(&access).or_else(|| previous.and_then(|value| value.account_id.clone()))
    } else {
        previous.and_then(|value| value.account_id.clone())
    };
    if provider == AiProviderId::OpenaiCodex && account_id.is_none() {
        return Err("Codex OAuth 令牌缺少 ChatGPT account id。".to_string());
    }
    Ok(OAuthCredential {
        access: std::mem::take(&mut *access),
        refresh: std::mem::take(&mut *refresh),
        expires_at: now_ms()
            .saturating_add(expires_in.saturating_mul(1_000))
            .saturating_sub(5 * 60_000),
        account_id,
    })
}

fn take_json_string(payload: &mut Value, key: &str) -> String {
    let Some(Value::String(mut value)) = payload.as_object_mut().and_then(|map| map.remove(key))
    else {
        return String::new();
    };
    let trimmed = value.trim().to_string();
    value.zeroize();
    trimmed
}

fn zeroize_json_string(payload: &mut Value, key: &str) {
    if let Some(Value::String(mut value)) = payload.as_object_mut().and_then(|map| map.remove(key))
    {
        value.zeroize();
    }
}

fn build_authorize_url(
    provider: AiProviderId,
    config: OAuthConfig,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url =
        Url::parse(config.authorize_url).map_err(|error| format!("OAuth 授权地址无效：{error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &config.client_id()?)
            .append_pair("redirect_uri", config.redirect_uri)
            .append_pair("scope", config.scope)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state);
        match provider {
            AiProviderId::Anthropic => {
                query.append_pair("code", "true");
            }
            AiProviderId::OpenaiCodex => {
                query
                    .append_pair("id_token_add_organizations", "true")
                    .append_pair("codex_cli_simplified_flow", "true")
                    .append_pair("originator", "pi");
            }
            AiProviderId::Workbuddy | AiProviderId::Traecode => {
                unreachable!("non-OAuth provider passed to OAuth URL builder")
            }
        }
    }
    Ok(url.into())
}

fn wait_for_callback(
    listener: &TcpListener,
    config: OAuthConfig,
    expected_state: &str,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err("浏览器 OAuth 授权已超时。".to_string());
        }
        match listener.accept() {
            Ok((stream, _)) => match read_callback(
                stream,
                config,
                expected_state,
                deadline.saturating_duration_since(Instant::now()),
            ) {
                Ok(CallbackOutcome::Code(code)) => return Ok(code),
                Ok(CallbackOutcome::ProviderError) => {
                    return Err("OAuth 提供方拒绝或取消了授权。".to_string())
                }
                Ok(CallbackOutcome::Ignore) | Err(_) => {}
            },
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(error) => return Err(format!("OAuth 回调监听失败：{error}")),
        }
    }
}

fn read_callback(
    mut stream: TcpStream,
    config: OAuthConfig,
    expected_state: &str,
    remaining: Duration,
) -> Result<CallbackOutcome, String> {
    stream
        .set_read_timeout(Some(remaining.min(Duration::from_secs(3))))
        .map_err(|error| error.to_string())?;
    let mut request = Vec::new();
    let mut chunk = [0_u8; 2048];
    while request.len() < REQUEST_LIMIT {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("无法读取 OAuth 回调：{error}"))?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|value| value == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&request);
    let target = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let parsed = parse_callback_target(target, config, expected_state);
    let ok = matches!(&parsed, CallbackOutcome::Code(_));
    let page = callback_page(ok);
    let status = match &parsed {
        CallbackOutcome::Code(_) => "200 OK",
        CallbackOutcome::ProviderError => "400 Bad Request",
        CallbackOutcome::Ignore => "404 Not Found",
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(response.as_bytes());
    Ok(parsed)
}

fn parse_callback_target(
    target: &str,
    config: OAuthConfig,
    expected_state: &str,
) -> CallbackOutcome {
    let Ok(url) = Url::parse(&format!("http://localhost{target}")) else {
        return CallbackOutcome::Ignore;
    };
    if url.path() != config.callback_path {
        return CallbackOutcome::Ignore;
    }
    let params = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    if params.get("state").map(|value| value.as_ref()) != Some(expected_state) {
        return CallbackOutcome::Ignore;
    }
    if params.contains_key("error") {
        return CallbackOutcome::ProviderError;
    }
    params
        .get("code")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(CallbackOutcome::Code)
        .unwrap_or(CallbackOutcome::Ignore)
}

fn callback_page(ok: bool) -> String {
    let (title, body) = if ok {
        (
            "已收到授权回调",
            "SynthV Toolbox 正在完成令牌交换和安全保存；请返回应用等待最终结果。",
        )
    } else {
        (
            "授权失败",
            "授权没有完成，请返回 SynthV Toolbox 查看详细原因。",
        )
    };
    format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f6f8;color:#17202a}}main{{max-width:520px;padding:32px;border:1px solid #d8dde5;border-radius:12px;background:white}}h1{{font-size:22px}}</style><main><h1>{title}</h1><p>{body}</p></main></html>"
    )
}

fn pkce_verifier() -> String {
    format!(
        "{}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn random_url_token() -> String {
    URL_SAFE_NO_PAD.encode(format!("{}{}", Uuid::new_v4(), Uuid::new_v4()))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn jwt_account_id(access: &str) -> Option<String> {
    let payload = access.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    claims
        .get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn oauth_agent() -> &'static ureq::Agent {
    OAUTH_AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout(TOKEN_REQUEST_TIMEOUT)
            .redirects(0)
            .https_only(true)
            .build()
    })
}

fn codex_models_agent() -> &'static ureq::Agent {
    CODEX_MODELS_AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout(CODEX_MODELS_TIMEOUT)
            .redirects(0)
            .https_only(true)
            .build()
    })
}

fn describe_oauth_request(action: &str, error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, _) => format!("OAuth 令牌{action}失败（HTTP {code}）。"),
        ureq::Error::Transport(error) => format!("OAuth 令牌{action}请求失败：{error}"),
    }
}

pub fn open_external(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开系统浏览器：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_uses_url_safe_sha256() {
        let verifier = pkce_verifier();
        let challenge = pkce_challenge(&verifier);
        assert!((43..=128).contains(&verifier.len()));
        assert!(!challenge.contains(['+', '/', '=']));
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
    }

    #[test]
    fn callback_requires_exact_path_and_state() {
        let config = OAuthConfig::for_provider(AiProviderId::OpenaiCodex);
        assert_eq!(
            parse_callback_target("/auth/callback?code=ok&state=expected", config, "expected"),
            CallbackOutcome::Code("ok".to_string())
        );
        assert_eq!(
            parse_callback_target("/auth/callback?code=ok&state=wrong", config, "expected"),
            CallbackOutcome::Ignore
        );
        assert_eq!(
            parse_callback_target("/other?code=ok&state=expected", config, "expected"),
            CallbackOutcome::Ignore
        );
        assert_eq!(
            parse_callback_target(
                "/auth/callback?error=access_denied&state=expected",
                config,
                "expected"
            ),
            CallbackOutcome::ProviderError
        );
    }

    #[test]
    fn authorize_url_contains_pkce_and_provider_flags() {
        let config = OAuthConfig::for_provider(AiProviderId::OpenaiCodex);
        let value =
            build_authorize_url(AiProviderId::OpenaiCodex, config, "challenge", "state").unwrap();
        let url = Url::parse(&value).unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            query.get("code_challenge").map(|value| value.as_ref()),
            Some("challenge")
        );
        assert_eq!(
            query.get("state").map(|value| value.as_ref()),
            Some("state")
        );
        assert_eq!(
            query.get("originator").map(|value| value.as_ref()),
            Some("pi")
        );
    }

    #[test]
    fn legacy_utf16_secret_is_migratable() {
        let json = serde_json::json!({
            "refresh": "legacy-refresh",
            "accountId": "account-123",
            "access": "legacy-access",
            "expiresAt": 42
        })
        .to_string();
        let utf16le = json
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        let secret = parse_legacy_secret(&utf16le).unwrap();
        assert_eq!(secret.refresh, "legacy-refresh");
        assert_eq!(secret.account_id.as_deref(), Some("account-123"));
        assert_eq!(secret.access.as_deref(), Some("legacy-access"));
        assert_eq!(secret.expires_at, Some(42));
    }

    #[test]
    fn credential_debug_output_redacts_tokens() {
        let credential = OAuthCredential {
            access: "access-secret-value".to_string(),
            refresh: "refresh-secret-value".to_string(),
            expires_at: 42,
            account_id: Some("account-123".to_string()),
        };

        let output = format!("{credential:?}");
        assert!(!output.contains("access-secret-value"));
        assert!(!output.contains("refresh-secret-value"));
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn codex_catalog_parser_keeps_hidden_but_rejects_unavailable_models() {
        let models = parse_codex_models_payload(&serde_json::json!({
            "models": [
                { "slug": "gpt-5.3-codex-spark", "visibility": "hide" },
                { "id": "gpt-5.6-terra", "visibility": "list" },
                { "slug": "unavailable", "visibility": "none" },
                { "slug": "../../invalid", "visibility": "list" }
            ]
        }))
        .unwrap();

        assert!(models.contains("gpt-5.3-codex-spark"));
        assert!(models.contains("gpt-5.6-terra"));
        assert!(!models.contains("unavailable"));
        assert!(!models.contains("../../invalid"));
    }

    #[test]
    fn credential_rollback_never_commits_a_manifest_with_missing_chunks() {
        let root = serde_json::to_vec(&SecretManifest {
            version: SECRET_MANIFEST_VERSION,
            generation: "b".to_string(),
            chunks: 2,
            total_len: 10,
            sha256: "digest".to_string(),
        })
        .unwrap();
        let mut failed = HashSet::new();
        failed.insert(("a".to_string(), 0));
        assert!(!manifest_references_failed_chunk(Some(&root), &failed));

        failed.insert(("b".to_string(), 1));
        assert!(manifest_references_failed_chunk(Some(&root), &failed));
    }
}
