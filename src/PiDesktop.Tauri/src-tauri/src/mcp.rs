use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::runtime::Handle;
use tokio::sync::Mutex;

use crate::agent::{AgentError, ToolCall, ToolDefinition, ToolExecutor, ToolResult};
use crate::config::McpServerConfig;

mod client;
#[allow(dead_code)]
pub(crate) mod http_client;

use client::{McpServerSpec, McpStdioClient};
use http_client::McpHttpClient;

enum ManagedClient {
    Stdio(Box<McpStdioClient>),
    Http(McpHttpClient),
}

impl ManagedClient {
    async fn initialize(&self, client_name: &str, client_version: &str) -> Result<Value, String> {
        match self {
            Self::Stdio(client) => client
                .initialize(client_name, client_version)
                .await
                .map_err(|error| error.to_string()),
            Self::Http(client) => client.initialize(client_name, client_version).await,
        }
    }

    async fn list_tools(&self) -> Result<Value, String> {
        match self {
            Self::Stdio(client) => client.list_tools().await.map_err(|error| error.to_string()),
            Self::Http(client) => client.list_tools().await,
        }
    }

    async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, String> {
        match self {
            Self::Stdio(client) => client
                .call_tool(name, arguments)
                .await
                .map_err(|error| error.to_string()),
            Self::Http(client) => client.call_tool(name, arguments).await,
        }
    }
}

type SharedClient = Arc<Mutex<ManagedClient>>;

struct ConnectedServer {
    client: SharedClient,
    tools: Vec<McpTool>,
    agent_visible: bool,
}

#[derive(Clone)]
struct McpTool {
    definition: ToolDefinition,
    remote_name: String,
}

#[derive(Clone)]
pub struct McpToolBinding {
    definition: ToolDefinition,
    remote_name: String,
    client: SharedClient,
}

#[derive(Default)]
pub struct McpManager {
    servers: Mutex<HashMap<String, ConnectedServer>>,
    synthv_hosts: Mutex<HashMap<String, String>>,
}

impl McpManager {
    pub async fn ensure_configured(&self, configs: &[McpServerConfig]) -> Result<(), String> {
        for config in configs.iter().filter(|server| server.enabled) {
            if !self.is_connected(&config.id).await {
                self.connect(
                    config.id.clone(),
                    config.name.clone(),
                    McpServerSpec {
                        command: config.command.clone(),
                        args: config.args.clone(),
                        working_dir: None,
                        env: HashMap::new(),
                    },
                )
                .await?;
            }
        }
        Ok(())
    }

    pub async fn connect_bridge(
        &self,
        node: String,
        bridge_dir: PathBuf,
    ) -> Result<Vec<String>, String> {
        self.connect_hidden(
            "synthv".to_string(),
            "SynthV Bridge".to_string(),
            McpServerSpec {
                command: node,
                args: vec!["dist/src/cli.js".to_string()],
                working_dir: Some(bridge_dir),
                env: HashMap::new(),
            },
        )
        .await
    }

    pub async fn test_config(&self, config: &McpServerConfig) -> Result<Vec<String>, String> {
        self.disconnect(&config.id).await;
        self.connect(
            config.id.clone(),
            config.name.clone(),
            McpServerSpec {
                command: config.command.clone(),
                args: config.args.clone(),
                working_dir: None,
                env: HashMap::new(),
            },
        )
        .await
    }

    pub async fn connect_http(
        &self,
        id: String,
        name: String,
        endpoint: String,
    ) -> Result<Vec<String>, String> {
        let client = McpHttpClient::from_endpoint(endpoint)
            .map(ManagedClient::Http)
            .map_err(|error| format!("无法连接 {name}：{error}"))?;
        self.register_client(id, name, client, false).await
    }

    pub async fn connect_stdio_host(
        &self,
        id: String,
        name: String,
        command: String,
        args: Vec<String>,
        working_dir: Option<PathBuf>,
    ) -> Result<Vec<String>, String> {
        self.connect_hidden(
            id,
            name,
            McpServerSpec {
                command,
                args,
                working_dir,
                env: HashMap::new(),
            },
        )
        .await
    }

    async fn connect(
        &self,
        id: String,
        name: String,
        spec: McpServerSpec,
    ) -> Result<Vec<String>, String> {
        self.connect_with_visibility(id, name, spec, true).await
    }

    async fn connect_hidden(
        &self,
        id: String,
        name: String,
        spec: McpServerSpec,
    ) -> Result<Vec<String>, String> {
        self.connect_with_visibility(id, name, spec, false).await
    }

    async fn connect_with_visibility(
        &self,
        id: String,
        name: String,
        spec: McpServerSpec,
        agent_visible: bool,
    ) -> Result<Vec<String>, String> {
        let client = McpStdioClient::start(&spec)
            .map(Box::new)
            .map(ManagedClient::Stdio)
            .map_err(|error| format!("无法启动 {name}：{error}"))?;
        self.register_client(id, name, client, agent_visible).await
    }

    async fn register_client(
        &self,
        id: String,
        name: String,
        client: ManagedClient,
        agent_visible: bool,
    ) -> Result<Vec<String>, String> {
        client
            .initialize("synthv-toolbox", env!("CARGO_PKG_VERSION"))
            .await
            .map_err(|error| format!("{name} MCP 握手失败：{error}"))?;
        let listed = client
            .list_tools()
            .await
            .map_err(|error| format!("{name} 无法列出工具：{error}"))?;
        let tools = parse_tools(&id, &name, &listed);
        if tools.is_empty() {
            return Err(format!("{name} 已连接，但没有暴露任何工具。"));
        }
        let tool_names = tools
            .iter()
            .map(|tool| tool.remote_name.clone())
            .collect::<Vec<_>>();
        self.servers.lock().await.insert(
            id,
            ConnectedServer {
                client: Arc::new(Mutex::new(client)),
                tools,
                agent_visible,
            },
        );
        Ok(tool_names)
    }

    pub async fn disconnect(&self, id: &str) {
        self.servers.lock().await.remove(id);
        self.synthv_hosts
            .lock()
            .await
            .retain(|_, server_id| server_id != id);
    }

    pub async fn is_connected(&self, id: &str) -> bool {
        self.servers.lock().await.contains_key(id)
    }

    pub async fn bind_synthv_host(&self, host_id: String, server_id: String) {
        let mut hosts = self.synthv_hosts.lock().await;
        hosts.retain(|bound_host, bound_server| {
            bound_host != &host_id && bound_server != &server_id
        });
        hosts.insert(host_id, server_id);
    }

    pub async fn synthv_server_id(&self, host_id: &str) -> Option<String> {
        self.synthv_hosts.lock().await.get(host_id).cloned()
    }

    pub async fn connected_synthv_hosts(&self) -> HashMap<String, String> {
        self.synthv_hosts.lock().await.clone()
    }

    pub async fn call_server_tool(
        &self,
        server_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let client = {
            let servers = self.servers.lock().await;
            servers
                .get(server_id)
                .map(|server| server.client.clone())
                .ok_or_else(|| format!("SynthV 宿主 {server_id} 尚未连接。"))?
        };
        let result = client.lock().await.call_tool(name, arguments).await;
        result
    }

    pub async fn bindings(&self) -> Vec<McpToolBinding> {
        let servers = self.servers.lock().await;
        servers
            .values()
            .filter(|server| server.agent_visible)
            .flat_map(|server| {
                server.tools.iter().map(|tool| McpToolBinding {
                    definition: tool.definition.clone(),
                    remote_name: tool.remote_name.clone(),
                    client: server.client.clone(),
                })
            })
            .collect()
    }

    /// Call one of the six public SynthV Bridge tools from a dedicated Toolbox
    /// workflow. This deliberately does not expose an arbitrary MCP command to
    /// the frontend: callers still choose a fixed public tool and construct a
    /// bounded action payload in Rust.
    pub async fn call_bridge_tool(&self, name: &str, arguments: Value) -> Result<Value, String> {
        if !matches!(
            name,
            "sv_status" | "sv_describe" | "sv_query" | "sv_command" | "sv_ui" | "sv_review"
        ) {
            return Err("专用工作流只能调用 SynthV Bridge 的公开六工具接口。".to_string());
        }
        let response = self
            .call_server_tool("synthv", name, arguments)
            .await
            .map_err(|error| format!("SynthV Bridge 调用失败：{error}"))?;
        if response
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(extract_mcp_text(&response)
                .unwrap_or_else(|| "SynthV Bridge 返回了错误。".to_string()));
        }
        Ok(response)
    }
}

pub fn extract_mcp_json(value: &Value) -> Result<Value, String> {
    let text = extract_mcp_text(value)
        .ok_or_else(|| "SynthV Bridge 没有返回可解析的文本结果。".to_string())?;
    serde_json::from_str(&text).map_err(|error| format!("SynthV Bridge 结果不是有效 JSON：{error}"))
}

fn extract_mcp_text(value: &Value) -> Option<String> {
    value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|item| {
            (item.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                .flatten()
        })
}

pub struct McpToolExecutor {
    bindings: Vec<McpToolBinding>,
    runtime: Handle,
}

impl McpToolExecutor {
    pub fn new(bindings: Vec<McpToolBinding>, runtime: Handle) -> Self {
        Self { bindings, runtime }
    }
}

impl ToolExecutor for McpToolExecutor {
    fn tools(&self) -> Vec<ToolDefinition> {
        self.bindings
            .iter()
            .map(|binding| binding.definition.clone())
            .collect()
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, AgentError> {
        let Some(binding) = self
            .bindings
            .iter()
            .find(|binding| binding.definition.name == call.tool_name)
        else {
            return Ok(error_result(call, "没有匹配的 MCP 工具"));
        };
        let arguments = serde_json::from_str(&call.arguments_json).unwrap_or_else(|_| json!({}));
        let response = self.runtime.block_on(async {
            let client = binding.client.lock().await;
            client.call_tool(&binding.remote_name, arguments).await
        });
        match response {
            Ok(value) => {
                let is_error = value
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Ok(ToolResult {
                    tool_call_id: call.id.clone(),
                    result_json: value.to_string(),
                    is_error,
                })
            }
            Err(error) => Ok(error_result(call, &error.to_string())),
        }
    }
}

fn error_result(call: &ToolCall, message: &str) -> ToolResult {
    ToolResult {
        tool_call_id: call.id.clone(),
        result_json: json!({ "error": message }).to_string(),
        is_error: true,
    }
}

fn parse_tools(id: &str, server_name: &str, value: &Value) -> Vec<McpTool> {
    value
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let remote_name = tool.get("name")?.as_str()?.to_string();
            let public_name = if id == "synthv" {
                remote_name.clone()
            } else {
                namespaced_tool_name(id, &remote_name)
            };
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("MCP tool");
            let schema = tool
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object" }));
            Some(McpTool {
                definition: ToolDefinition {
                    name: public_name,
                    description: format!("[{server_name}] {description}"),
                    input_schema_json: schema.to_string(),
                },
                remote_name,
            })
        })
        .collect()
}

fn namespaced_tool_name(id: &str, remote_name: &str) -> String {
    let clean = |value: &str| {
        value
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>()
    };
    let mut name = format!("mcp_{}_{}", clean(id), clean(remote_name));
    name.truncate(64);
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_tool_names_are_sanitized_and_bounded() {
        let name = namespaced_tool_name("my.server", &"tool name/with spaces".repeat(8));
        assert!(name.starts_with("mcp_my_server_"));
        assert!(name.len() <= 64);
        assert!(name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-')));
    }

    #[test]
    fn synthv_tools_keep_their_stable_public_names() {
        let listed = json!({
            "tools": [{
                "name": "sv_status",
                "description": "Read status",
                "inputSchema": { "type": "object" }
            }]
        });
        let tools = parse_tools("synthv", "SynthV Bridge", &listed);
        assert_eq!(tools[0].definition.name, "sv_status");
        assert_eq!(tools[0].remote_name, "sv_status");
    }
}
