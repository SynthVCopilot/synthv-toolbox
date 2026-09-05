//! WorkBuddy runtime adapter for the product-verified OAuth flow.
//!
//! This module does not persist credentials or require a client secret. The
//! caller requests an auth state, opens the returned URL, and supplies the
//! state while this adapter performs bounded token polling and refresh.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use zeroize::Zeroize;

use super::{AgentError, Result};

const DEFAULT_POLL_ATTEMPTS: u32 = 400;
const DEFAULT_POLL_INTERVAL_MS: u64 = 1_500;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const PENDING_CODE: i64 = 11217;

fn default_poll_attempts() -> u32 {
    DEFAULT_POLL_ATTEMPTS
}
fn default_poll_interval_ms() -> u64 {
    DEFAULT_POLL_INTERVAL_MS
}
fn default_timeout_secs() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

pub const WORKBUDDY_API_BASE: &str = "https://copilot.tencent.com/v2/plugin";
pub const WORKBUDDY_CHAT_BASE: &str = "https://copilot.tencent.com/v2";
pub const WORKBUDDY_ORIGIN: &str = "https://www.codebuddy.cn";
pub const WORKBUDDY_MODELS: &[&str] = &[
    "glm-5.2",
    "glm-5.1",
    "glm-5v-turbo",
    "kimi-k2.7",
    "minimax-m3-pay",
    "hy3",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkBuddyOAuthConfig {
    pub api_base: String,
    pub chat_base: String,
    pub origin: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default = "default_poll_attempts")]
    pub max_poll_attempts: u32,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

impl WorkBuddyOAuthConfig {
    pub fn builtin() -> Self {
        Self {
            api_base: WORKBUDDY_API_BASE.to_string(),
            chat_base: WORKBUDDY_CHAT_BASE.to_string(),
            origin: WORKBUDDY_ORIGIN.to_string(),
            models: WORKBUDDY_MODELS
                .iter()
                .map(|model| (*model).to_string())
                .collect(),
            platform: default_platform(),
            max_poll_attempts: default_poll_attempts(),
            poll_interval_ms: default_poll_interval_ms(),
            timeout_secs: default_timeout_secs(),
        }
    }
}

fn default_platform() -> String {
    "workbuddy".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkBuddyAuthState {
    pub state: String,
    #[serde(alias = "authUrl")]
    pub auth_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkBuddyPollState {
    Pending,
    Authorized,
}

#[derive(Serialize, Deserialize)]
pub struct WorkBuddyCredential {
    #[serde(alias = "accessToken")]
    pub access: String,
    #[serde(alias = "refreshToken")]
    pub refresh: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(rename = "userId", alias = "uid", default)]
    pub user_id: Option<String>,
    #[serde(rename = "enterpriseId", default)]
    pub enterprise_id: Option<String>,
}

impl fmt::Debug for WorkBuddyCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkBuddyCredential")
            .field("access", &"[redacted]")
            .field("refresh", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("domain", &"[redacted]")
            .field("user_id", &"[redacted]")
            .field("enterprise_id", &"[redacted]")
            .finish()
    }
}

impl Drop for WorkBuddyCredential {
    fn drop(&mut self) {
        self.access.zeroize();
        self.refresh.zeroize();
        if let Some(value) = &mut self.domain {
            value.zeroize();
        }
        if let Some(value) = &mut self.user_id {
            value.zeroize();
        }
        if let Some(value) = &mut self.enterprise_id {
            value.zeroize();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkBuddyAccountInfo {
    #[serde(alias = "uid")]
    pub user_id: String,
    #[serde(alias = "nickname")]
    pub display_name: String,
    pub email: Option<String>,
    #[serde(rename = "enterpriseId", default)]
    pub enterprise_id: Option<String>,
}

pub struct WorkBuddyOAuth {
    config: WorkBuddyOAuthConfig,
    agent: ureq::Agent,
}

impl WorkBuddyOAuth {
    pub fn new(config: WorkBuddyOAuthConfig) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(config.timeout_secs))
            .build();
        Self { config, agent }
    }

    pub fn config(&self) -> &WorkBuddyOAuthConfig {
        &self.config
    }
    pub fn chat_base(&self) -> &str {
        &self.config.chat_base
    }

    pub fn chat_endpoint(&self) -> Result<Url> {
        endpoint(&self.config.chat_base, "/chat/completions")
    }

    pub fn models(&self) -> &[String] {
        &self.config.models
    }

    pub fn chat_headers(&self, credential: &WorkBuddyCredential) -> Result<Vec<(String, String)>> {
        if credential.access.trim().is_empty() {
            return Err(AgentError::new("WorkBuddy access token is empty"));
        }
        let mut headers = vec![
            (
                "authorization".to_string(),
                format!("Bearer {}", credential.access),
            ),
            ("origin".to_string(), self.config.origin.clone()),
            (
                "accept".to_string(),
                "application/json, text/plain, */*".to_string(),
            ),
            ("content-type".to_string(), "application/json".to_string()),
            ("x-requested-with".to_string(), "XMLHttpRequest".to_string()),
            (
                "referer".to_string(),
                format!("{}/", self.config.origin.trim_end_matches('/')),
            ),
            (
                "user-agent".to_string(),
                "CLI/2.63.2 CodeBuddy/2.63.2".to_string(),
            ),
            ("x-product".to_string(), "SaaS".to_string()),
            ("x-refresh-token".to_string(), credential.refresh.clone()),
        ];
        if let Some(domain) = credential
            .domain
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            headers.push(("x-domain".to_string(), domain.to_string()));
        }
        if let Some(enterprise) = credential
            .enterprise_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            headers.push(("x-enterprise-id".to_string(), enterprise.to_string()));
        }
        if let Some(user_id) = credential
            .user_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            headers.push(("x-user-id".to_string(), user_id.to_string()));
        }
        Ok(headers)
    }

    pub fn request_auth_state(&self) -> Result<WorkBuddyAuthState> {
        let mut url = endpoint(&self.config.api_base, "/auth/state")?;
        url.query_pairs_mut()
            .append_pair("platform", &self.config.platform);
        let response = self
            .agent
            .post(url.as_str())
            .set("accept", "application/json, text/plain, */*")
            .set("content-type", "application/json")
            .set("x-requested-with", "XMLHttpRequest")
            .set("origin", &self.config.origin)
            .set(
                "referer",
                &format!("{}/", self.config.origin.trim_end_matches('/')),
            )
            .set("user-agent", "CLI/2.63.2 CodeBuddy/2.63.2")
            .set("x-product", "SaaS")
            .send_string("{}");
        match response {
            Ok(response) => {
                parse_auth_state(&response.into_string().map_err(|e| {
                    AgentError::new(format!("read WorkBuddy auth state failed: {e}"))
                })?)
            }
            Err(ureq::Error::Status(code, response)) => {
                Err(http_error(code, response.into_string().unwrap_or_default()))
            }
            Err(error) => Err(AgentError::transport(format!(
                "WorkBuddy auth state transport failed: {error}"
            ))),
        }
    }

    pub fn poll_credential(&self, state: &str) -> Result<WorkBuddyCredential> {
        self.poll_credential_cancellable(state, None)
    }

    pub fn poll_credential_cancellable(
        &self,
        state: &str,
        cancelled: Option<&AtomicBool>,
    ) -> Result<WorkBuddyCredential> {
        if state.trim().is_empty() {
            return Err(AgentError::new("WorkBuddy OAuth state is empty"));
        }
        let attempts = self.config.max_poll_attempts.clamp(1, 400);
        for attempt in 0..attempts {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(AgentError::new("WorkBuddy OAuth 已取消"));
            }
            match self.poll_once(state)? {
                (WorkBuddyPollState::Authorized, Some(credential)) => return Ok(credential),
                (WorkBuddyPollState::Pending, _) if attempt + 1 < attempts => {
                    thread_sleep(self.config.poll_interval_ms)
                }
                (WorkBuddyPollState::Pending, _) => {}
                (WorkBuddyPollState::Authorized, None) => {
                    return Err(AgentError::new(
                        "WorkBuddy token response was missing credentials",
                    ))
                }
            }
        }
        Err(AgentError::new(
            "WorkBuddy OAuth credential polling timed out",
        ))
    }

    pub fn account_info(
        &self,
        state: &str,
        credential: &WorkBuddyCredential,
    ) -> Result<WorkBuddyAccountInfo> {
        let mut url = endpoint(&self.config.api_base, "/login/account")?;
        url.query_pairs_mut().append_pair("state", state);
        let mut request = self
            .agent
            .get(url.as_str())
            .set("authorization", &format!("Bearer {}", credential.access))
            .set("accept", "application/json, text/plain, */*")
            .set("content-type", "application/json")
            .set("x-requested-with", "XMLHttpRequest")
            .set("origin", &self.config.origin)
            .set(
                "referer",
                &format!("{}/", self.config.origin.trim_end_matches('/')),
            )
            .set("user-agent", "CLI/2.63.2 CodeBuddy/2.63.2")
            .set("x-product", "SaaS");
        if let Some(domain) = credential
            .domain
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.set("x-domain", domain);
        }
        if let Some(enterprise) = credential
            .enterprise_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.set("x-enterprise-id", enterprise);
        }
        let response = request.call();
        match response {
            Ok(response) => parse_account(
                &response
                    .into_string()
                    .map_err(|e| AgentError::new(format!("read WorkBuddy account failed: {e}")))?,
            ),
            Err(ureq::Error::Status(code, response)) => {
                Err(http_error(code, response.into_string().unwrap_or_default()))
            }
            Err(error) => Err(AgentError::transport(format!(
                "WorkBuddy account transport failed: {error}"
            ))),
        }
    }

    pub fn refresh_credential(
        &self,
        credential: &WorkBuddyCredential,
    ) -> Result<WorkBuddyCredential> {
        if credential.refresh.trim().is_empty() {
            return Err(AgentError::new(
                "WorkBuddy credential is missing access or refresh token",
            ));
        }
        let url = endpoint(&self.config.api_base, "/auth/token/refresh")?;
        let mut request = self
            .agent
            .post(url.as_str())
            .set("accept", "application/json, text/plain, */*")
            .set("content-type", "application/json")
            .set("x-requested-with", "XMLHttpRequest")
            .set("origin", &self.config.origin)
            .set(
                "referer",
                &format!("{}/", self.config.origin.trim_end_matches('/')),
            )
            .set("user-agent", "CLI/2.63.2 CodeBuddy/2.63.2")
            .set("x-product", "SaaS")
            .set("x-refresh-token", &credential.refresh)
            .set("x-auth-refresh-source", "workbuddy")
            .set("content-type", "application/json");
        if !credential.access.trim().is_empty() {
            request = request.set("authorization", &format!("Bearer {}", credential.access));
        }
        if let Some(domain) = credential
            .domain
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.set("x-domain", domain);
        }
        if let Some(enterprise) = credential
            .enterprise_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.set("x-enterprise-id", enterprise);
        }
        if let Some(user_id) = credential
            .user_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.set("x-user-id", user_id);
        }
        match request.send_string("{}") {
            Ok(response) => {
                let mut refreshed =
                    parse_credential_response(&response.into_string().map_err(|e| {
                        AgentError::new(format!("read WorkBuddy refresh failed: {e}"))
                    })?)?;
                if refreshed.domain.is_none() {
                    refreshed.domain = credential.domain.clone();
                }
                if refreshed.user_id.is_none() {
                    refreshed.user_id = credential.user_id.clone();
                }
                if refreshed.enterprise_id.is_none() {
                    refreshed.enterprise_id = credential.enterprise_id.clone();
                }
                Ok(refreshed)
            }
            Err(ureq::Error::Status(code, response)) => {
                Err(http_error(code, response.into_string().unwrap_or_default()))
            }
            Err(error) => Err(AgentError::transport(format!(
                "WorkBuddy refresh transport failed: {error}"
            ))),
        }
    }

    fn poll_once(&self, state: &str) -> Result<(WorkBuddyPollState, Option<WorkBuddyCredential>)> {
        let mut url = endpoint(&self.config.api_base, "/auth/token")?;
        url.query_pairs_mut().append_pair("state", state);
        let response = self
            .agent
            .get(url.as_str())
            .set("accept", "application/json, text/plain, */*")
            .set("content-type", "application/json")
            .set("x-requested-with", "XMLHttpRequest")
            .set("origin", &self.config.origin)
            .set(
                "referer",
                &format!("{}/", self.config.origin.trim_end_matches('/')),
            )
            .set("user-agent", "CLI/2.63.2 CodeBuddy/2.63.2")
            .set("x-product", "SaaS")
            .call();
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(code, response)) => {
                return Err(http_error(code, response.into_string().unwrap_or_default()))
            }
            Err(error) => {
                return Err(AgentError::transport(format!(
                    "WorkBuddy token transport failed: {error}"
                )))
            }
        };
        let body = response
            .into_string()
            .map_err(|e| AgentError::new(format!("read WorkBuddy token response failed: {e}")))?;
        let value: Value = serde_json::from_str(&body)?;
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code == PENDING_CODE {
            return Ok((WorkBuddyPollState::Pending, None));
        }
        if code != 0 {
            return Err(AgentError::new(format!(
                "WorkBuddy token failed with business code {code}"
            )));
        }
        Ok((
            WorkBuddyPollState::Authorized,
            Some(parse_credential_value(
                value.get("data").cloned().unwrap_or(value),
            )?),
        ))
    }
}

fn endpoint(base: &str, path: &str) -> Result<Url> {
    let mut url = Url::parse(base.trim_end_matches('/'))
        .map_err(|e| AgentError::new(format!("invalid WorkBuddy API base: {e}")))?;
    url.set_path(&format!("{}{}", url.path().trim_end_matches('/'), path));
    Ok(url)
}

fn parse_auth_state(body: &str) -> Result<WorkBuddyAuthState> {
    let value: Value = serde_json::from_str(body)?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value)).map_err(Into::into)
}
fn parse_credential_response(body: &str) -> Result<WorkBuddyCredential> {
    let value: Value = serde_json::from_str(body)?;
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code != 0 {
        return Err(AgentError::new(format!(
            "WorkBuddy refresh failed with business code {code}"
        )));
    }
    parse_credential_value(value.get("data").cloned().unwrap_or(value))
}
fn parse_credential_value(value: Value) -> Result<WorkBuddyCredential> {
    let mut value = value;
    let access = take_string(&mut value, &["accessToken", "access_token", "access"]);
    let refresh = take_string(&mut value, &["refreshToken", "refresh_token", "refresh"]);
    if access.is_empty() || refresh.is_empty() {
        return Err(AgentError::new(
            "WorkBuddy returned an incomplete renewable credential",
        ));
    }
    let expires_at = value
        .get("expiresAt")
        .or_else(|| value.get("expires_at"))
        .and_then(number_or_string)
        .unwrap_or_else(|| {
            value
                .get("expiresIn")
                .or_else(|| value.get("expires_in"))
                .and_then(number_or_string)
                .map(|seconds| {
                    now_ms()
                        .saturating_add(seconds.saturating_mul(1_000))
                        .saturating_sub(300_000)
                })
                .unwrap_or_default()
        });
    if expires_at <= now_ms() {
        return Err(AgentError::new(
            "WorkBuddy returned an invalid token expiry",
        ));
    }
    Ok(WorkBuddyCredential {
        access,
        refresh,
        expires_at,
        domain: value
            .get("domain")
            .and_then(Value::as_str)
            .map(str::to_string),
        user_id: value
            .get("userId")
            .or_else(|| value.get("uid"))
            .and_then(Value::as_str)
            .map(str::to_string),
        enterprise_id: value
            .get("enterpriseId")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn take_string(value: &mut Value, names: &[&str]) -> String {
    for name in names {
        if let Some(Value::String(mut value)) = value
            .as_object_mut()
            .and_then(|object| object.remove(*name))
        {
            let trimmed = value.trim().to_string();
            value.zeroize();
            return trimmed;
        }
    }
    String::new()
}

fn number_or_string(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.trim().parse().ok())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
fn parse_account(body: &str) -> Result<WorkBuddyAccountInfo> {
    let value: Value = serde_json::from_str(body)?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value)).map_err(Into::into)
}
fn http_error(code: u16, _body: String) -> AgentError {
    AgentError::http(code, format!("WorkBuddy HTTP {code}"))
}
fn thread_sleep(milliseconds: u64) {
    std::thread::sleep(Duration::from_millis(milliseconds.min(10_000)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_config_matches_verified_runtime_contract() {
        let config = WorkBuddyOAuthConfig::builtin();
        assert_eq!(config.api_base, WORKBUDDY_API_BASE);
        assert_eq!(config.chat_base, WORKBUDDY_CHAT_BASE);
        assert_eq!(config.origin, WORKBUDDY_ORIGIN);
        assert_eq!(config.max_poll_attempts, 400);
        assert!(config.models.iter().any(|model| model == "glm-5.2"));
    }

    #[test]
    fn credential_aliases_and_expiry_are_normalized_without_leaking_debug() {
        let credential = parse_credential_value(serde_json::json!({
            "access_token": "access-secret",
            "refresh_token": "refresh-secret",
            "expires_in": "3600",
            "domain": "tenant",
        }))
        .expect("valid credential");
        assert!(credential.expires_at > now_ms());
        assert!(!format!("{:?}", credential).contains("access-secret"));
        assert!(!format!("{:?}", credential).contains("refresh-secret"));
    }
}
