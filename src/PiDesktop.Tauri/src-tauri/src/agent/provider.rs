//! 直连 Anthropic Messages API 的原生 provider。
//!
//! 同时支持官方端点与 Anthropic 兼容中继（自定义 base_url + Bearer token，
//! 例如 cc-switch 里配置的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 组合）。
//! 阻塞式 HTTP（ureq），与 `AgentProvider::step` 的同步签名吻合；
//! 上层 Tauri 命令自行放到后台线程。

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroize;

use super::{
    AgentError, AgentProvider, AgentStep, ChatMessage, Result, Role, ToolCall, ToolDefinition,
};

/// Anthropic provider 配置。
#[derive(Clone, Serialize, Deserialize)]
pub struct AnthropicConfig {
    /// 端点。可以是官方服务或中继根（自动拼 `/v1/messages`），
    /// 或已含 `/v1/messages` 的完整 URL（原样使用）。
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// API key 或中继 auth token。`sk-ant-` 开头走 `x-api-key`，否则两种头都带上
    /// （中继对 `x-api-key`/`Authorization: Bearer` 的取舍不一，双发兼容面最大）。
    pub auth_token: String,
    /// Explicit authentication mode. OAuth must never be inferred from a token
    /// prefix because an upstream format change could leak it into API-key headers.
    #[serde(default)]
    pub auth_mode: AnthropicAuthMode,
    /// 服务端接受的模型 id。
    pub model: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// 系统提示（可选）。
    #[serde(default)]
    pub system: Option<String>,
    /// 请求超时秒数。
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

impl fmt::Debug for AnthropicConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AnthropicConfig")
            .field("base_url", &self.base_url)
            .field("auth_token", &"[redacted]")
            .field("auth_mode", &self.auth_mode)
            .field("model", &self.model)
            .field("max_tokens", &self.max_tokens)
            .field("system", &self.system)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

impl Drop for AnthropicConfig {
    fn drop(&mut self) {
        self.auth_token.zeroize();
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnthropicAuthMode {
    ApiKey,
    OAuth,
    #[default]
    Relay,
}

fn default_base_url() -> String {
    "https://api.anthropic.com".to_string()
}
fn default_max_tokens() -> u32 {
    1024
}
fn default_timeout_secs() -> u64 {
    120
}

impl AnthropicConfig {
    pub fn new(
        base_url: impl Into<String>,
        auth_token: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            auth_token: auth_token.into(),
            auth_mode: AnthropicAuthMode::Relay,
            model: model.into(),
            max_tokens: default_max_tokens(),
            system: None,
            timeout_secs: default_timeout_secs(),
        }
    }

    pub fn oauth(auth_token: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            base_url: default_base_url(),
            auth_token: auth_token.into(),
            auth_mode: AnthropicAuthMode::OAuth,
            model: model.into(),
            max_tokens: default_max_tokens(),
            system: None,
            timeout_secs: default_timeout_secs(),
        }
    }

    pub fn api_key(auth_token: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            base_url: default_base_url(),
            auth_token: auth_token.into(),
            auth_mode: AnthropicAuthMode::ApiKey,
            model: model.into(),
            max_tokens: default_max_tokens(),
            system: None,
            timeout_secs: default_timeout_secs(),
        }
    }

    fn messages_url(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if base.ends_with("/v1/messages") {
            base.to_string()
        } else {
            format!("{base}/v1/messages")
        }
    }
}

/// 直连 Messages API 的 provider。
pub struct AnthropicProvider {
    config: AnthropicConfig,
    agent: ureq::Agent,
}

impl AnthropicProvider {
    pub fn new(config: AnthropicConfig) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .build();
        Self { config, agent }
    }

    /// 把内部对话转成 Messages API 的 `system` + `messages`。
    ///
    /// 规则：System 角色并入 system 提示；Assistant 的 tool_calls 转 `tool_use` 块；
    /// 连续的 Tool 结果合并进**同一条** user 消息的 `tool_result` 块（API 要求
    /// 并行工具的结果必须在紧随其后的单条 user 消息里）。
    fn build_request(
        &self,
        conversation: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Value> {
        let mut system_parts: Vec<String> = self.config.system.iter().cloned().collect();
        let mut messages: Vec<Value> = Vec::new();

        let mut i = 0;
        while i < conversation.len() {
            let msg = &conversation[i];
            match msg.role {
                Role::System => {
                    if !msg.content.is_empty() {
                        system_parts.push(msg.content.clone());
                    }
                    i += 1;
                }
                Role::User => {
                    messages.push(json!({ "role": "user", "content": msg.content }));
                    i += 1;
                }
                Role::Assistant => {
                    let mut blocks: Vec<Value> = Vec::new();
                    if !msg.content.is_empty() {
                        blocks.push(json!({ "type": "text", "text": msg.content }));
                    }
                    for call in &msg.tool_calls {
                        let input: Value = serde_json::from_str(&call.arguments_json)
                            .unwrap_or_else(|_| json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": call.id,
                            "name": call.tool_name,
                            "input": input,
                        }));
                    }
                    if blocks.is_empty() {
                        blocks.push(json!({ "type": "text", "text": "" }));
                    }
                    messages.push(json!({ "role": "assistant", "content": blocks }));
                    i += 1;
                }
                Role::Tool => {
                    // 收拢连续的工具结果到一条 user 消息。
                    let mut blocks: Vec<Value> = Vec::new();
                    while i < conversation.len() && conversation[i].role == Role::Tool {
                        let t = &conversation[i];
                        blocks.push(json!({
                            "type": "tool_result",
                            "tool_use_id": t.tool_call_id.clone().unwrap_or_default(),
                            "content": t.content,
                        }));
                        i += 1;
                    }
                    messages.push(json!({ "role": "user", "content": blocks }));
                }
            }
        }

        let mut request = json!({
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "messages": messages,
        });
        if !system_parts.is_empty() {
            request["system"] = json!(system_parts.join("\n\n"));
        }
        if !tools.is_empty() {
            let tool_values: Vec<Value> = tools
                .iter()
                .map(|t| {
                    let schema: Value = serde_json::from_str(&t.input_schema_json)
                        .unwrap_or_else(|_| json!({ "type": "object" }));
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": schema,
                    })
                })
                .collect();
            request["tools"] = json!(tool_values);
        }
        Ok(request)
    }

    fn parse_response(body: &str) -> Result<AgentStep> {
        let value: Value = serde_json::from_str(body)?;
        if let Some(err) = value.get("error") {
            return Err(AgentError::new(format!(
                "API error: {}",
                err.get("message").and_then(|m| m.as_str()).unwrap_or(body)
            )));
        }
        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        if let Some(content) = value.get("content").and_then(|c| c.as_array()) {
            for block in content {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            text_parts.push(t.to_string());
                        }
                    }
                    Some("tool_use") => {
                        tool_calls.push(ToolCall {
                            id: block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            tool_name: block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            arguments_json: block
                                .get("input")
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "{}".to_string()),
                        });
                    }
                    _ => {}
                }
            }
        }
        let text = text_parts.join("");
        // 推理型模型可能把预算全烧在不可见 thinking 上：给出诊断而非静默空回复。
        if text.is_empty() && tool_calls.is_empty() {
            let stop = value
                .get("stop_reason")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown");
            return Ok(AgentStep {
                assistant_text: Some(format!(
                    "（模型没有产生可见文本，stop_reason={stop}；若为 max_tokens，请在配置里调大 max_tokens——推理型模型的思考也计入预算）"
                )),
                tool_calls,
            });
        }
        Ok(AgentStep {
            assistant_text: if text.is_empty() { None } else { Some(text) },
            tool_calls,
        })
    }
}

impl AgentProvider for AnthropicProvider {
    fn id(&self) -> &str {
        "anthropic"
    }

    fn step(&self, conversation: &[ChatMessage], tools: &[ToolDefinition]) -> Result<AgentStep> {
        let request = self.build_request(conversation, tools)?;
        let url = self.config.messages_url();

        let mut req = self
            .agent
            .post(&url)
            .set("content-type", "application/json")
            .set("anthropic-version", "2023-06-01");
        req = match self.config.auth_mode {
            AnthropicAuthMode::OAuth => req
                .set(
                    "authorization",
                    &format!("Bearer {}", self.config.auth_token),
                )
                .set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
                .set("user-agent", "claude-cli/2.1.75")
                .set("x-app", "cli"),
            AnthropicAuthMode::ApiKey => req.set("x-api-key", &self.config.auth_token),
            // 中继 token：双发两种头，兼容 x-api-key 或 Bearer 任一实现。
            AnthropicAuthMode::Relay => req.set("x-api-key", &self.config.auth_token).set(
                "authorization",
                &format!("Bearer {}", self.config.auth_token),
            ),
        };

        let response = req.send_string(&request.to_string());
        match response {
            Ok(resp) => {
                let body = resp
                    .into_string()
                    .map_err(|e| AgentError::new(format!("读响应失败: {e}")))?;
                Self::parse_response(&body)
            }
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                let snippet: String = body.chars().take(600).collect();
                Err(AgentError::http(code, format!("HTTP {code}: {snippet}")))
            }
            Err(e) => Err(AgentError::transport(format!("请求失败: {e}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_join_rules() {
        let mut c = AnthropicConfig {
            base_url: "https://api.anthropic.com".into(),
            auth_token: "t".into(),
            auth_mode: AnthropicAuthMode::Relay,
            model: "m".into(),
            max_tokens: 16,
            system: None,
            timeout_secs: 5,
        };
        assert_eq!(c.messages_url(), "https://api.anthropic.com/v1/messages");
        c.base_url = "https://opencode.ai/zen/go".into();
        assert_eq!(c.messages_url(), "https://opencode.ai/zen/go/v1/messages");
        c.base_url = "https://ollama.com/v1/messages".into();
        assert_eq!(c.messages_url(), "https://ollama.com/v1/messages");
        c.base_url = "https://ollama.com/v1/messages/".into();
        assert_eq!(c.messages_url(), "https://ollama.com/v1/messages");
    }

    #[test]
    fn tool_results_merge_into_single_user_message() {
        let cfg = AnthropicConfig {
            base_url: "https://x".into(),
            auth_token: "t".into(),
            auth_mode: AnthropicAuthMode::Relay,
            model: "m".into(),
            max_tokens: 16,
            system: Some("sys".into()),
            timeout_secs: 5,
        };
        let p = AnthropicProvider::new(cfg);
        let convo = vec![
            ChatMessage::user("hi"),
            ChatMessage {
                role: Role::Assistant,
                content: "calling".into(),
                tool_calls: vec![
                    ToolCall {
                        id: "a".into(),
                        tool_name: "t1".into(),
                        arguments_json: "{}".into(),
                    },
                    ToolCall {
                        id: "b".into(),
                        tool_name: "t2".into(),
                        arguments_json: "{}".into(),
                    },
                ],
                tool_call_id: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: "r1".into(),
                tool_calls: vec![],
                tool_call_id: Some("a".into()),
            },
            ChatMessage {
                role: Role::Tool,
                content: "r2".into(),
                tool_calls: vec![],
                tool_call_id: Some("b".into()),
            },
        ];
        let req = p.build_request(&convo, &[]).unwrap();
        let messages = req["messages"].as_array().unwrap();
        // user, assistant, merged tool-result user → 3 条
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(req["system"], "sys");
    }

    #[test]
    fn parse_text_and_tool_use() {
        let body = r#"{
            "content": [
                {"type":"text","text":"hello "},
                {"type":"text","text":"world"},
                {"type":"tool_use","id":"tu_1","name":"sv_status","input":{"a":1}}
            ],
            "stop_reason": "tool_use"
        }"#;
        let step = AnthropicProvider::parse_response(body).unwrap();
        assert_eq!(step.assistant_text.as_deref(), Some("hello world"));
        assert_eq!(step.tool_calls.len(), 1);
        assert_eq!(step.tool_calls[0].tool_name, "sv_status");
        assert_eq!(step.tool_calls[0].arguments_json, r#"{"a":1}"#);
    }

    /// 真实网络冒烟：需要 TOOLBOX_TEST_BASE_URL / TOOLBOX_TEST_TOKEN /
    /// TOOLBOX_TEST_MODEL 环境变量。
    /// 平时 ignore，显式 `cargo test -- --ignored` 执行。
    #[test]
    #[ignore]
    fn live_relay_roundtrip() {
        let base = std::env::var("TOOLBOX_TEST_BASE_URL").expect("TOOLBOX_TEST_BASE_URL");
        let token = std::env::var("TOOLBOX_TEST_TOKEN").expect("TOOLBOX_TEST_TOKEN");
        let model = std::env::var("TOOLBOX_TEST_MODEL").unwrap_or_else(|_| "glm-5.2".into());
        let p = AnthropicProvider::new(AnthropicConfig {
            base_url: base,
            auth_token: token,
            auth_mode: AnthropicAuthMode::Relay,
            model,
            max_tokens: 64,
            system: Some("You are a terse test assistant. Reply in one short sentence.".into()),
            timeout_secs: 60,
        });
        let convo = vec![ChatMessage::user("Say OK and nothing else.")];
        let step = p.step(&convo, &[]).expect("live call failed");
        let text = step.assistant_text.expect("no text");
        assert!(!text.is_empty());
        println!("live reply: {text}");
    }
}
