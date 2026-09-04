//! TraeCode CLI provider with a deliberately narrow official CLI boundary.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    AgentError, AgentProvider, AgentStep, ChatMessage, Result, Role, ToolCall, ToolDefinition,
};

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

fn default_timeout_secs() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraeCodeConfig {
    pub model: String,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default)]
    pub executable: Option<PathBuf>,
}

impl TraeCodeConfig {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            executable: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraeLoginStatus {
    pub available: bool,
    pub logged_in: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraeToolCall {
    pub id: String,
    pub tool_name: String,
    pub arguments_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraeCodeOutput {
    #[serde(rename = "assistantText", default)]
    pub assistant_text: Option<String>,
    #[serde(rename = "toolCalls", default)]
    pub tool_calls: Vec<TraeToolCall>,
}

pub struct TraeCodeProvider {
    config: TraeCodeConfig,
}

impl TraeCodeProvider {
    pub fn new(config: TraeCodeConfig) -> Self {
        Self { config }
    }
    pub fn config(&self) -> &TraeCodeConfig {
        &self.config
    }

    pub fn resolve_executable(&self) -> Result<PathBuf> {
        if let Some(path) = &self.config.executable {
            if is_executable(path) {
                return Ok(path.clone());
            }
            return Err(AgentError::new(format!(
                "TraeCode CLI was not found at {}",
                path.display()
            )));
        }
        if let Some(path) = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("traecli"))
                .find(|path| is_executable(path))
        }) {
            return Ok(path);
        }
        if let Some(home) = std::env::var_os("HOME") {
            let path = PathBuf::from(home).join(".local/bin/traecli");
            if is_executable(&path) {
                return Ok(path);
            }
        }
        Err(AgentError::new(
            "TraeCode CLI not found; install traecli or configure its executable path",
        ))
    }

    pub fn login_status(&self) -> Result<TraeLoginStatus> {
        let executable = match self.resolve_executable() {
            Ok(path) => path,
            Err(error) => {
                return Ok(TraeLoginStatus {
                    available: false,
                    logged_in: false,
                    detail: error.to_string(),
                })
            }
        };
        let output = self.run(&executable, &["login", "status"])?;
        let value = serde_json::from_str::<Value>(&output.stdout).ok();
        let logged_in = value
            .as_ref()
            .and_then(|value| value.get("loggedIn").or_else(|| value.get("logged_in")))
            .and_then(Value::as_bool)
            .unwrap_or_else(|| output.stdout.to_ascii_lowercase().contains("logged in"));
        Ok(TraeLoginStatus {
            available: true,
            logged_in,
            detail: if logged_in {
                "TraeCode 已登录".to_string()
            } else {
                "TraeCode 尚未登录".to_string()
            },
        })
    }

    pub fn login(&self) -> Result<TraeLoginStatus> {
        let executable = self.resolve_executable()?;
        self.run(&executable, &["login"])?;
        self.login_status()
    }

    pub fn build_exec_args(
        &self,
        conversation: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Vec<String>> {
        if self.config.model.trim().is_empty() {
            return Err(AgentError::new("TraeCode model id is empty"));
        }
        let schema = json!({ "type": "object", "required": ["assistantText", "toolCalls"], "additionalProperties": false, "properties": { "assistantText": { "type": ["string", "null"] }, "toolCalls": { "type": "array", "items": { "type": "object", "required": ["id", "tool_name", "arguments_json"], "additionalProperties": false, "properties": { "id": { "type": "string" }, "tool_name": { "type": "string" }, "arguments_json": { "type": "string" } } } } } }).to_string();
        let input = json!({ "model": self.config.model, "messages": conversation.iter().map(trae_message).collect::<Result<Vec<_>>>()?, "tools": tools.iter().map(|tool| json!({ "name": tool.name, "description": tool.description, "inputSchema": serde_json::from_str::<Value>(&tool.input_schema_json).unwrap_or_else(|_| json!({ "type": "object" })) })).collect::<Vec<_>>() });
        Ok(vec![
            "exec".into(),
            "--json".into(),
            "--output-schema".into(),
            schema,
            "--ephemeral".into(),
            "--sandbox".into(),
            "read-only".into(),
            "--prompt".into(),
            input.to_string(),
        ])
    }

    pub fn parse_output(text: &str) -> Result<AgentStep> {
        let output: TraeCodeOutput = serde_json::from_str(text)
            .map_err(|error| AgentError::new(format!("Invalid TraeCode JSON output: {error}")))?;
        Ok(AgentStep {
            assistant_text: output.assistant_text,
            tool_calls: output
                .tool_calls
                .into_iter()
                .map(|call| ToolCall {
                    id: call.id,
                    tool_name: call.tool_name,
                    arguments_json: normalize_arguments(&call.arguments_json),
                })
                .collect(),
        })
    }

    fn run(&self, executable: &Path, args: &[&str]) -> Result<BoundedOutput> {
        let owned = args
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>();
        self.run_owned(executable, &owned)
    }

    fn run_owned(&self, executable: &Path, args: &[String]) -> Result<BoundedOutput> {
        let mut child = Command::new(executable)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| AgentError::new(format!("failed to start TraeCode CLI: {error}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::new("TraeCode CLI stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::new("TraeCode CLI stderr unavailable"))?;
        let out_thread = thread::spawn(|| read_bounded(stdout));
        let err_thread = thread::spawn(|| read_bounded(stderr));
        let deadline = Instant::now() + Duration::from_secs(self.config.timeout_secs.max(1));
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| AgentError::new(format!("TraeCode CLI wait failed: {error}")))?
            {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AgentError::new("TraeCode CLI timed out"));
            }
            thread::sleep(Duration::from_millis(20));
        };
        let stdout = out_thread
            .join()
            .map_err(|_| AgentError::new("TraeCode stdout reader failed"))??;
        let stderr = err_thread
            .join()
            .map_err(|_| AgentError::new("TraeCode stderr reader failed"))??;
        if !status.success() {
            return Err(AgentError::new(format!(
                "TraeCode CLI exited with {}: {}",
                status,
                String::from_utf8_lossy(&stderr)
                    .chars()
                    .take(1_200)
                    .collect::<String>()
            )));
        }
        Ok(BoundedOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
        })
    }
}

impl AgentProvider for TraeCodeProvider {
    fn id(&self) -> &str {
        "traecode"
    }
    fn step(&self, conversation: &[ChatMessage], tools: &[ToolDefinition]) -> Result<AgentStep> {
        let executable = self.resolve_executable()?;
        let args = self.build_exec_args(conversation, tools)?;
        Self::parse_output(&self.run_owned(&executable, &args)?.stdout)
    }
}

struct BoundedOutput {
    stdout: String,
}

fn read_bounded<R: Read>(reader: R) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(AgentError::new("TraeCode CLI output exceeded 8 MiB"));
    }
    Ok(bytes)
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
        && (cfg!(windows) || {
            use std::os::unix::fs::PermissionsExt;
            path.metadata()
                .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

fn trae_message(message: &ChatMessage) -> Result<Value> {
    let role = match message.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut value = json!({ "role": role, "content": message.content });
    if let Some(id) = &message.tool_call_id {
        value["toolCallId"] = json!(id);
    }
    if !message.tool_calls.is_empty() {
        value["toolCalls"] = serde_json::to_value(&message.tool_calls).map_err(|error| {
            AgentError::new(format!("serialize TraeCode tool calls failed: {error}"))
        })?;
    }
    Ok(value)
}

fn normalize_arguments(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "{}".to_string())
}
