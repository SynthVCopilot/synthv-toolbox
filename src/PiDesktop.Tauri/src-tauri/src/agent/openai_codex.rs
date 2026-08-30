//! Codex subscription Responses provider.
//!
//! This module deliberately covers only the synchronous provider transport.
//! OAuth authorization, token refresh, account persistence, and UI state live
//! outside the agent runtime. The caller supplies a current access token and
//! the subscription account id associated with that token.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{BufRead, BufReader};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use zeroize::Zeroize;

use super::{
    AgentError, AgentProvider, AgentStep, ChatMessage, Result, Role, ToolCall, ToolDefinition,
};

const DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const DEFAULT_INSTRUCTIONS: &str = "You are a helpful assistant.";
const MAX_SSE_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES: usize = 8 * 1024 * 1024;

fn default_base_url() -> String {
    DEFAULT_BASE_URL.to_string()
}

fn default_timeout_secs() -> u64 {
    120
}

/// Connection details for the official subscription Responses endpoint.
#[derive(Clone, Serialize, Deserialize)]
pub struct OpenAiCodexConfig {
    /// Service root or full `/codex/responses` endpoint.
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// Short-lived OAuth access token. Refreshing it is the caller's job.
    pub access_token: String,
    /// Account id belonging to the access token.
    pub account_id: String,
    /// Codex model id.
    pub model: String,
    /// Optional instructions prepended to System messages in the conversation.
    #[serde(default)]
    pub instructions: Option<String>,
    /// Blocking request timeout in seconds.
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

impl fmt::Debug for OpenAiCodexConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiCodexConfig")
            .field("base_url", &self.base_url)
            .field("access_token", &"[redacted]")
            .field("account_id", &self.account_id)
            .field("model", &self.model)
            .field("instructions", &self.instructions)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

impl Drop for OpenAiCodexConfig {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

impl OpenAiCodexConfig {
    pub fn new(
        access_token: impl Into<String>,
        account_id: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            base_url: default_base_url(),
            access_token: access_token.into(),
            account_id: account_id.into(),
            model: model.into(),
            instructions: None,
            timeout_secs: default_timeout_secs(),
        }
    }

    fn responses_url(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        if base.ends_with("/codex/responses") {
            base.to_string()
        } else if base.ends_with("/codex") {
            format!("{base}/responses")
        } else {
            format!("{base}/codex/responses")
        }
    }
}

/// Synchronous provider for the Codex-flavoured Responses SSE API.
pub struct OpenAiCodexProvider {
    config: OpenAiCodexConfig,
    agent: ureq::Agent,
}

impl OpenAiCodexProvider {
    pub fn new(config: OpenAiCodexConfig) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .build();
        Self { config, agent }
    }

    fn request_headers(&self) -> Result<Vec<(&'static str, String)>> {
        let token = self.config.access_token.trim();
        if token.is_empty() {
            return Err(AgentError::new("Codex OAuth access token is empty"));
        }
        let account_id = self.config.account_id.trim();
        if account_id.is_empty() {
            return Err(AgentError::new("ChatGPT account id is empty"));
        }
        Ok(vec![
            ("Authorization", format!("Bearer {token}")),
            ("chatgpt-account-id", account_id.to_string()),
            ("originator", "pi".to_string()),
            ("OpenAI-Beta", "responses=experimental".to_string()),
            ("accept", "text/event-stream".to_string()),
            ("content-type", "application/json".to_string()),
            (
                "User-Agent",
                format!("synthv-toolbox/{}", env!("CARGO_PKG_VERSION")),
            ),
        ])
    }

    fn build_request(
        &self,
        conversation: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Value> {
        let model = self.config.model.trim();
        if model.is_empty() {
            return Err(AgentError::new("Codex model id is empty"));
        }

        let mut instruction_parts = Vec::new();
        if let Some(instructions) = self
            .config
            .instructions
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            instruction_parts.push(instructions.to_string());
        }

        let mut input = Vec::new();
        for (message_index, message) in conversation.iter().enumerate() {
            match message.role {
                Role::System => {
                    if !message.content.trim().is_empty() {
                        instruction_parts.push(message.content.clone());
                    }
                }
                Role::User => {
                    input.push(json!({
                        "role": "user",
                        "content": [{ "type": "input_text", "text": message.content }],
                    }));
                }
                Role::Assistant => {
                    if !message.content.is_empty() {
                        input.push(json!({
                            "type": "message",
                            "id": format!("msg_pi_{message_index}"),
                            "role": "assistant",
                            "content": [{
                                "type": "output_text",
                                "text": message.content,
                                "annotations": [],
                            }],
                            "status": "completed",
                        }));
                    }
                    for call in &message.tool_calls {
                        input.push(function_call_input(call));
                    }
                }
                Role::Tool => {
                    let internal_id = message
                        .tool_call_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| AgentError::new("Tool result is missing its call id"))?;
                    let (call_id, _) = split_internal_tool_call_id(internal_id);
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": message.content,
                    }));
                }
            }
        }

        let instructions = if instruction_parts.is_empty() {
            DEFAULT_INSTRUCTIONS.to_string()
        } else {
            instruction_parts.join("\n\n")
        };
        let mut request = json!({
            "model": model,
            "store": false,
            "stream": true,
            "instructions": instructions,
            "input": input,
            "text": { "verbosity": "low" },
            "include": ["reasoning.encrypted_content"],
            "tool_choice": "auto",
            "parallel_tool_calls": true,
        });

        if !tools.is_empty() {
            let values = tools
                .iter()
                .map(|tool| {
                    let parameters = serde_json::from_str::<Value>(&tool.input_schema_json)
                        .unwrap_or_else(|_| json!({ "type": "object" }));
                    json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": parameters,
                        "strict": null,
                    })
                })
                .collect::<Vec<_>>();
            request["tools"] = Value::Array(values);
        }
        Ok(request)
    }

    fn parse_sse<R: BufRead>(reader: R) -> Result<AgentStep> {
        parse_sse(reader)
    }
}

impl AgentProvider for OpenAiCodexProvider {
    fn id(&self) -> &str {
        "openai-codex"
    }

    fn step(&self, conversation: &[ChatMessage], tools: &[ToolDefinition]) -> Result<AgentStep> {
        let body = self.build_request(conversation, tools)?.to_string();
        let mut request = self.agent.post(&self.config.responses_url());
        for (name, value) in self.request_headers()? {
            request = request.set(name, &value);
        }

        match request.send_string(&body) {
            Ok(response) => Self::parse_sse(BufReader::new(response.into_reader())),
            Err(ureq::Error::Status(code, response)) => {
                let body = response.into_string().unwrap_or_default();
                let snippet = body.chars().take(1_200).collect::<String>();
                Err(AgentError::http(
                    code,
                    format!("Codex HTTP {code}: {snippet}"),
                ))
            }
            Err(error) => Err(AgentError::transport(format!(
                "Codex request failed: {error}"
            ))),
        }
    }
}

fn function_call_input(call: &ToolCall) -> Value {
    let (call_id, item_id) = split_internal_tool_call_id(&call.id);
    let arguments = serde_json::from_str::<Value>(&call.arguments_json)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "{}".to_string());
    let mut item = Map::from_iter([
        ("type".to_string(), json!("function_call")),
        ("call_id".to_string(), json!(call_id)),
        ("name".to_string(), json!(call.tool_name)),
        ("arguments".to_string(), json!(arguments)),
    ]);
    if item_id.is_some_and(|id| id.starts_with("fc_")) {
        item.insert("id".to_string(), json!(item_id));
    }
    Value::Object(item)
}

fn split_internal_tool_call_id(id: &str) -> (&str, Option<&str>) {
    id.split_once('|')
        .map_or((id, None), |(call_id, item_id)| (call_id, Some(item_id)))
}

#[derive(Debug, Default)]
struct PendingFunctionCall {
    call_id: String,
    item_id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct StreamAccumulator {
    text: BTreeMap<usize, String>,
    calls: BTreeMap<usize, ToolCall>,
    pending_calls: BTreeMap<usize, PendingFunctionCall>,
    completed: bool,
}

impl StreamAccumulator {
    fn apply(&mut self, event: &Value) -> Result<()> {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.text
                        .entry(output_index(event))
                        .or_default()
                        .push_str(delta);
                }
            }
            "response.output_text.done" => {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    self.text.insert(output_index(event), text.to_string());
                }
            }
            "response.output_item.added" => {
                if let Some(item) = event.get("item") {
                    self.observe_added_item(output_index(event), item);
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.pending_calls
                        .entry(output_index(event))
                        .or_default()
                        .arguments
                        .push_str(delta);
                }
            }
            "response.function_call_arguments.done" => {
                if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                    self.pending_calls
                        .entry(output_index(event))
                        .or_default()
                        .arguments = arguments.to_string();
                }
            }
            "response.output_item.done" => {
                if let Some(item) = event.get("item") {
                    self.apply_final_item(output_index(event), item)?;
                }
            }
            "response.completed" | "response.done" => {
                let response = event.get("response").unwrap_or(event);
                self.apply_terminal_output(response)?;
                self.completed = true;
            }
            "response.incomplete" => {
                return Err(AgentError::new(terminal_error_message(
                    event,
                    "Codex response was incomplete",
                )));
            }
            "response.failed" => {
                return Err(AgentError::new(terminal_error_message(
                    event,
                    "Codex response failed",
                )));
            }
            "error" => {
                return Err(AgentError::new(terminal_error_message(
                    event,
                    "Codex stream returned an error",
                )));
            }
            _ => {}
        }
        Ok(())
    }

    fn observe_added_item(&mut self, index: usize, item: &Value) {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return;
        }
        let pending = self.pending_calls.entry(index).or_default();
        if let Some(value) = item.get("call_id").and_then(Value::as_str) {
            pending.call_id = value.to_string();
        }
        if let Some(value) = item.get("id").and_then(Value::as_str) {
            pending.item_id = value.to_string();
        }
        if let Some(value) = item.get("name").and_then(Value::as_str) {
            pending.name = value.to_string();
        }
        if let Some(value) = item.get("arguments").and_then(Value::as_str) {
            pending.arguments = value.to_string();
        }
    }

    fn apply_final_item(&mut self, index: usize, item: &Value) -> Result<()> {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                if let Some(text) = message_item_text(item) {
                    self.text.insert(index, text);
                }
            }
            Some("function_call") => {
                let pending = self.pending_calls.remove(&index).unwrap_or_default();
                self.calls
                    .insert(index, tool_call_from_item(item, pending)?);
            }
            _ => {}
        }
        Ok(())
    }

    fn apply_terminal_output(&mut self, response: &Value) -> Result<()> {
        if let Some(status) = response.get("status").and_then(Value::as_str) {
            if status != "completed" {
                return Err(AgentError::new(terminal_error_message(
                    response,
                    &format!("Codex response ended with status {status}"),
                )));
            }
        }
        if let Some(output) = response.get("output").and_then(Value::as_array) {
            for (index, item) in output.iter().enumerate() {
                self.apply_final_item(index, item)?;
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<AgentStep> {
        if !self.completed {
            return Err(AgentError::new(
                "Codex SSE stream ended before response.completed",
            ));
        }
        let text = self.text.into_values().collect::<Vec<_>>().join("");
        let tool_calls = self.calls.into_values().collect::<Vec<_>>();
        if text.is_empty() && tool_calls.is_empty() {
            return Err(AgentError::new(
                "Codex response contained no visible text or function calls",
            ));
        }
        Ok(AgentStep {
            assistant_text: (!text.is_empty()).then_some(text),
            tool_calls,
        })
    }
}

fn output_index(event: &Value) -> usize {
    event
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
}

fn message_item_text(item: &Value) -> Option<String> {
    let content = item.get("content")?.as_array()?;
    let mut text = String::new();
    let mut found = false;
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("output_text") => {
                if let Some(value) = block.get("text").and_then(Value::as_str) {
                    text.push_str(value);
                    found = true;
                }
            }
            Some("refusal") => {
                if let Some(value) = block
                    .get("refusal")
                    .or_else(|| block.get("text"))
                    .and_then(Value::as_str)
                {
                    text.push_str(value);
                    found = true;
                }
            }
            _ => {}
        }
    }
    found.then_some(text)
}

fn tool_call_from_item(item: &Value, pending: PendingFunctionCall) -> Result<ToolCall> {
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&pending.call_id);
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&pending.item_id);
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&pending.name);
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&pending.arguments);

    if call_id.is_empty() || name.is_empty() {
        return Err(AgentError::new(
            "Codex function call is missing call_id or name",
        ));
    }
    let arguments_json = if arguments.is_empty() {
        "{}".to_string()
    } else {
        serde_json::from_str::<Value>(arguments)
            .map_err(|error| AgentError::new(format!("Invalid Codex function arguments: {error}")))?
            .to_string()
    };
    let id = if item_id.is_empty() || item_id == call_id {
        call_id.to_string()
    } else {
        format!("{call_id}|{item_id}")
    };
    Ok(ToolCall {
        id,
        tool_name: name.to_string(),
        arguments_json,
    })
}

fn terminal_error_message(value: &Value, fallback: &str) -> String {
    let response = value.get("response").unwrap_or(value);
    let error = response.get("error").unwrap_or(response);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str));
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| value.get("code").and_then(Value::as_str));
    match (code, message) {
        (Some(code), Some(message)) => format!("{fallback}: {code}: {message}"),
        (_, Some(message)) => format!("{fallback}: {message}"),
        _ => fallback.to_string(),
    }
}

fn parse_sse<R: BufRead>(mut reader: R) -> Result<AgentStep> {
    let mut accumulator = StreamAccumulator::default();
    let mut event_data = String::new();
    let mut line = String::new();
    let mut total_bytes = 0usize;

    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| AgentError::new(format!("Failed to read Codex SSE: {error}")))?;
        if read == 0 {
            dispatch_sse_event(&mut accumulator, &mut event_data)?;
            break;
        }
        total_bytes = total_bytes.saturating_add(read);
        if total_bytes > MAX_SSE_RESPONSE_BYTES {
            return Err(AgentError::new("Codex SSE response exceeded 32 MiB"));
        }

        let value = line.trim_end_matches('\n').trim_end_matches('\r');
        if value.is_empty() {
            dispatch_sse_event(&mut accumulator, &mut event_data)?;
            continue;
        }
        if let Some(data) = value.strip_prefix("data:") {
            if !event_data.is_empty() {
                event_data.push('\n');
            }
            event_data.push_str(data.strip_prefix(' ').unwrap_or(data));
            if event_data.len() > MAX_SSE_EVENT_BYTES {
                return Err(AgentError::new("Codex SSE event exceeded 8 MiB"));
            }
        }
    }
    accumulator.finish()
}

fn dispatch_sse_event(accumulator: &mut StreamAccumulator, event_data: &mut String) -> Result<()> {
    if event_data.is_empty() {
        return Ok(());
    }
    let data = std::mem::take(event_data);
    if data.trim() == "[DONE]" {
        return Ok(());
    }
    let event = serde_json::from_str::<Value>(&data)
        .map_err(|error| AgentError::new(format!("Invalid Codex SSE event: {error}")))?;
    accumulator.apply(&event)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn provider() -> OpenAiCodexProvider {
        OpenAiCodexProvider::new(OpenAiCodexConfig::new(
            "access-token",
            "account-123",
            "gpt-5.6-codex",
        ))
    }

    #[test]
    fn endpoint_and_headers_match_the_codex_sse_contract() {
        let provider = provider();
        assert_eq!(
            provider.config.responses_url(),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        let headers = provider
            .request_headers()
            .expect("valid credentials")
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(headers["Authorization"], "Bearer access-token");
        assert_eq!(headers["chatgpt-account-id"], "account-123");
        assert_eq!(headers["originator"], "pi");
        assert_eq!(headers["accept"], "text/event-stream");
        assert_eq!(headers["OpenAI-Beta"], "responses=experimental");
    }

    #[test]
    fn request_maps_messages_tool_calls_results_and_definitions() {
        let provider = provider();
        let conversation = vec![
            ChatMessage {
                role: Role::System,
                content: "Be concise.".to_string(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            ChatMessage::user("Inspect the project"),
            ChatMessage {
                role: Role::Assistant,
                content: "I will inspect it.".to_string(),
                tool_calls: vec![ToolCall {
                    id: "call_1|fc_1".to_string(),
                    tool_name: "sv_status".to_string(),
                    arguments_json: r#"{"scope":"project"}"#.to_string(),
                }],
                tool_call_id: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: r#"{"ok":true}"#.to_string(),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_1|fc_1".to_string()),
            },
        ];
        let tools = vec![ToolDefinition {
            name: "sv_status".to_string(),
            description: "Read SynthV status".to_string(),
            input_schema_json: r#"{"type":"object","properties":{"scope":{"type":"string"}}}"#
                .to_string(),
        }];

        let request = provider
            .build_request(&conversation, &tools)
            .expect("request should build");
        assert_eq!(request["model"], "gpt-5.6-codex");
        assert_eq!(request["instructions"], "Be concise.");
        assert_eq!(request["store"], false);
        assert_eq!(request["stream"], true);
        assert_eq!(request["parallel_tool_calls"], true);

        let input = request["input"].as_array().expect("input array");
        assert_eq!(input.len(), 4);
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[1]["content"][0]["type"], "output_text");
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["call_id"], "call_1");
        assert_eq!(input[2]["id"], "fc_1");
        assert_eq!(input[2]["arguments"], r#"{"scope":"project"}"#);
        assert_eq!(input[3]["type"], "function_call_output");
        assert_eq!(input[3]["call_id"], "call_1");
        assert_eq!(request["tools"][0]["type"], "function");
        assert_eq!(request["tools"][0]["parameters"]["type"], "object");
        assert!(request["tools"][0]["strict"].is_null());
    }

    #[test]
    fn sse_parser_combines_text_and_final_function_calls() {
        let sse = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"hel\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"lo\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"fc_9\",\"call_id\":\"call_9\",\"name\":\"sv_status\",\"arguments\":\"{\\\"scope\\\":\\\"project\\\"}\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
            "data: [DONE]\n\n",
        );
        let step = OpenAiCodexProvider::parse_sse(Cursor::new(sse)).expect("valid SSE");
        assert_eq!(step.assistant_text.as_deref(), Some("hello"));
        assert_eq!(step.tool_calls.len(), 1);
        assert_eq!(step.tool_calls[0].id, "call_9|fc_9");
        assert_eq!(step.tool_calls[0].tool_name, "sv_status");
        assert_eq!(step.tool_calls[0].arguments_json, r#"{"scope":"project"}"#);
    }

    #[test]
    fn completed_response_output_is_a_non_streaming_fallback() {
        let sse = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[",
            "{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"fallback text\"}]},",
            "{\"type\":\"function_call\",\"id\":\"fc_2\",\"call_id\":\"call_2\",\"name\":\"sv_query\",\"arguments\":\"{}\"}",
            "]}}\n\n",
        );
        let step = OpenAiCodexProvider::parse_sse(Cursor::new(sse)).expect("fallback output");
        assert_eq!(step.assistant_text.as_deref(), Some("fallback text"));
        assert_eq!(step.tool_calls[0].id, "call_2|fc_2");
        assert_eq!(step.tool_calls[0].arguments_json, "{}");
    }

    #[test]
    fn sse_without_terminal_event_is_rejected() {
        let sse = "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"partial\"}\n\n";
        let error = OpenAiCodexProvider::parse_sse(Cursor::new(sse))
            .expect_err("missing completion must fail");
        assert!(error.to_string().contains("before response.completed"));
    }
}
