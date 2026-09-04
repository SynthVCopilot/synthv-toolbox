//! WorkBuddy runtime adapter for the product-verified OAuth flow.
//!
//! This module does not persist credentials or require a client secret. The
//! caller requests an auth state, opens the returned URL, and supplies the
//! state while this adapter performs bounded token polling and refresh.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use zeroize::Zeroize;

use super::{AgentError, Result};

const DEFAULT_POLL_ATTEMPTS: u32 = 12;
const DEFAULT_POLL_INTERVAL_MS: u64 = 500;
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
    pub expires: Option<String>,
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
            .field("expires", &"[redacted]")
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
        if let Some(value) = &mut self.expires {
            value.zeroize();
        }
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
            ("content-type".to_string(), "application/json".to_string()),
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
        Ok(headers)
    }

    pub fn request_auth_state(&self) -> Result<WorkBuddyAuthState> {
        let mut url = endpoint(&self.config.api_base, "/auth/state")?;
        url.query_pairs_mut()
            .append_pair("platform", &self.config.platform);
        let response = self
            .agent
            .post(url.as_str())
            .set("origin", &self.config.origin)
            .call();
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
        if state.trim().is_empty() {
            return Err(AgentError::new("WorkBuddy OAuth state is empty"));
        }
        let attempts = self.config.max_poll_attempts.clamp(1, 60);
        for attempt in 0..attempts {
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

    pub fn account_info(&self, state: &str) -> Result<WorkBuddyAccountInfo> {
        let mut url = endpoint(&self.config.api_base, "/login/account")?;
        url.query_pairs_mut().append_pair("state", state);
        let response = self
            .agent
            .get(url.as_str())
            .set("origin", &self.config.origin)
            .call();
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
        if credential.access.trim().is_empty() || credential.refresh.trim().is_empty() {
            return Err(AgentError::new(
                "WorkBuddy credential is missing access or refresh token",
            ));
        }
        let url = endpoint(&self.config.api_base, "/auth/token/refresh")?;
        let mut request = self
            .agent
            .post(url.as_str())
            .set("origin", &self.config.origin)
            .set("authorization", &format!("Bearer {}", credential.access))
            .set("x-refresh-token", &credential.refresh)
            .set("content-type", "application/json");
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
        match request.send_string("{}") {
            Ok(response) => parse_credential_response(
                &response
                    .into_string()
                    .map_err(|e| AgentError::new(format!("read WorkBuddy refresh failed: {e}")))?,
            ),
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
            .set("origin", &self.config.origin)
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
    serde_json::from_value(value).map_err(Into::into)
}
fn parse_account(body: &str) -> Result<WorkBuddyAccountInfo> {
    let value: Value = serde_json::from_str(body)?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value)).map_err(Into::into)
}
fn http_error(code: u16, body: String) -> AgentError {
    AgentError::http(
        code,
        format!(
            "WorkBuddy HTTP {code}: {}",
            body.chars().take(1_200).collect::<String>()
        ),
    )
}
fn thread_sleep(milliseconds: u64) {
    std::thread::sleep(Duration::from_millis(milliseconds.min(10_000)));
}
