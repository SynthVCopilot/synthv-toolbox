use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::agent_runtime::{
    CapabilityDescriptor, CapabilityHandler, HostHello, RpcError, RuntimeCommand, RuntimeHello,
    VersionRange, PROTOCOL_VERSION,
};
use crate::state::AppState;

const HOST_ID: &str = "synthv-toolbox.native-host";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    running: bool,
    protocol_version: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityInvocation {
    permission: String,
    capability: String,
    operation: String,
    #[serde(default)]
    params: Value,
}

#[tauri::command]
pub async fn get_agent_runtime_status(
    state: State<'_, AppState>,
) -> Result<AgentRuntimeStatus, String> {
    Ok(AgentRuntimeStatus {
        running: state.agent_runtime.is_running().await,
        protocol_version: PROTOCOL_VERSION,
    })
}

#[tauri::command]
pub async fn start_agent_runtime(state: State<'_, AppState>) -> Result<RuntimeHello, String> {
    if state.agent_runtime.is_running().await {
        return Err("Agent Runtime 已经在运行。".to_string());
    }

    register_host_capabilities(&state).await;
    let entrypoint = runtime_entrypoint(&state.resource_dir)?;
    let node = crate::synthv::find_node()
        .ok_or_else(|| "未找到可运行 Agent Runtime 的 Node.js。".to_string())?;
    let current_dir = entrypoint.parent().map(Path::to_path_buf);
    let command = RuntimeCommand {
        program: PathBuf::from(node),
        args: vec![entrypoint.to_string_lossy().into_owned()],
        current_dir,
    };
    state
        .agent_runtime
        .start(command, host_hello())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stop_agent_runtime(state: State<'_, AppState>) -> Result<(), String> {
    if !state.agent_runtime.is_running().await {
        return Ok(());
    }
    state
        .agent_runtime
        .shutdown()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn discover_agent_plugins(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    if !state.agent_runtime.is_running().await {
        start_agent_runtime(state.clone()).await?;
    }
    let root = crate::agent::data_root().join("plugins");
    std::fs::create_dir_all(&root).map_err(|error| format!("无法创建插件目录：{error}"))?;
    let result = state
        .agent_runtime
        .request(
            "runtime.plugins.discover",
            json!({ "root": root.to_string_lossy() }),
        )
        .await
        .map_err(|error| error.to_string())?;
    result
        .get("plugins")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Agent Runtime 返回了无效的插件列表。".to_string())
}

#[tauri::command]
pub async fn invoke_agent_plugin(
    plugin_id: String,
    method: String,
    params: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !state.agent_runtime.is_running().await {
        return Err("Agent Runtime 尚未运行。".to_string());
    }
    state
        .agent_runtime
        .request(
            "runtime.plugin.invoke",
            json!({ "pluginId": plugin_id, "method": method, "params": params }),
        )
        .await
        .map_err(|error| error.to_string())
}

fn runtime_entrypoint(resource_dir: &Path) -> Result<PathBuf, String> {
    let bundled = resource_dir.join("agent-runtime").join("worker.js");
    if bundled.is_file() {
        return Ok(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/agent-runtime/dist/worker.js");
    if development.is_file() {
        return Ok(development);
    }
    Err("Agent Runtime 尚未构建。请先构建 packages/agent-runtime。".to_string())
}

fn host_hello() -> HostHello {
    HostHello {
        host_id: HOST_ID.to_string(),
        protocol: VersionRange::exact(PROTOCOL_VERSION),
        capabilities: vec![
            capability(
                "synthv.engine",
                crate::synthv_unified::TOOL_NAMES.iter().copied(),
            ),
            capability("synthv.instances", ["list"]),
            capability(
                "synthv.accounts",
                ["state", "precheck", "activate", "launch"],
            ),
        ],
    }
}

fn capability<'a>(id: &str, operations: impl IntoIterator<Item = &'a str>) -> CapabilityDescriptor {
    CapabilityDescriptor {
        id: id.to_string(),
        version: PROTOCOL_VERSION.to_string(),
        operations: operations.into_iter().map(str::to_string).collect(),
    }
}

async fn register_host_capabilities(state: &AppState) {
    let mcp = state.mcp.clone();
    let bridge_dir = state.bridge_dir.clone();
    let profiles = state.sv2_profiles.clone();
    let handler: CapabilityHandler = Arc::new(move |params| {
        let mcp = mcp.clone();
        let bridge_dir = bridge_dir.clone();
        let profiles = profiles.clone();
        Box::pin(async move {
            let invocation = serde_json::from_value::<CapabilityInvocation>(params)
                .map_err(|error| rpc_error("invalid_capability_request", error.to_string()))?;
            match invocation.capability.as_str() {
                "synthv.engine" => {
                    let writes = crate::synthv_unified::is_mutation(&invocation.operation)
                        || matches!(
                            invocation.operation.as_str(),
                            "synthv_connect" | "synthv_disconnect" | "synthv_export"
                        );
                    require_permission(
                        &invocation.permission,
                        if writes { "host.execute" } else { "host.read" },
                    )?;
                    crate::synthv_unified::execute(
                        &invocation.operation,
                        &invocation.params.to_string(),
                        &mcp,
                        &bridge_dir,
                    )
                    .await
                    .map_err(|error| rpc_error("synthv_error", error))
                }
                "synthv.instances" if invocation.operation == "list" => {
                    require_permission(&invocation.permission, "host.read")?;
                    serde_json::to_value(
                        crate::synthv_control::list_processes()
                            .map_err(|error| rpc_error("synthv_instance_error", error))?,
                    )
                    .map_err(|error| rpc_error("serialization_error", error.to_string()))
                }
                "synthv.accounts" => {
                    let is_write = matches!(invocation.operation.as_str(), "activate" | "launch");
                    require_permission(
                        &invocation.permission,
                        if is_write {
                            "host.execute"
                        } else {
                            "host.read"
                        },
                    )?;
                    let slot_id = invocation
                        .params
                        .get("slotId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let value = match invocation.operation.as_str() {
                        "state" => serde_json::to_value(
                            profiles
                                .state()
                                .map_err(|error| rpc_error("account_state_error", error))?,
                        ),
                        "precheck" => serde_json::to_value(
                            profiles
                                .account_precheck()
                                .map_err(|error| rpc_error("account_precheck_error", error))?,
                        ),
                        "activate" if !slot_id.is_empty() => serde_json::to_value(
                            profiles
                                .activate_slot(slot_id)
                                .map_err(|error| rpc_error("account_activate_error", error))?,
                        ),
                        "launch" if !slot_id.is_empty() => serde_json::to_value(
                            profiles
                                .launch_slot(slot_id, None)
                                .map_err(|error| rpc_error("account_launch_error", error))?,
                        ),
                        _ => {
                            return Err(rpc_error(
                                "unsupported_operation",
                                "不支持的账号能力操作或缺少 slotId。",
                            ));
                        }
                    };
                    value.map_err(|error| rpc_error("serialization_error", error.to_string()))
                }
                _ => Err(rpc_error(
                    "capability_not_available",
                    format!(
                        "未知宿主能力：{}/{}",
                        invocation.capability, invocation.operation
                    ),
                )),
            }
        })
    });
    state
        .agent_runtime
        .register_capability("host.capability.invoke", handler)
        .await;
}

fn require_permission(actual: &str, required: &str) -> Result<(), RpcError> {
    if actual == required || (required == "host.read" && actual == "host.execute") {
        Ok(())
    } else {
        Err(rpc_error(
            "permission_denied",
            format!("该操作需要 {required} 权限。"),
        ))
    }
}

fn rpc_error(code: &str, message: impl Into<String>) -> RpcError {
    RpcError {
        code: code.to_string(),
        message: message.into(),
        data: None,
    }
}
