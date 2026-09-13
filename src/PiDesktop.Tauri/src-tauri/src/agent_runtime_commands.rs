use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
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
    plugin_id: String,
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
    start_agent_runtime_inner(state.inner()).await
}

pub(crate) async fn ensure_agent_runtime(state: &AppState) -> Result<(), String> {
    if state.agent_runtime.is_running().await {
        return Ok(());
    }
    start_agent_runtime_inner(state).await.map(|_| ())
}

async fn start_agent_runtime_inner(state: &AppState) -> Result<RuntimeHello, String> {
    register_host_capabilities(state).await;
    let entrypoint = runtime_entrypoint(&state.resource_dir)?;
    let node = crate::bundled_node::node_binary_from_resource_dir(&state.resource_dir);
    if !node.is_file() {
        return Err("当前应用包未包含受控 Node.js 运行时。".to_string());
    }
    let current_dir = entrypoint.parent().map(Path::to_path_buf);
    let command = RuntimeCommand {
        program: node,
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
    let settings = state.settings.read().await;
    let enabled_plugin_ids = crate::plugin_manager::runnable_plugin_ids(
        &root,
        settings.plugin_internal_functions_enabled,
        settings.plugin_advanced_functions_enabled,
    )?;
    drop(settings);
    let result = state
        .agent_runtime
        .request(
            "runtime.plugins.discover",
            json!({ "root": root.to_string_lossy(), "enabledPluginIds": enabled_plugin_ids }),
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
pub fn list_installed_plugins() -> Result<Vec<crate::plugin_manager::InstalledPlugin>, String> {
    crate::plugin_manager::list(&crate::plugin_manager::plugins_root())
}

#[tauri::command]
pub fn install_agent_plugin(
    source_path: String,
) -> Result<crate::plugin_manager::InstalledPlugin, String> {
    crate::plugin_manager::install(
        Path::new(&source_path),
        &crate::plugin_manager::plugins_root(),
    )
}

#[tauri::command]
pub async fn set_agent_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<crate::plugin_manager::InstalledPlugin, String> {
    let settings = state.settings.read().await;
    crate::plugin_manager::set_enabled(
        &crate::plugin_manager::plugins_root(),
        &plugin_id,
        enabled,
        settings.plugin_internal_functions_enabled,
        settings.plugin_advanced_functions_enabled,
    )
}

#[tauri::command]
pub async fn set_agent_plugin_internal_functions_enabled(
    plugin_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<crate::plugin_manager::InstalledPlugin, String> {
    if enabled
        && !state
            .settings
            .read()
            .await
            .plugin_internal_functions_enabled
    {
        return Err("请先在设置中启用插件内部函数使用。".to_string());
    }
    crate::plugin_manager::set_internal_functions_enabled(
        &crate::plugin_manager::plugins_root(),
        &plugin_id,
        enabled,
    )
}

#[tauri::command]
pub async fn set_agent_plugin_advanced_functions_enabled(
    plugin_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<crate::plugin_manager::InstalledPlugin, String> {
    if enabled
        && !state
            .settings
            .read()
            .await
            .plugin_advanced_functions_enabled
    {
        return Err("请先在设置中启用插件高级功能使用。".to_string());
    }
    crate::plugin_manager::set_advanced_functions_enabled(
        &crate::plugin_manager::plugins_root(),
        &plugin_id,
        enabled,
    )
}

#[tauri::command]
pub fn uninstall_agent_plugin(plugin_id: String) -> Result<(), String> {
    crate::plugin_manager::uninstall(&crate::plugin_manager::plugins_root(), &plugin_id)
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
                [
                    "state",
                    "precheck",
                    "activate",
                    "force-activate",
                    "recover-switch",
                    "clear-local-session",
                    "clear-offline-license-cache",
                    "launch",
                    "force-launch",
                ],
            ),
            capability(
                "synthv.diagnostics",
                [
                    "cached-state",
                    "account-usage",
                    "account-usage-for-slot",
                    "voice-catalog",
                ],
            ),
            capability("synthv.paths", ["slot-folder", "sandbox-folder"]),
            capability("runtime.internal", ["status"]),
            capability("synthv.sandbox", ["prepare", "remove"]),
            capability("synthv.authorization", ["set-enabled"]),
            capability("host.network", ["request"]),
            capability(
                "host.filesystem",
                [
                    "read",
                    "write",
                    "list",
                    "metadata",
                    "create-directory",
                    "copy",
                    "move",
                    "remove",
                ],
            ),
            capability("host.model", ["resolve"]),
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
    let settings = state.settings.clone();
    let agent_runtime = state.agent_runtime.clone();
    let handler: CapabilityHandler = Arc::new(move |params| {
        let mcp = mcp.clone();
        let bridge_dir = bridge_dir.clone();
        let profiles = profiles.clone();
        let settings = settings.clone();
        let agent_runtime = agent_runtime.clone();
        Box::pin(async move {
            let invocation = serde_json::from_value::<CapabilityInvocation>(params)
                .map_err(|error| rpc_error("invalid_capability_request", error.to_string()))?;
            if invocation.plugin_id.is_empty() {
                return Err(rpc_error(
                    "invalid_capability_request",
                    "宿主能力调用缺少插件标识。",
                ));
            }
            let feature_settings = settings.read().await;
            crate::plugin_manager::authorize_capability(
                &crate::plugin_manager::plugins_root(),
                &invocation.plugin_id,
                &invocation.permission,
                feature_settings.plugin_internal_functions_enabled,
                feature_settings.plugin_advanced_functions_enabled,
            )
            .map_err(|error| rpc_error("permission_denied", error))?;
            drop(feature_settings);
            if matches!(
                invocation.permission.as_str(),
                "host.internal" | "host.advanced"
            ) {
                return invoke_privileged_host_capability(
                    &invocation.permission,
                    &invocation.capability,
                    &invocation.operation,
                    invocation.params,
                    mcp,
                    bridge_dir,
                    profiles,
                    settings,
                    agent_runtime,
                )
                .await
                .map_err(|error| rpc_error("host_capability_error", error));
            }
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
                    let required_permission = match invocation.operation.as_str() {
                        "activate"
                        | "force-activate"
                        | "recover-switch"
                        | "clear-local-session"
                        | "clear-offline-license-cache"
                        | "force-launch" => "host.internal",
                        "launch" => "host.execute",
                        "state" | "precheck" => "host.read",
                        _ => {
                            return Err(rpc_error(
                                "unsupported_operation",
                                "不支持的账号能力操作。",
                            ));
                        }
                    };
                    require_permission(&invocation.permission, required_permission)?;
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
                        "activate" => serde_json::to_value(
                            profiles
                                .activate_slot(required_slot_id(&invocation.params)?)
                                .map_err(|error| rpc_error("account_activate_error", error))?,
                        ),
                        "force-activate" => serde_json::to_value(
                            profiles
                                .force_activate_slot(required_slot_id(&invocation.params)?)
                                .map_err(|error| rpc_error("account_activate_error", error))?,
                        ),
                        "recover-switch" => serde_json::to_value(
                            profiles
                                .recover_slot_switch()
                                .map_err(|error| rpc_error("account_recovery_error", error))?,
                        ),
                        "clear-local-session" => serde_json::to_value(
                            profiles
                                .clear_local_session(required_slot_id(&invocation.params)?)
                                .map_err(|error| rpc_error("account_session_error", error))?,
                        ),
                        "clear-offline-license-cache" => serde_json::to_value(
                            profiles
                                .clear_offline_license_cache(required_slot_id(&invocation.params)?)
                                .map_err(|error| rpc_error("account_license_error", error))?,
                        ),
                        "launch" => serde_json::to_value(
                            profiles
                                .launch_slot(
                                    required_slot_id(&invocation.params)?,
                                    optional_string_param(&invocation.params, "projectPath")?,
                                )
                                .map_err(|error| rpc_error("account_launch_error", error))?,
                        ),
                        "force-launch" => serde_json::to_value(
                            profiles
                                .force_launch_slot(
                                    required_slot_id(&invocation.params)?,
                                    optional_string_param(&invocation.params, "projectPath")?,
                                )
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
                "synthv.diagnostics" => {
                    require_permission(&invocation.permission, "host.internal")?;
                    let profiles = profiles.clone();
                    let params = invocation.params.clone();
                    let operation = invocation.operation.clone();
                    tauri::async_runtime::spawn_blocking(move || match operation.as_str() {
                        "cached-state" => serde_json::to_value(
                            profiles
                                .cached_state()
                                .map_err(|error| rpc_error("diagnostics_error", error))?,
                        )
                        .map_err(|error| rpc_error("serialization_error", error.to_string())),
                        "account-usage" => serde_json::to_value(
                            profiles
                                .account_usage_snapshot()
                                .map_err(|error| rpc_error("diagnostics_error", error))?,
                        )
                        .map_err(|error| rpc_error("serialization_error", error.to_string())),
                        "account-usage-for-slot" => serde_json::to_value(
                            profiles
                                .account_usage_snapshot_for_slot(required_slot_id(&params)?)
                                .map_err(|error| rpc_error("diagnostics_error", error))?,
                        )
                        .map_err(|error| rpc_error("serialization_error", error.to_string())),
                        "voice-catalog" => serde_json::to_value(
                            profiles
                                .voice_catalog()
                                .map_err(|error| rpc_error("diagnostics_error", error))?,
                        )
                        .map_err(|error| rpc_error("serialization_error", error.to_string())),
                        _ => Err(rpc_error("unsupported_operation", "不支持的诊断能力操作。")),
                    })
                    .await
                    .map_err(|error| rpc_error("diagnostics_error", error.to_string()))?
                }
                "synthv.paths" => {
                    require_permission(&invocation.permission, "host.internal")?;
                    let slot_id = required_slot_id(&invocation.params)?;
                    let profiles = profiles.clone();
                    let operation = invocation.operation.clone();
                    let path =
                        tauri::async_runtime::spawn_blocking(move || match operation.as_str() {
                            "slot-folder" => profiles.slot_folder_path(slot_id),
                            "sandbox-folder" => profiles.sandbox_folder_path(slot_id),
                            _ => Err("不支持的路径能力操作。".to_string()),
                        })
                        .await
                        .map_err(|error| rpc_error("path_error", error.to_string()))?
                        .map_err(|error| rpc_error("path_error", error))?;
                    Ok(json!({ "path": path }))
                }
                "runtime.internal" if invocation.operation == "status" => {
                    require_permission(&invocation.permission, "host.internal")?;
                    Ok(json!({
                        "running": agent_runtime.is_running().await,
                        "protocolVersion": PROTOCOL_VERSION,
                    }))
                }
                "synthv.sandbox"
                    if matches!(invocation.operation.as_str(), "prepare" | "remove") =>
                {
                    require_permission(&invocation.permission, "host.advanced")?;
                    let slot_id = invocation
                        .params
                        .get("slotId")
                        .and_then(Value::as_str)
                        .filter(|slot_id| !slot_id.is_empty())
                        .ok_or_else(|| {
                            rpc_error("invalid_capability_request", "沙箱操作需要 slotId。")
                        })?
                        .to_string();
                    let operation = invocation.operation.clone();
                    tauri::async_runtime::spawn_blocking(move || match operation.as_str() {
                        "prepare" => profiles.prepare_concurrent_slot(slot_id),
                        "remove" => profiles.remove_concurrent_slot(slot_id),
                        _ => unreachable!(),
                    })
                    .await
                    .map_err(|error| rpc_error("sandbox_error", error.to_string()))?
                    .map_err(|error| rpc_error("sandbox_error", error))
                    .and_then(|value| {
                        serde_json::to_value(value)
                            .map_err(|error| rpc_error("serialization_error", error.to_string()))
                    })
                }
                "synthv.authorization" if invocation.operation == "set-enabled" => {
                    require_permission(&invocation.permission, "host.advanced")?;
                    let credential_id = invocation
                        .params
                        .get("credentialId")
                        .and_then(Value::as_str)
                        .filter(|credential_id| !credential_id.is_empty())
                        .ok_or_else(|| {
                            rpc_error(
                                "invalid_capability_request",
                                "授权信息操作需要 credentialId。",
                            )
                        })?;
                    let enabled = invocation
                        .params
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| {
                            rpc_error("invalid_capability_request", "授权信息操作需要 enabled。")
                        })?;
                    set_credential_enabled(&settings, credential_id, enabled)
                        .await
                        .map_err(|error| rpc_error("authorization_error", error))
                }
                "host.network" if invocation.operation == "request" => {
                    require_permission(&invocation.permission, "host.advanced")?;
                    unrestricted_network_request(&invocation.params)
                        .await
                        .map_err(|error| rpc_error("network_error", error))
                }
                "host.filesystem" => {
                    require_permission(&invocation.permission, "host.advanced")?;
                    unrestricted_filesystem_request(&invocation.operation, &invocation.params)
                        .map_err(|error| rpc_error("filesystem_error", error))
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
    let settings = state.settings.clone();
    let model_handler: CapabilityHandler = Arc::new(move |_params| {
        let settings = settings.clone();
        Box::pin(async move {
            crate::commands::runtime_model_selection(&settings)
                .await
                .map_err(|message| rpc_error("model_unavailable", message))
        })
    });
    state
        .agent_runtime
        .register_capability("host.model.resolve", model_handler)
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

pub(crate) async fn invoke_privileged_host_capability(
    permission: &str,
    capability: &str,
    operation: &str,
    params: Value,
    mcp: Arc<crate::mcp::McpManager>,
    bridge_dir: PathBuf,
    profiles: Arc<crate::sv2_profiles::Sv2ProfileService>,
    settings: Arc<tokio::sync::RwLock<crate::config::ToolboxSettings>>,
    agent_runtime: Arc<crate::agent_runtime::AgentRuntime>,
) -> Result<Value, String> {
    let denied = || Err("该特权工具不能调用指定宿主能力。".to_string());
    match (permission, capability, operation) {
        ("host.internal", "synthv.accounts", "activate") => serde_json::to_value(
            profiles
                .activate_slot(required_slot_id(&params).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.accounts", "force-activate") => serde_json::to_value(
            profiles
                .force_activate_slot(required_slot_id(&params).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.accounts", "recover-switch") => serde_json::to_value(
            profiles
                .recover_slot_switch()
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.accounts", "clear-local-session") => serde_json::to_value(
            profiles
                .clear_local_session(required_slot_id(&params).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.accounts", "clear-offline-license-cache") => {
            serde_json::to_value(
                profiles
                    .clear_offline_license_cache(
                        required_slot_id(&params).map_err(|error| error.message)?,
                    )
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        ("host.internal", "synthv.accounts", "force-launch") => serde_json::to_value(
            profiles
                .force_launch_slot(
                    required_slot_id(&params).map_err(|error| error.message)?,
                    optional_string_param(&params, "projectPath").map_err(|error| error.message)?,
                )
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.diagnostics", "cached-state") => {
            serde_json::to_value(profiles.cached_state().map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        }
        ("host.internal", "synthv.diagnostics", "account-usage") => serde_json::to_value(
            profiles
                .account_usage_snapshot()
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.diagnostics", "account-usage-for-slot") => serde_json::to_value(
            profiles
                .account_usage_snapshot_for_slot(
                    required_slot_id(&params).map_err(|error| error.message)?,
                )
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.diagnostics", "voice-catalog") => serde_json::to_value(
            profiles
                .voice_catalog()
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.internal", "synthv.paths", "slot-folder") => Ok(json!({
            "path": profiles.slot_folder_path(required_slot_id(&params).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?
        })),
        ("host.internal", "synthv.paths", "sandbox-folder") => Ok(json!({
            "path": profiles.sandbox_folder_path(required_slot_id(&params).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?
        })),
        ("host.internal", "runtime.internal", "status") => Ok(json!({
            "running": agent_runtime.is_running().await,
            "protocolVersion": PROTOCOL_VERSION,
        })),
        ("host.advanced", "synthv.sandbox", "prepare") => serde_json::to_value(
            profiles
                .prepare_concurrent_slot(required_slot_id(&params).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.advanced", "synthv.sandbox", "remove") => serde_json::to_value(
            profiles
                .remove_concurrent_slot(required_slot_id(&params).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string()),
        ("host.advanced", "synthv.authorization", "set-enabled") => {
            let credential_id = params
                .get("credentialId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "授权信息操作需要 credentialId。".to_string())?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| "授权信息操作需要 enabled。".to_string())?;
            set_credential_enabled(&settings, credential_id, enabled).await
        }
        ("host.advanced", "host.network", "request") => unrestricted_network_request(&params).await,
        ("host.advanced", "host.filesystem", operation) => {
            unrestricted_filesystem_request(operation, &params)
        }
        _ => {
            let _ = (mcp, bridge_dir);
            denied()
        }
    }
}

fn required_slot_id(params: &Value) -> Result<String, RpcError> {
    params
        .get("slotId")
        .and_then(Value::as_str)
        .filter(|slot_id| !slot_id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| rpc_error("invalid_capability_request", "该操作需要有效的 slotId。"))
}

fn optional_string_param(params: &Value, key: &str) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(rpc_error(
            "invalid_capability_request",
            format!("{key} 必须是非空字符串。"),
        )),
    }
}

async fn set_credential_enabled(
    settings: &tokio::sync::RwLock<crate::config::ToolboxSettings>,
    credential_id: &str,
    enabled: bool,
) -> Result<Value, String> {
    let mut settings = settings.write().await;
    let mut next = settings.clone();
    let mut matches = 0usize;
    for account in &mut next.oauth_accounts {
        if account.id == credential_id {
            account.enabled = enabled;
            matches += 1;
        }
    }
    for provider in [
        crate::oauth::AiProviderId::Anthropic,
        crate::oauth::AiProviderId::OpenaiCodex,
    ] {
        let mut keys = next.api_keys_for(provider).to_vec();
        for key in &mut keys {
            if key.id == credential_id {
                key.enabled = enabled;
                matches += 1;
            }
        }
        next.set_api_keys_for(provider, keys);
    }
    if matches != 1 {
        return Err(if matches == 0 {
            "没有找到该凭据。".to_string()
        } else {
            "凭据标识不唯一，拒绝修改。".to_string()
        });
    }
    crate::config::save_settings(&next)?;
    *settings = next;
    Ok(json!({ "credentialId": credential_id, "enabled" : enabled }))
}

pub async fn unrestricted_network_request(params: &Value) -> Result<Value, String> {
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| "联网请求需要 url。".to_string())?;
    let method = params
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .parse::<reqwest::Method>()
        .map_err(|_| "联网请求 method 无效。".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            attempt.follow()
        }))
        .build()
        .map_err(|_| "无法创建联网请求客户端。".to_string())?;
    let mut request = client.request(method, url);
    if let Some(headers) = params.get("headers") {
        let headers = headers
            .as_object()
            .ok_or_else(|| "联网请求 headers 必须是对象。".to_string())?;
        for (name, value) in headers {
            let value = value
                .as_str()
                .ok_or_else(|| "联网请求 header 值必须是字符串。".to_string())?;
            request = request.header(name, value);
        }
    }
    let body = match (params.get("body"), params.get("bodyBase64")) {
        (Some(_), Some(_)) => return Err("联网请求 body 与 bodyBase64 不能同时提供。".to_string()),
        (Some(body), None) => match body {
            Value::String(value) => value.as_bytes().to_vec(),
            value => serde_json::to_vec(value)
                .map_err(|error| format!("联网请求 body 无法编码：{error}"))?,
        },
        (None, Some(Value::String(body))) => base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|_| "联网请求 bodyBase64 无效。".to_string())?,
        (None, Some(_)) => return Err("联网请求 bodyBase64 必须是字符串。".to_string()),
        (None, None) => Vec::new(),
    };
    if !body.is_empty() {
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "联网请求失败。".to_string())?;
    let status = response.status().as_u16();
    let mut headers = serde_json::Map::new();
    for (name, value) in response.headers() {
        let name = name.as_str().to_string();
        let value = value.to_str().unwrap_or_default().to_string();
        match headers.get_mut(&name) {
            Some(Value::Array(values)) => values.push(Value::String(value)),
            Some(existing) => {
                let previous = std::mem::replace(existing, Value::Array(Vec::new()));
                *existing = Value::Array(vec![previous, Value::String(value)]);
            }
            None => {
                headers.insert(name, Value::String(value));
            }
        }
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "联网响应读取失败。".to_string())?;
    Ok(json!({
        "status": status,
        "headers": headers,
        "body": String::from_utf8_lossy(&body),
        "bodyBase64": base64::engine::general_purpose::STANDARD.encode(body),
    }))
}

pub fn unrestricted_filesystem_request(operation: &str, params: &Value) -> Result<Value, String> {
    match operation {
        "read" => {
            let path = filesystem_path(params, "path")?;
            let bytes = fs::read(&path).map_err(|error| format!("读取文件失败：{error}"))?;
            Ok(filesystem_content_response(
                &path,
                bytes,
                filesystem_encoding(params)?,
            ))
        }
        "write" => {
            let path = filesystem_path(params, "path")?;
            let bytes = filesystem_content(params)?;
            fs::write(&path, bytes).map_err(|error| format!("写入文件失败：{error}"))?;
            Ok(filesystem_metadata_response(&path)?)
        }
        "list" => {
            let path = filesystem_path(params, "path")?;
            let mut entries = fs::read_dir(&path)
                .map_err(|error| format!("列出目录失败：{error}"))?
                .map(|entry| entry.map_err(|error| format!("读取目录项失败：{error}")))
                .collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.file_name());
            let entries = entries
                .into_iter()
                .map(|entry| filesystem_metadata_response(&entry.path()))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "path": path, "entries": entries }))
        }
        "metadata" => filesystem_metadata_response(&filesystem_path(params, "path")?),
        "create-directory" => {
            let path = filesystem_path(params, "path")?;
            if params
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                fs::create_dir_all(&path).map_err(|error| format!("创建目录失败：{error}"))?;
            } else {
                fs::create_dir(&path).map_err(|error| format!("创建目录失败：{error}"))?;
            }
            filesystem_metadata_response(&path)
        }
        "copy" => {
            let source = filesystem_path(params, "sourcePath")?;
            let destination = filesystem_path(params, "destinationPath")?;
            copy_filesystem_path(&source, &destination)?;
            filesystem_metadata_response(&destination)
        }
        "move" => {
            let source = filesystem_path(params, "sourcePath")?;
            let destination = filesystem_path(params, "destinationPath")?;
            if fs::rename(&source, &destination).is_err() {
                copy_filesystem_path(&source, &destination)?;
                remove_filesystem_path(&source, true)?;
            }
            filesystem_metadata_response(&destination)
        }
        "remove" => {
            let path = filesystem_path(params, "path")?;
            remove_filesystem_path(
                &path,
                params
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )?;
            Ok(json!({ "path": path, "removed": true }))
        }
        _ => Err("不支持的文件系统操作。".to_string()),
    }
}

fn filesystem_path(params: &Value, field: &str) -> Result<PathBuf, String> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("文件系统操作需要 {field}。"))
}

fn filesystem_encoding(params: &Value) -> Result<&str, String> {
    match params
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("text")
    {
        "text" => Ok("text"),
        "base64" => Ok("base64"),
        _ => Err("文件内容 encoding 仅支持 text 或 base64。".to_string()),
    }
}

fn filesystem_content(params: &Value) -> Result<Vec<u8>, String> {
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "写入文件需要 content。".to_string())?;
    match filesystem_encoding(params)? {
        "text" => Ok(content.as_bytes().to_vec()),
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|_| "文件 content 的 Base64 编码无效。".to_string()),
        _ => unreachable!(),
    }
}

fn filesystem_content_response(path: &Path, bytes: Vec<u8>, encoding: &str) -> Value {
    let content = match encoding {
        "text" => String::from_utf8_lossy(&bytes).into_owned(),
        "base64" => base64::engine::general_purpose::STANDARD.encode(&bytes),
        _ => unreachable!(),
    };
    json!({
        "path": path,
        "encoding": encoding,
        "content": content,
    })
}

fn filesystem_metadata_response(path: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取文件属性失败：{error}"))?;
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    let modified_at_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    Ok(json!({
        "path": path,
        "kind": kind,
        "size": metadata.len(),
        "modifiedAtUnixMs": modified_at_unix_ms,
    }))
}

fn copy_filesystem_path(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_dir() {
        fs::create_dir_all(destination).map_err(|error| format!("复制目录失败：{error}"))?;
        for entry in fs::read_dir(source).map_err(|error| format!("读取目录失败：{error}"))?
        {
            let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
            copy_filesystem_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(source, destination).map_err(|error| format!("复制文件失败：{error}"))?;
        Ok(())
    }
}

fn remove_filesystem_path(path: &Path, recursive: bool) -> Result<(), String> {
    if path.is_dir() {
        if recursive {
            fs::remove_dir_all(path).map_err(|error| format!("删除目录失败：{error}"))?;
        } else {
            fs::remove_dir(path).map_err(|error| format!("删除目录失败：{error}"))?;
        }
    } else {
        fs::remove_file(path).map_err(|error| format!("删除文件失败：{error}"))?;
    }
    Ok(())
}

fn rpc_error(code: &str, message: impl Into<String>) -> RpcError {
    RpcError {
        code: code.to_string(),
        message: message.into(),
        data: None,
    }
}
