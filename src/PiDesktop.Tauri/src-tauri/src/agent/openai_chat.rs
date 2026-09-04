//! OpenAI-compatible Chat Completions runtime provider.
//!
//! The caller supplies the endpoint, model, and API key. This module owns only
//! request/response translation and never persists credentials.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{BufRead, BufReader, Read};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroize;

use super::{
    AgentError, AgentProvider, AgentStep, ChatMessage, Result, Role, ToolCall, ToolDefinition,
};

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;

fn default_timeout_secs() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

/// Configuration for an OpenAI-compatible `/v1/chat/completions` endpoint.
#[derive(Clone, Serialize, Deserialize)]
pub struct OpenAiChatConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

impl fmt::Debug for OpenAiChatConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiChatConfig")
            .field("base_url", &self.base_url)
            .field("api_key", &"[redacted]")
            .field("model", &self.model)
            .field(
                "headers",
                &self
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

impl Drop for OpenAiChatConfig {
    fn drop(&mut self) {
        self.api_key.zeroize();
        for (_, value) in &mut self.headers {
            value.zeroize();
        }
    }
}

impl OpenAiChatConfig {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
            headers: Vec::new(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }

    fn endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        }
    }
}

pub struct OpenAiChatProvider {
    config: OpenAiChatConfig,
    agent: ureq::Agent,
}

impl OpenAiChatProvider {
    pub fn new(config: OpenAiChatConfig) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .build();
        Self { config, agent }
    }

    pub fn config(&self) -> &OpenAiChatConfig {
        &self.config
    }

    fn build_request(
        &self,
        conversation: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Value> {
        let messages = conversation
            .iter()
            .map(chat_message_json)
            .collect::<Result<Vec<_>>>()?;
        let mut request = json!({ "model": self.config.model, "messages": messages, "stream": true, "parallel_tool_calls": true });
        if !tools.is_empty() {
            request["tools"] = Value::Array(tools.iter().map(|tool| {
                let parameters = serde_json::from_str::<Value>(&tool.input_schema_json).unwrap_or_else(|_| json!({ "type": "object" }));
                json!({ "type": "function", "function": { "name": tool.name, "description": tool.description, "parameters": parameters } })
            }).collect());
            request["tool_choice"] = json!("auto");
        }
        Ok(request)
    }

    fn headers(&self) -> Result<Vec<(String, String)>> {
        let key = self.config.api_key.trim();
        if key.is_empty() {
            return Err(AgentError::new("OpenAI API key is empty"));
        }
        let mut headers = vec![
            ("Authorization".to_string(), format!("Bearer {key}")),
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Accept".to_string(), "text/event-stream".to_string()),
        ];
        headers.extend(self.config.headers.iter().cloned());
        Ok(headers)
    }

    fn parse_body(body: &[u8]) -> Result<AgentStep> {
        let text = std::str::from_utf8(body)
            .map_err(|_| AgentError::new("OpenAI response is not UTF-8"))?;
        if text.trim_start().starts_with('{') {
            return parse_json_response(text);
        }
        parse_sse(BufReader::new(text.as_bytes()))
    }
}

impl AgentProvider for OpenAiChatProvider {
    fn id(&self) -> &str {
        "openai-chat"
    }

    fn step(&self, conversation: &[ChatMessage], tools: &[ToolDefinition]) -> Result<AgentStep> {
        let body = self.build_request(conversation, tools)?.to_string();
        let mut request = self.agent.post(&self.config.endpoint());
        for (name, value) in self.headers()? {
            request = request.set(&name, &value);
        }
        match request.send_string(&body) {
            Ok(response) => {
                let mut bytes = Vec::new();
                response
                    .into_reader()
                    .take((MAX_RESPONSE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > MAX_RESPONSE_BYTES {
                    return Err(AgentError::new("OpenAI response exceeded 32 MiB"));
                }
                Self::parse_body(&bytes)
            }
            Err(ureq::Error::Status(code, response)) => {
                let body = response.into_string().unwrap_or_default();
                let class = match code {
                    401 => "authentication failed",
                    403 => "permission denied",
                    408 => "timed out",
                    429 => "rate limited",
                    500..=599 => "upstream server error",
                    _ => "request failed",
                };
                Err(AgentError::http(
                    code,
                    format!(
                        "OpenAI Chat Completions {code} ({class}): {}",
                        body.chars().take(1_200).collect::<String>()
                    ),
                ))
            }
            Err(error) => Err(AgentError::transport(format!(
                "OpenAI Chat Completions transport failed: {error}"
            ))),
        }
    }
}

fn chat_message_json(message: &ChatMessage) -> Result<Value> {
    match message.role {
        Role::System => Ok(json!({ "role": "system", "content": message.content })),
        Role::User => Ok(json!({ "role": "user", "content": message.content })),
        Role::Assistant => {
            let mut value = json!({ "role": "assistant", "content": if message.content.is_empty() { Value::Null } else { json!(message.content) } });
            if !message.tool_calls.is_empty() {
                value["tool_calls"] = Value::Array(message.tool_calls.iter().map(|call| json!({ "id": call.id, "type": "function", "function": { "name": call.tool_name, "arguments": normalize_arguments(&call.arguments_json) } })).collect());
            }
            Ok(value)
        }
        Role::Tool => Ok(
            json!({ "role": "tool", "tool_call_id": message.tool_call_id.as_deref().ok_or_else(|| AgentError::new("Tool result is missing its call id"))?, "content": message.content }),
        ),
    }
}

fn normalize_arguments(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "{}".to_string())
}

fn parse_json_response(body: &str) -> Result<AgentStep> {
    let value: Value = serde_json::from_str(body)?;
    if let Some(error) = value.get("error") {
        return Err(AgentError::new(format!(
            "OpenAI API error: {}",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        )));
    }
    let message = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .ok_or_else(|| AgentError::new("OpenAI response has no choice message"))?;
    parse_message(message)
}

fn parse_message(message: &Value) -> Result<AgentStep> {
    let assistant_text = match message.get("content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    };
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
        .iter()
        .map(|call| {
            let function = call
                .get("function")
                .ok_or_else(|| AgentError::new("OpenAI tool call has no function"))?;
            let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if id.is_empty() || name.is_empty() {
                return Err(AgentError::new("OpenAI tool call is missing id or name"));
            }
            Ok(ToolCall {
                id: id.to_string(),
                tool_name: name.to_string(),
                arguments_json: normalize_arguments(
                    function
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or("{}"),
                ),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(AgentStep {
        assistant_text,
        tool_calls,
    })
}

#[derive(Default)]
struct SseAccumulator {
    text: String,
    calls: BTreeMap<usize, SseCall>,
}

#[derive(Default)]
struct SseCall {
    id: String,
    name: String,
    arguments: String,
}

fn parse_sse<R: BufRead>(mut reader: R) -> Result<AgentStep> {
    let mut accumulator = SseAccumulator::default();
    let mut event = String::new();
    let mut line = String::new();
    let mut total = 0usize;
    loop {
        line.clear();
        let count = reader.read_line(&mut line)?;
        if count == 0 {
            dispatch_event(&mut accumulator, &mut event)?;
            break;
        }
        total += count;
        if total > MAX_RESPONSE_BYTES {
            return Err(AgentError::new("OpenAI SSE response exceeded 32 MiB"));
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            dispatch_event(&mut accumulator, &mut event)?;
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            if !event.is_empty() {
                event.push('\n');
            }
            event.push_str(data.strip_prefix(' ').unwrap_or(data));
            if event.len() > MAX_EVENT_BYTES {
                return Err(AgentError::new("OpenAI SSE event exceeded 8 MiB"));
            }
        }
    }
    let tool_calls = accumulator
        .calls
        .into_values()
        .map(|call| {
            if call.id.is_empty() || call.name.is_empty() {
                return Err(AgentError::new("OpenAI SSE tool call is incomplete"));
            }
            Ok(ToolCall {
                id: call.id,
                tool_name: call.name,
                arguments_json: normalize_arguments(&call.arguments),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(AgentStep {
        assistant_text: (!accumulator.text.is_empty()).then_some(accumulator.text),
        tool_calls,
    })
}

fn dispatch_event(accumulator: &mut SseAccumulator, event: &mut String) -> Result<()> {
    if event.is_empty() {
        return Ok(());
    }
    let data = std::mem::take(event);
    if data.trim() == "[DONE]" {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&data)?;
    if let Some(error) = value.get("error") {
        return Err(AgentError::new(format!(
            "OpenAI SSE error: {}",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        )));
    }
    let delta = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .unwrap_or(&Value::Null);
    if let Some(text) = delta.get("content").and_then(Value::as_str) {
        accumulator.text.push_str(text);
    }
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let entry = accumulator.calls.entry(index).or_default();
            if let Some(value) = call.get("id").and_then(Value::as_str) {
                entry.id.push_str(value);
            }
            if let Some(function) = call.get("function") {
                if let Some(value) = function.get("name").and_then(Value::as_str) {
                    entry.name.push_str(value);
                }
                if let Some(value) = function.get("arguments").and_then(Value::as_str) {
                    entry.arguments.push_str(value);
                }
            }
        }
    }
    Ok(())
}
