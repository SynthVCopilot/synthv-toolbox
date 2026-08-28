use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use pi_agent_core::{PiError, ToolCall, ToolDefinition, ToolExecutor, ToolResult};
use pi_agent_mcp::{McpServerSpec, McpStdioClient};
use serde_json::{json, Value};
use tokio::runtime::Handle;
use tokio::sync::Mutex;

use crate::config::McpServerConfig;

type SharedClient = Arc<Mutex<McpStdioClient>>;

struct ConnectedServer {
    client: SharedClient,
    tools: Vec<McpTool>,
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
        self.connect(
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

    async fn connect(
        &self,
        id: String,
        name: String,
        spec: McpServerSpec,
    ) -> Result<Vec<String>, String> {
        let client =
            McpStdioClient::start(&spec).map_err(|error| format!("无法启动 {name}：{error}"))?;
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
            },
        );
        Ok(tool_names)
    }

    pub async fn disconnect(&self, id: &str) {
        self.servers.lock().await.remove(id);
    }

    pub async fn is_connected(&self, id: &str) -> bool {
        self.servers.lock().await.contains_key(id)
    }

    pub async fn bindings(&self) -> Vec<McpToolBinding> {
        let servers = self.servers.lock().await;
        servers
            .values()
            .flat_map(|server| {
                server.tools.iter().map(|tool| McpToolBinding {
                    definition: tool.definition.clone(),
                    remote_name: tool.remote_name.clone(),
                    client: server.client.clone(),
                })
            })
            .collect()
    }
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

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, PiError> {
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
