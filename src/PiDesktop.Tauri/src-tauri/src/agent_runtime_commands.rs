use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use url::Url;

use crate::agent_runtime::{
    CapabilityDescriptor, CapabilityHandler, HostHello, RpcError, RuntimeCommand, RuntimeHello,
    VersionRange, PROTOCOL_VERSION,
};
use crate::state::AppState;

const HOST_ID: &str = "synthv-toolbox.native-host";
const NETWORK_RESPONSE_LIMIT: usize = 1_048_576;

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
pub fn set_agent_plugin_enabled(
    plugin_id: String,
    enabled: bool,
) -> Result<crate::plugin_manager::InstalledPlugin, String> {
    crate::plugin_manager::set_enabled(&crate::plugin_manager::plugins_root(), &plugin_id, enabled)
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
                ["state", "precheck", "activate", "launch"],
            ),
            capability("synthv.sandbox", ["prepare", "remove"]),
            capability("synthv.authorization", ["set-enabled"]),
            capability("host.network", ["request"]),
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
    let handler: CapabilityHandler = Arc::new(move |params| {
        let mcp = mcp.clone();
        let bridge_dir = bridge_dir.clone();
        let profiles = profiles.clone();
        let settings = settings.clone();
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
                        "activate" => "host.internal",
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
                    let url = invocation
                        .params
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            rpc_error("invalid_capability_request", "联网请求需要 url。")
                        })?;
                    restricted_network_get(url)
                        .await
                        .map_err(|error| rpc_error("network_error", error))
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

async fn restricted_network_get(raw_url: &str) -> Result<Value, String> {
    let url = Url::parse(raw_url).map_err(|_| "联网请求 URL 无效。".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("联网请求只允许不含用户信息的 HTTPS URL。".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "联网请求 URL 缺少主机名。".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "联网请求端口无效。".to_string())?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "无法解析联网请求主机。".to_string())?
        .collect::<Vec<SocketAddr>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !is_public_address(address.ip()))
    {
        return Err("联网请求目标不是允许的公网地址。".to_string());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| "无法创建联网请求客户端。".to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "联网请求失败。".to_string())?;
    if response.status().is_redirection() {
        return Err("联网请求不允许重定向。".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > NETWORK_RESPONSE_LIMIT as u64)
    {
        return Err("联网响应超过大小限制。".to_string());
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "联网响应中断。".to_string())?;
        if body.len() + chunk.len() > NETWORK_RESPONSE_LIMIT {
            return Err("联网响应超过大小限制。".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(json!({
        "status": status,
        "contentType": content_type,
        "body": String::from_utf8_lossy(&body),
    }))
}

fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_unspecified()
                && !address.is_broadcast()
                && !address.is_documentation()
                && !address.is_multicast()
                && !(address.octets()[0] == 100 && (64..=127).contains(&address.octets()[1]))
        }
        IpAddr::V6(address) => {
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_unique_local()
                && !address.is_unicast_link_local()
                && !address.is_multicast()
                && address.octets()[..4] != [0x20, 0x01, 0x0d, 0xb8]
        }
    }
}

fn rpc_error(code: &str, message: impl Into<String>) -> RpcError {
    RpcError {
        code: code.to_string(),
        message: message.into(),
        data: None,
    }
}
