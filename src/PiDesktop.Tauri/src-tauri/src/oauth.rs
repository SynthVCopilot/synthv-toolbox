//! Browser OAuth for the supported official subscription runtimes.
//!
//! The renderer only receives non-secret account metadata. Renewable credentials
//! are stored in local encrypted files and are loaded/refreshed
//! only by the Rust backend immediately before a model request.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::Read;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const CREDENTIAL_SERVICE: &str = "com.synthvcopilot.toolbox.oauth";
const AUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CODEX_MODELS_RESPONSE_LIMIT: usize = 512 * 1024;
const CODEX_MODELS_TIMEOUT: Duration = Duration::from_secs(5);
const CODEX_MODELS_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const CODEX_MODELS_FAILURE_CACHE_TTL: Duration = Duration::from_secs(30);
const CODEX_MODELS_MAX_CONCURRENCY: usize = 4;
const REFRESH_EARLY_MS: i64 = 30_000;

const CODEX_MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";

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
            Self::Traecode => "",
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
            Self::Traecode => &[],
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
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_weight")]
    pub weight: u8,
}

fn default_true() -> bool {
    true
}
fn default_weight() -> u8 {
    1
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
    persisted: Option<Zeroizing<Vec<u8>>>,
    cached: Option<OAuthCredential>,
    pending: bool,
}

/// Only the renewable, compact secret is persisted in local encrypted storage.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedOAuthSecret {
    refresh: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
}

impl Drop for PersistedOAuthSecret {
    fn drop(&mut self) {
        self.refresh.zeroize();
        if let Some(account_id) = &mut self.account_id {
            account_id.zeroize();
        }
    }
}

static AUTHORIZING: OnceLock<Mutex<HashSet<AiProviderId>>> = OnceLock::new();
static CREDENTIAL_CACHE: OnceLock<Mutex<HashMap<String, OAuthCredential>>> = OnceLock::new();
static REFRESH_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
static PERSISTENCE_PENDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
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

pub fn authorize_cancellable(
    provider: AiProviderId,
    cancelled: Option<&AtomicBool>,
) -> Result<AuthorizedAccount, String> {
    if matches!(provider, AiProviderId::Workbuddy | AiProviderId::Traecode) {
        return Err(format!("{} 使用专用授权流程。", provider.display_name()));
    }
    let _guard = AuthorizationGuard::acquire(provider)?;
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err("浏览器 OAuth 授权已取消。".to_string());
    }
    let native_provider = match provider {
        AiProviderId::Anthropic => model_auth_native::Provider::Anthropic,
        AiProviderId::OpenaiCodex => model_auth_native::Provider::OpenAi,
        AiProviderId::Workbuddy | AiProviderId::Traecode => unreachable!(),
    };
    let credential = model_auth_native::authorize(
        native_provider,
        &model_auth_native::UreqTransport,
        |url| open_external(url).map_err(model_auth_native::Error::new),
        || cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)),
        AUTH_TIMEOUT,
    )
    .map_err(|error| error.to_string())?;
    let credential = OAuthCredential {
        access: credential.access.clone(),
        refresh: credential.refresh.clone(),
        expires_at: credential.expires_at,
        account_id: credential.account_id.clone(),
    };
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
        enabled: true,
        weight: 1,
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
    let mutation = save_new_credential(&account.metadata, &account.credential);
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
        access: String::new(),
        refresh: std::mem::take(&mut stored.refresh),
        expires_at: 0,
        account_id: stored.account_id.take(),
    };
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
    Ok(CredentialBackup {
        persisted: credential_store().read(CREDENTIAL_SERVICE, &metadata.id)?,
        cached: cached_credential(metadata)?,
        pending: persistence_pending(metadata)?,
    })
}

fn credential_store() -> crate::local_credential_store::Store {
    crate::local_credential_store::Store::new(crate::agent::data_root().join("credentials"))
}

fn restore_raw_credential(
    metadata: &OAuthAccountMetadata,
    backup: &Option<Zeroizing<Vec<u8>>>,
) -> Result<(), String> {
    match backup {
        Some(value) => credential_store().write(CREDENTIAL_SERVICE, &metadata.id, value),
        None => credential_store().delete(CREDENTIAL_SERVICE, &metadata.id),
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
            "OAuth 已刷新，但旋转后的凭据无法写入本地加密存储；当前进程暂时保留新凭据：{error}"
        ));
    }
    set_persistence_pending(metadata, false)
}

fn load_secret(metadata: &OAuthAccountMetadata) -> Result<PersistedOAuthSecret, String> {
    let bytes = credential_store()
        .read(CREDENTIAL_SERVICE, &metadata.id)?
        .ok_or_else(|| "本地加密存储中没有此 OAuth 账号。".to_string())?;
    let secret = serde_json::from_slice::<PersistedOAuthSecret>(&bytes)
        .map_err(|_| "本地 OAuth 凭据格式无效。".to_string())?;
    if secret.refresh.trim().is_empty() {
        return Err("OAuth 刷新凭据为空。".to_string());
    }
    Ok(secret)
}

fn persist_refresh_secret(metadata: &OAuthAccountMetadata, refresh: &str) -> Result<(), String> {
    if refresh.is_empty() {
        return Err("OAuth 刷新凭据为空。".to_string());
    }
    let bytes = Zeroizing::new(
        serde_json::to_vec(&PersistedOAuthSecret {
            refresh: refresh.to_string(),
            account_id: account_id_from_metadata(metadata),
        })
        .map_err(|error| format!("无法编码 OAuth 凭据：{error}"))?,
    );
    credential_store().write(CREDENTIAL_SERVICE, &metadata.id, &bytes)
}

fn delete_persisted_secret(metadata: &OAuthAccountMetadata) -> Result<(), String> {
    credential_store().delete(CREDENTIAL_SERVICE, &metadata.id)
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

fn refresh(provider: AiProviderId, current: &OAuthCredential) -> Result<OAuthCredential, String> {
    let native_provider = match provider {
        AiProviderId::Anthropic => model_auth_native::Provider::Anthropic,
        AiProviderId::OpenaiCodex => model_auth_native::Provider::OpenAi,
        AiProviderId::Workbuddy | AiProviderId::Traecode => unreachable!(),
    };
    let credential = model_auth_native::Credential {
        access: current.access.clone(),
        refresh: current.refresh.clone(),
        expires_at: current.expires_at,
        account_id: current.account_id.clone(),
    };
    let refreshed = model_auth_native::refresh(
        native_provider,
        &credential,
        &model_auth_native::UreqTransport,
    )
    .map_err(|error| error.to_string())?;
    Ok(OAuthCredential {
        access: refreshed.access.clone(),
        refresh: refreshed.refresh.clone(),
        expires_at: refreshed.expires_at,
        account_id: refreshed.account_id.clone(),
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
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

#[cfg(any())]
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
#[path = "../../../../test/oauth_local_storage.rs"]
mod local_storage_tests;
