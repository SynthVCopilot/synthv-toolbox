use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::agent::ToolDefinition;
use crate::mcp::McpManager;
use crate::synthv::{bridge_is_bundled, find_node};
use crate::synthv_control::{self, BridgeShortcutAction};
use crate::synthv_hosts::{self, HostKind, StandardSynthVHost};

const OFFICIAL_SV2_SERVER: &str = "synthv";
const OFFICIAL_SV1_SERVER: &str = "synthv-sv1";
const CONNECT_RETRIES: usize = 16;
const CONNECT_POLL: Duration = Duration::from_millis(250);
const TOOL_TIMEOUT: Duration = Duration::from_secs(12);
const LEGACY_STOP_FILE: &str = "synthv-agent-bridge-sv1-legacy.stop";

pub const TOOL_NAMES: &[&str] = &[
    "synthv_hosts",
    "synthv_connect",
    "synthv_disconnect",
    "synthv_capabilities",
    "synthv_read",
    "synthv_write",
    "synthv_export",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostRequest {
    host_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRequest {
    host_id: Option<String>,
    operation: String,
    #[serde(default)]
    arguments: Value,
    #[serde(default)]
    write_intent: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteRequest {
    host_id: Option<String>,
    operation: String,
    #[serde(default)]
    arguments: Value,
    context_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    host_id: Option<String>,
    #[serde(default)]
    label: String,
}

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        definition(
            "synthv_hosts",
            "List installed and running SynthV hosts through one standard interface.",
            json!({ "type": "object", "additionalProperties": false }),
        ),
        definition(
            "synthv_connect",
            "Connect one standard SynthV host. The adapter hides Bridge, shortcut, and local HTTP details.",
            json!({
                "type": "object",
                "properties": { "hostId": { "type": "string" } },
                "required": ["hostId"],
                "additionalProperties": false
            }),
        ),
        definition(
            "synthv_disconnect",
            "Disconnect one standard SynthV host without changing its project.",
            json!({
                "type": "object",
                "properties": { "hostId": { "type": "string" } },
                "required": ["hostId"],
                "additionalProperties": false
            }),
        ),
        definition(
            "synthv_capabilities",
            "Read the normalized capabilities of one host or every discovered host.",
            json!({
                "type": "object",
                "properties": { "hostId": { "type": "string" } },
                "additionalProperties": false
            }),
        ),
        definition(
            "synthv_read",
            "Read a connected SynthV host with normalized zero-based indices and Part terminology.",
            json!({
                "type": "object",
                "properties": {
                    "hostId": { "type": "string" },
                    "operation": { "type": "string", "enum": ["status", "project", "sequence", "transport", "tracks", "track", "parts", "part", "notes", "singers", "voice"] },
                    "arguments": { "type": "object", "default": {}, "description": "Use zero-based trackIndex and partIndex where required; tracks may request detail=true." },
                    "writeIntent": { "type": "boolean", "default": false }
                },
                "required": ["operation"],
                "additionalProperties": false
            }),
        ),
        definition(
            "synthv_write",
            "Apply one standard SynthV operation. Use a contextId from synthv_read(writeIntent=true) when returned.",
            json!({
                "type": "object",
                "properties": {
                    "hostId": { "type": "string" },
                    "operation": { "type": "string", "enum": ["project.open", "sequence.set_tempo", "sequence.remove_tempo", "sequence.set_time_signature", "sequence.remove_time_signature", "transport.play", "transport.pause", "transport.stop", "transport.seek", "track.create", "track.update", "track.delete", "part.create", "part.update", "part.delete", "voice.assign", "voice.parameters.update", "note.create", "note.update", "note.delete"] },
                    "arguments": { "type": "object", "default": {}, "description": "Use zero-based trackIndex, partIndex, and noteIndex. Timing uses native blicks except transport.seek, which uses seconds." },
                    "contextId": { "type": "string" }
                },
                "required": ["operation", "arguments"],
                "additionalProperties": false
            }),
        ),
        definition(
            "synthv_export",
            "Export a versioned host-neutral JSON snapshot assembled from the standard read interface.",
            json!({
                "type": "object",
                "properties": {
                    "hostId": { "type": "string" },
                    "label": { "type": "string", "maxLength": 80 }
                },
                "additionalProperties": false
            }),
        ),
    ]
}

fn definition(name: &str, description: &str, schema: Value) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema_json: schema.to_string(),
    }
}

pub fn is_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

pub fn is_mutation(name: &str) -> bool {
    name == "synthv_write"
}

pub async fn execute(
    tool: &str,
    arguments: &str,
    manager: &Arc<McpManager>,
    bridge_dir: &Path,
) -> Result<Value, String> {
    match tool {
        "synthv_hosts" => list_public_hosts(manager).await,
        "synthv_connect" => {
            let request = parse::<HostRequest>(arguments)?;
            connect(manager, bridge_dir, &request.host_id).await
        }
        "synthv_disconnect" => {
            let request = parse::<HostRequest>(arguments)?;
            disconnect(manager, &request.host_id).await
        }
        "synthv_capabilities" => {
            let request = serde_json::from_str::<Value>(arguments)
                .map_err(|error| format!("SynthV capability 参数无效：{error}"))?;
            capabilities(manager, request.get("hostId").and_then(Value::as_str)).await
        }
        "synthv_read" => {
            let request = parse::<ReadRequest>(arguments)?;
            read(manager, request).await
        }
        "synthv_write" => {
            let request = parse::<WriteRequest>(arguments)?;
            write(manager, request).await
        }
        "synthv_export" => {
            let request = parse::<ExportRequest>(arguments)?;
            export_snapshot(manager, request).await
        }
        _ => Err(format!("未知标准 SynthV 工具：{tool}")),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(arguments: &str) -> Result<T, String> {
    serde_json::from_str(arguments).map_err(|error| format!("标准 SynthV 参数无效：{error}"))
}

async fn discovered_with_connections(
    manager: &McpManager,
) -> Result<Vec<StandardSynthVHost>, String> {
    let mut hosts = synthv_hosts::discover()?;
    let connected = manager.connected_synthv_hosts().await;
    for host in &mut hosts {
        host.connected = connected.contains_key(&host.id);
    }
    Ok(hosts)
}

async fn list_public_hosts(manager: &McpManager) -> Result<Value, String> {
    Ok(Value::Array(
        discovered_with_connections(manager)
            .await?
            .iter()
            .map(public_host)
            .collect(),
    ))
}

fn public_host(host: &StandardSynthVHost) -> Value {
    json!({
        "id": host.id,
        "name": host.display_name,
        "version": host.version,
        "installed": host.installed,
        "running": host.running,
        "connected": host.connected,
        "processId": host.process_id,
        "capabilities": host.capabilities,
    })
}

async fn capabilities(manager: &McpManager, host_id: Option<&str>) -> Result<Value, String> {
    let hosts = discovered_with_connections(manager).await?;
    if let Some(host_id) = host_id {
        let host = hosts
            .iter()
            .find(|host| host.id == host_id)
            .ok_or_else(|| format!("没有发现 SynthV 宿主 {host_id}。"))?;
        return Ok(public_host(host));
    }
    Ok(Value::Array(hosts.iter().map(public_host).collect()))
}

async fn resolve_host(
    manager: &McpManager,
    requested: Option<&str>,
) -> Result<StandardSynthVHost, String> {
    let hosts = discovered_with_connections(manager).await?;
    if let Some(id) = requested {
        return hosts
            .into_iter()
            .find(|host| host.id == id)
            .ok_or_else(|| format!("没有发现 SynthV 宿主 {id}。"));
    }
    let connected = hosts
        .into_iter()
        .filter(|host| host.connected)
        .collect::<Vec<_>>();
    match connected.as_slice() {
        [host] => Ok(host.clone()),
        [] => Err("没有已连接的 SynthV 宿主；请先调用 synthv_connect。".to_string()),
        _ => Err("存在多个已连接的 SynthV 宿主；请明确提供 hostId。".to_string()),
    }
}

fn server_id(host: &StandardSynthVHost) -> String {
    match host.kind {
        HostKind::OfficialSv1 => OFFICIAL_SV1_SERVER.to_string(),
        HostKind::OfficialSv2 => OFFICIAL_SV2_SERVER.to_string(),
        HostKind::Flat => format!("synthv-flat-{}", host.process_id.unwrap_or_default()),
    }
}

async fn connect(
    manager: &Arc<McpManager>,
    bridge_dir: &Path,
    host_id: &str,
) -> Result<Value, String> {
    let host = synthv_hosts::discover()?
        .into_iter()
        .find(|host| host.id == host_id)
        .ok_or_else(|| format!("没有发现 SynthV 宿主 {host_id}。"))?;
    if !host.running {
        return Err("所选 SynthV 宿主尚未运行。".to_string());
    }
    let id = server_id(&host);
    if manager.synthv_server_id(&host.id).await.is_some() {
        return Ok(json!({ "hostId": host.id, "connected": true, "alreadyConnected": true }));
    }
    let _tools = match host.kind {
        HostKind::Flat => {
            let endpoint = host
                .endpoint
                .clone()
                .ok_or_else(|| "所选 SynthV 宿主的内置扩展尚未就绪。".to_string())?;
            manager
                .connect_http(id.clone(), "SynthV Host".to_string(), endpoint)
                .await
                .map_err(standard_error)?
        }
        HostKind::OfficialSv2 => {
            if !bridge_is_bundled(bridge_dir) {
                return Err("当前应用包不包含所需的 SynthV 扩展。".to_string());
            }
            let node = find_node().ok_or_else(|| "未找到兼容的本地扩展运行时。".to_string())?;
            let process_id = host
                .process_id
                .ok_or_else(|| "宿主进程不可用。".to_string())?;
            synthv_control::start_bridge_and_connect(
                process_id,
                manager,
                node,
                bridge_dir.to_path_buf(),
            )
            .await
            .map_err(standard_error)?
            .1
        }
        HostKind::OfficialSv1 => connect_sv1(manager, bridge_dir, &host, &id).await?,
    };
    manager.bind_synthv_host(host.id.clone(), id).await;
    Ok(json!({ "hostId": host.id, "connected": true }))
}

async fn connect_sv1(
    manager: &Arc<McpManager>,
    bridge_dir: &Path,
    host: &StandardSynthVHost,
    id: &str,
) -> Result<Vec<String>, String> {
    let cli = bridge_dir.join("dist/legacy-sv1/src/cli.js");
    if !cli.is_file() {
        return Err("当前应用包不包含所需的兼容扩展。".to_string());
    }
    let node = find_node().ok_or_else(|| "未找到兼容的本地扩展运行时。".to_string())?;
    install_sv1_bridge(bridge_dir, host, &node)?;
    let process_id = host
        .process_id
        .ok_or_else(|| "宿主进程不可用。".to_string())?;
    synthv_control::send_shortcut(process_id, BridgeShortcutAction::Start)
        .map_err(standard_error)?;
    let tools = manager
        .connect_stdio_host(
            id.to_string(),
            "SynthV Host".to_string(),
            node,
            vec!["dist/legacy-sv1/src/cli.js".to_string()],
            Some(bridge_dir.to_path_buf()),
        )
        .await
        .map_err(standard_error)?;
    let mut last_error = "宿主扩展尚未就绪。".to_string();
    for _ in 0..CONNECT_RETRIES {
        match call_payload(manager, id, "studio.get_status", json!({})).await {
            Ok(_) => return Ok(tools),
            Err(error) => last_error = error,
        }
        tokio::time::sleep(CONNECT_POLL).await;
    }
    manager.disconnect(id).await;
    Err(format!("宿主扩展未在限定时间内就绪：{last_error}"))
}

fn install_sv1_bridge(
    bridge_dir: &Path,
    host: &StandardSynthVHost,
    node: &str,
) -> Result<(), String> {
    let scripts = host
        .script_directories
        .first()
        .map(PathBuf::from)
        .ok_or_else(|| "所选宿主没有可用的扩展目录。".to_string())?;
    if !scripts.is_dir() {
        return Err("所选宿主的扩展目录不存在。".to_string());
    }
    let source = bridge_dir.join("legacy-sv1/synthv/SynthVAgentBridgeSV1Legacy.lua");
    let installed = scripts
        .join("SynthV Agent Bridge SV1 Legacy")
        .join("SynthVAgentBridgeSV1Legacy.lua");
    if source.is_file()
        && installed.is_file()
        && fs::read(&source).ok() == fs::read(&installed).ok()
    {
        return Ok(());
    }
    let output = std::process::Command::new(node)
        .arg(bridge_dir.join("scripts/install-sv1-legacy-bridge.mjs"))
        .arg("--target")
        .arg(&scripts)
        .current_dir(bridge_dir)
        .output()
        .map_err(|error| format!("无法准备宿主扩展：{error}"))?;
    if output.status.success() {
        Err("宿主扩展已安装或更新；请让宿主重新扫描扩展后再次连接。".to_string())
    } else {
        Err("无法准备宿主扩展。".to_string())
    }
}

async fn disconnect(manager: &McpManager, host_id: &str) -> Result<Value, String> {
    let host = synthv_hosts::discover()?
        .into_iter()
        .find(|host| host.id == host_id);
    let Some(id) = manager.synthv_server_id(host_id).await else {
        return Ok(json!({ "hostId": host_id, "connected": false, "alreadyDisconnected": true }));
    };
    manager.disconnect(&id).await;
    let stop_warning = match host.as_ref().map(|host| host.kind) {
        None => Some("宿主进程已退出；已清理本地连接。".to_string()),
        Some(HostKind::Flat) => None,
        Some(HostKind::OfficialSv1) => {
            let shortcut_warning =
                host.as_ref()
                    .and_then(|host| host.process_id)
                    .and_then(|process_id| {
                        synthv_control::send_shortcut(process_id, BridgeShortcutAction::Stop).err()
                    });
            let stop_warning = fs::write(std::env::temp_dir().join(LEGACY_STOP_FILE), b"")
                .err()
                .map(|error| error.to_string());
            stop_warning.or(shortcut_warning)
        }
        Some(HostKind::OfficialSv2) => {
            host.as_ref()
                .and_then(|host| host.process_id)
                .and_then(|process_id| {
                    synthv_control::send_shortcut(process_id, BridgeShortcutAction::Stop).err()
                })
        }
    };
    Ok(json!({
        "hostId": host_id,
        "connected": false,
        "warning": stop_warning.map(standard_error)
    }))
}

async fn read(manager: &McpManager, request: ReadRequest) -> Result<Value, String> {
    let host = resolve_host(manager, request.host_id.as_deref()).await?;
    if !host
        .capabilities
        .read_operations
        .contains(&request.operation.as_str())
    {
        return Err(format!(
            "所选 SynthV 宿主不支持标准读取操作 {}。",
            request.operation
        ));
    }
    let id = manager
        .synthv_server_id(&host.id)
        .await
        .ok_or_else(|| "所选 SynthV 宿主尚未连接。".to_string())?;
    let data = match host.kind {
        HostKind::Flat | HostKind::OfficialSv1 => {
            let remote = canonical_read_tool(&request.operation)?;
            let args = canonical_read_arguments(host.kind, &request.operation, request.arguments)?;
            normalize_direct(
                host.kind,
                &request.operation,
                call_payload(manager, &id, remote, args).await?,
            )
        }
        HostKind::OfficialSv2 => {
            read_sv2(
                manager,
                &id,
                &request.operation,
                request.arguments,
                request.write_intent,
            )
            .await?
        }
    };
    Ok(json!({ "hostId": host.id, "operation": request.operation, "data": data }))
}

fn canonical_read_tool(operation: &str) -> Result<&'static str, String> {
    match operation {
        "status" => Ok("studio.get_status"),
        "project" => Ok("project.get"),
        "sequence" => Ok("sequence.get"),
        "transport" => Ok("transport.get"),
        "tracks" => Ok("track.list"),
        "track" => Ok("track.get"),
        "parts" => Ok("part.list"),
        "part" | "voice" => Ok("part.get"),
        "notes" => Ok("note.list"),
        "singers" => Ok("singer.list"),
        _ => Err(format!("不支持的标准读取操作：{operation}")),
    }
}

fn canonical_read_arguments(
    kind: HostKind,
    operation: &str,
    value: Value,
) -> Result<Value, String> {
    let mut args = object(value)?;
    if operation == "tracks" && kind == HostKind::Flat {
        args.entry("detail".to_string())
            .or_insert(Value::Bool(true));
    } else if operation == "tracks" {
        args.remove("detail");
    }
    Ok(Value::Object(args))
}

async fn read_sv2(
    manager: &McpManager,
    id: &str,
    operation: &str,
    arguments: Value,
    write_intent: bool,
) -> Result<Value, String> {
    let mut args = object(arguments)?;
    let response = match operation {
        "status" => call_payload(manager, id, "sv_status", json!({ "operation": "host" })).await?,
        "project" => bridge_query(manager, id, "get_project_info", args, write_intent).await?,
        "sequence" => bridge_query(manager, id, "get_time_axis", args, write_intent).await?,
        "transport" => {
            call_payload(
                manager,
                id,
                "sv_ui",
                json!({ "action": "playback", "args": { "operation": "status" } }),
            )
            .await?
        }
        "tracks" => {
            args.entry("offset".to_string()).or_insert(json!(0));
            args.entry("limit".to_string()).or_insert(json!(1000));
            bridge_query(manager, id, "list_tracks", args, write_intent).await?
        }
        "track" | "parts" | "part" | "notes" => {
            let args = sv2_group_locator(args, operation != "track" && operation != "parts")?;
            bridge_query(manager, id, "get_track_notes", args, write_intent).await?
        }
        "voice" => {
            let args = sv2_group_locator(args, true)?;
            bridge_query(manager, id, "get_group_voice", args, write_intent).await?
        }
        "singers" => return Err("所选宿主不提供歌手身份枚举。".to_string()),
        _ => return Err(format!("不支持的标准读取操作：{operation}")),
    };
    Ok(normalize_sv2(response))
}

async fn bridge_query(
    manager: &McpManager,
    id: &str,
    action: &str,
    args: Map<String, Value>,
    write_intent: bool,
) -> Result<Value, String> {
    call_payload(
        manager,
        id,
        "sv_query",
        json!({
            "action": action,
            "args": args,
            "contextMode": if write_intent { "writeIntent" } else { "readOnly" },
            "dense": "never"
        }),
    )
    .await
}

async fn write(manager: &McpManager, request: WriteRequest) -> Result<Value, String> {
    let host = resolve_host(manager, request.host_id.as_deref()).await?;
    if !host
        .capabilities
        .write_operations
        .contains(&request.operation.as_str())
    {
        return Err(format!(
            "所选 SynthV 宿主不支持标准写入操作 {}。",
            request.operation
        ));
    }
    let id = manager
        .synthv_server_id(&host.id)
        .await
        .ok_or_else(|| "所选 SynthV 宿主尚未连接。".to_string())?;
    let data = match host.kind {
        HostKind::Flat => normalize_direct(
            host.kind,
            &request.operation,
            write_direct(manager, &id, &request.operation, request.arguments, false).await?,
        ),
        HostKind::OfficialSv1 => normalize_direct(
            host.kind,
            &request.operation,
            write_direct(manager, &id, &request.operation, request.arguments, true).await?,
        ),
        HostKind::OfficialSv2 => {
            write_sv2(
                manager,
                &id,
                &request.operation,
                request.arguments,
                request.context_id,
            )
            .await?
        }
    };
    Ok(json!({ "hostId": host.id, "operation": request.operation, "data": data }))
}

async fn write_direct(
    manager: &McpManager,
    id: &str,
    operation: &str,
    arguments: Value,
    legacy: bool,
) -> Result<Value, String> {
    let remote = match operation {
        "voice.assign" => "part.assign_singer",
        "voice.parameters.update" => return Err("所选宿主不提供标准声音参数写入。".to_string()),
        "project.open"
        | "sequence.set_tempo"
        | "sequence.remove_tempo"
        | "sequence.set_time_signature"
        | "sequence.remove_time_signature"
        | "transport.play"
        | "transport.pause"
        | "transport.stop"
        | "transport.seek"
        | "track.create"
        | "track.update"
        | "track.delete"
        | "part.create"
        | "part.update"
        | "part.delete"
        | "note.create"
        | "note.update"
        | "note.delete" => operation,
        _ => return Err(format!("不支持的标准写入操作：{operation}")),
    };
    let mut args = object(arguments)?;
    if legacy {
        if operation == "project.open"
            || operation.starts_with("sequence.")
            || operation == "voice.assign"
        {
            return Err("所选宿主不提供此标准写入操作。".to_string());
        }
        if matches!(operation, "part.update" | "note.update") {
            let mut changes = Map::new();
            let locator_keys = if operation == "part.update" {
                ["trackIndex", "partIndex", ""]
            } else {
                ["trackIndex", "partIndex", "noteIndex"]
            };
            let keys = args.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                if key != "writeIntent" && !locator_keys.contains(&key.as_str()) {
                    if let Some(value) = args.remove(&key) {
                        changes.insert(key, value);
                    }
                }
            }
            args.insert("changes".to_string(), Value::Object(changes));
        }
        args.insert("writeIntent".to_string(), Value::Bool(true));
    }
    call_payload(manager, id, remote, Value::Object(args)).await
}

async fn write_sv2(
    manager: &McpManager,
    id: &str,
    operation: &str,
    arguments: Value,
    context_id: Option<String>,
) -> Result<Value, String> {
    let mut args = object(arguments)?;
    if let Some(track_index) = take_index(&mut args, "trackIndex")? {
        args.insert("trackIndex".to_string(), json!(track_index + 1));
    }
    if let Some(part_index) = take_index(&mut args, "partIndex")? {
        args.insert("groupIndex".to_string(), json!(part_index + 1));
    }
    let (tool, action, requires_context) = match operation {
        "transport.play" | "transport.pause" | "transport.stop" | "transport.seek" => {
            let transport = operation.trim_start_matches("transport.");
            let mut playback = args;
            if operation == "transport.seek" {
                let seconds = required_value(&mut playback, "seconds")?;
                playback.insert("timeSeconds".to_string(), seconds);
            }
            playback.insert("operation".to_string(), json!(transport));
            return call_payload(
                manager,
                id,
                "sv_ui",
                json!({ "action": "playback", "args": playback }),
            )
            .await;
        }
        "sequence.set_tempo" => {
            let position = required_value(&mut args, "position")?;
            let bpm = required_value(&mut args, "bpm")?;
            args = object(json!({ "tempoMarks": [{ "position": position, "bpm": bpm }] }))?;
            ("sv_command", "set_time_axis", true)
        }
        "sequence.remove_tempo" => {
            let position = required_value(&mut args, "position")?;
            args = object(json!({ "removeTempoPositions": [position] }))?;
            ("sv_command", "set_time_axis", true)
        }
        "sequence.set_time_signature" => {
            let position = required_value(&mut args, "position")?;
            let numerator = required_value(&mut args, "numerator")?;
            let denominator = required_value(&mut args, "denominator")?;
            args = object(
                json!({ "measureMarks": [{ "measure": position, "numerator": numerator, "denominator": denominator }] }),
            )?;
            ("sv_command", "set_time_axis", true)
        }
        "sequence.remove_time_signature" => {
            let position = required_value(&mut args, "position")?;
            args = object(json!({ "removeMeasurePositions": [position] }))?;
            ("sv_command", "set_time_axis", true)
        }
        "track.create" => ("sv_command", "add_track", false),
        "track.update" => ("sv_command", "update_track", true),
        "track.delete" => ("sv_command", "delete_track", true),
        "part.update" => ("sv_command", "update_group", true),
        "part.delete" => ("sv_command", "delete_group_reference", true),
        "voice.parameters.update" => ("sv_command", "set_group_voice", true),
        "note.create" => {
            normalize_note_input(&mut args);
            let locator = take_locator(&mut args);
            let mut payload = locator;
            payload.insert("notes".to_string(), Value::Array(vec![Value::Object(args)]));
            args = payload;
            ("sv_command", "add_notes", false)
        }
        "note.update" => {
            let note_index = take_index(&mut args, "noteIndex")?
                .ok_or_else(|| "note.update 需要 noteIndex。".to_string())?;
            normalize_note_input(&mut args);
            let locator = take_locator(&mut args);
            let mut payload = locator;
            payload.insert(
                "edits".to_string(),
                json!([{ "noteIndex": note_index + 1, "changes": args }]),
            );
            args = payload;
            ("sv_command", "edit_notes", true)
        }
        "note.delete" => {
            let note_index = take_index(&mut args, "noteIndex")?
                .ok_or_else(|| "note.delete 需要 noteIndex。".to_string())?;
            let mut payload = take_locator(&mut args);
            payload.insert(
                "notes".to_string(),
                json!([{ "noteIndex": note_index + 1 }]),
            );
            args = payload;
            ("sv_command", "delete_notes", true)
        }
        "project.open" | "part.create" | "voice.assign" => {
            return Err("所选宿主不提供此标准写入操作。".to_string())
        }
        _ => return Err(format!("不支持的标准写入操作：{operation}")),
    };
    if requires_context && context_id.is_none() {
        return Err(
            "此写入需要先执行 synthv_read(writeIntent=true) 并传回 contextId。".to_string(),
        );
    }
    let mut request = json!({
        "action": action,
        "args": args,
        "expectedEffect": "mustChange"
    });
    if let Some(context_id) = context_id {
        request["contextId"] = Value::String(context_id);
    }
    let result = call_payload(manager, id, tool, request).await?;
    Ok(normalize_sv2(result))
}

fn normalize_note_input(args: &mut Map<String, Value>) {
    if args.get("musicalType").and_then(Value::as_str) == Some("singing") {
        args.insert("musicalType".to_string(), json!("sing"));
    }
}

fn normalize_direct(kind: HostKind, operation: &str, value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_direct(kind, operation, item))
                .collect(),
        ),
        Value::Object(object) => {
            let mut normalized = Map::new();
            for (key, value) in object {
                let canonical_key = if kind == HostKind::Flat
                    && (operation == "status" || operation.starts_with("transport"))
                    && key == "playhead"
                {
                    "playheadSeconds".to_string()
                } else if kind == HostKind::OfficialSv1
                    && operation == "sequence"
                    && key == "timeSignatures"
                {
                    "measureMarks".to_string()
                } else {
                    key
                };
                normalized.insert(canonical_key, normalize_direct(kind, operation, value));
            }
            Value::Object(normalized)
        }
        value => value,
    }
}

fn take_locator(args: &mut Map<String, Value>) -> Map<String, Value> {
    let mut locator = Map::new();
    for key in ["trackIndex", "groupIndex", "groupUuid"] {
        if let Some(value) = args.remove(key) {
            locator.insert(key.to_string(), value);
        }
    }
    locator
}

fn sv2_group_locator(
    mut args: Map<String, Value>,
    require_part: bool,
) -> Result<Map<String, Value>, String> {
    let track = take_index(&mut args, "trackIndex")?
        .ok_or_else(|| "此读取需要 trackIndex。".to_string())?;
    args.insert("trackIndex".to_string(), json!(track + 1));
    if let Some(part) = take_index(&mut args, "partIndex")? {
        args.insert("groupIndex".to_string(), json!(part + 1));
    } else if require_part {
        return Err("此读取需要 partIndex。".to_string());
    }
    Ok(args)
}

fn take_index(args: &mut Map<String, Value>, key: &str) -> Result<Option<u64>, String> {
    let Some(value) = args.remove(key) else {
        return Ok(None);
    };
    let index = value
        .as_u64()
        .filter(|index| *index < 10_000)
        .ok_or_else(|| format!("{key} 必须是 0–9999 的整数。"))?;
    Ok(Some(index))
}

fn required_value(args: &mut Map<String, Value>, key: &str) -> Result<Value, String> {
    args.remove(key)
        .ok_or_else(|| format!("此操作需要 {key}。"))
}

fn object(value: Value) -> Result<Map<String, Value>, String> {
    match value {
        Value::Object(value) => Ok(value),
        Value::Null => Ok(Map::new()),
        _ => Err("arguments 必须是对象。".to_string()),
    }
}

async fn call_payload(
    manager: &McpManager,
    server_id: &str,
    tool: &str,
    arguments: Value,
) -> Result<Value, String> {
    let response = tokio::time::timeout(
        TOOL_TIMEOUT,
        manager.call_server_tool(server_id, tool, arguments),
    )
    .await
    .map_err(|_| "SynthV 宿主调用超时。".to_string())?
    .map_err(standard_error)?;
    if response
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(standard_error(
            tool_text(&response).unwrap_or_else(|| "SynthV 宿主拒绝了操作。".to_string()),
        ));
    }
    if let Some(text) = tool_text(&response) {
        return serde_json::from_str(&text)
            .map_err(|error| format!("SynthV 宿主结果无效：{error}"));
    }
    response
        .get("structuredContent")
        .cloned()
        .ok_or_else(|| "SynthV 宿主没有返回结果。".to_string())
}

fn standard_error(error: String) -> String {
    error
        .replace("Flat MCP", "SynthV 宿主")
        .replace("SynthV Bridge", "SynthV 宿主")
        .replace("HTTP MCP", "宿主连接")
        .replace("stdio", "宿主连接")
        .replace("MCP", "宿主连接")
        .replace("Bridge", "宿主扩展")
        .replace("F13", "启动快捷键")
        .replace("F14", "停止快捷键")
}

fn tool_text(value: &Value) -> Option<String> {
    value
        .get("content")?
        .as_array()?
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("text"))?
        .get("text")?
        .as_str()
        .map(str::to_string)
}

fn normalize_sv2(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_sv2).collect()),
        Value::Object(object) => {
            let mut normalized = Map::new();
            for (key, value) in object {
                let (key, value) = match key.as_str() {
                    "trackIndex" | "noteIndex" => (
                        key,
                        value.as_u64().map_or_else(
                            || normalize_sv2(value),
                            |index| json!(index.saturating_sub(1)),
                        ),
                    ),
                    "groupIndex" => (
                        "partIndex".to_string(),
                        value.as_u64().map_or_else(
                            || normalize_sv2(value),
                            |index| json!(index.saturating_sub(1)),
                        ),
                    ),
                    "groups" => ("parts".to_string(), normalize_sv2(value)),
                    "groupCount" => ("partCount".to_string(), normalize_sv2(value)),
                    "groupName" => ("partName".to_string(), normalize_sv2(value)),
                    "musicalType" if value.as_str() == Some("sing") => {
                        (key, Value::String("singing".to_string()))
                    }
                    _ => (key, normalize_sv2(value)),
                };
                normalized.insert(key, value);
            }
            Value::Object(normalized)
        }
        value => value,
    }
}

async fn export_snapshot(manager: &McpManager, request: ExportRequest) -> Result<Value, String> {
    let host = resolve_host(manager, request.host_id.as_deref()).await?;
    let host_id = host.id.clone();
    let project = read_value(manager, &host_id, "project", json!({})).await?;
    let sequence = read_value(manager, &host_id, "sequence", json!({})).await?;
    let tracks = read_value(manager, &host_id, "tracks", json!({ "detail": true })).await?;
    let singers = if host.capabilities.singer_list {
        Some(read_value(manager, &host_id, "singers", json!({})).await?)
    } else {
        None
    };
    let snapshot = json!({
        "schemaVersion": 1,
        "exportedAt": Utc::now().to_rfc3339(),
        "host": public_host(&host),
        "project": project,
        "sequence": sequence,
        "tracks": tracks,
        "singers": singers,
    });
    let directory = crate::agent::output_dir().join("synthv-snapshots");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建 SynthV 快照目录：{error}"))?;
    let label = safe_label(&request.label);
    let name = format!(
        "{}-{}-{}.json",
        Utc::now().format("%Y%m%d-%H%M%S"),
        label,
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let target = directory.join(name);
    let temporary = target.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| format!("无法写入 SynthV 快照：{error}"))?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法提交 SynthV 快照：{error}"));
    }
    Ok(json!({ "hostId": host_id, "outputPath": target, "snapshot": snapshot }))
}

async fn read_value(
    manager: &McpManager,
    host_id: &str,
    operation: &str,
    arguments: Value,
) -> Result<Value, String> {
    let result = read(
        manager,
        ReadRequest {
            host_id: Some(host_id.to_string()),
            operation: operation.to_string(),
            arguments,
            write_intent: false,
        },
    )
    .await?;
    result
        .get("data")
        .cloned()
        .ok_or_else(|| "标准 SynthV 读取缺少 data。".to_string())
}

async fn capture_host(manager: &McpManager, process_id: u32) -> Result<StandardSynthVHost, String> {
    let host = discovered_with_connections(manager)
        .await?
        .into_iter()
        .find(|host| host.process_id == Some(process_id))
        .ok_or_else(|| format!("没有发现 PID {process_id} 对应的 SynthV 宿主。"))?;
    if !host.connected {
        return Err("所选 SynthV 宿主尚未连接。".to_string());
    }
    if !host.capabilities.audio_capture {
        return Err("所选 SynthV 宿主缺少安全片段捕获所需的播放头定位能力。".to_string());
    }
    Ok(host)
}

pub async fn capture_status(manager: &McpManager, process_id: u32) -> Result<Value, String> {
    let host = capture_host(manager, process_id).await?;
    read_value(manager, &host.id, "status", json!({})).await
}

pub async fn capture_playback(
    manager: &McpManager,
    process_id: u32,
    operation: &str,
    seconds: Option<f64>,
) -> Result<Value, String> {
    let host = capture_host(manager, process_id).await?;
    if operation == "status" {
        return read_value(manager, &host.id, "transport", json!({})).await;
    }
    let standard_operation = format!("transport.{operation}");
    if !host
        .capabilities
        .write_operations
        .contains(&standard_operation.as_str())
    {
        return Err(format!("所选 SynthV 宿主不支持 {standard_operation}。"));
    }
    let arguments = seconds.map_or_else(|| json!({}), |seconds| json!({ "seconds": seconds }));
    let result = write(
        manager,
        WriteRequest {
            host_id: Some(host.id),
            operation: standard_operation,
            arguments,
            context_id: None,
        },
    )
    .await?;
    result
        .get("data")
        .cloned()
        .ok_or_else(|| "标准 SynthV 播放控制缺少 data。".to_string())
}

fn safe_label(value: &str) -> String {
    let label = value
        .trim()
        .chars()
        .take(80)
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if label.is_empty() {
        "project".to_string()
    } else {
        label
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sv2_indices_and_terms_are_normalized() {
        let value = normalize_sv2(json!({
            "trackIndex": 2,
            "groups": [{ "groupIndex": 1, "notes": [{ "noteIndex": 3, "musicalType": "sing" }] }],
            "groupCount": 1
        }));
        assert_eq!(value["trackIndex"], 1);
        assert_eq!(value["parts"][0]["partIndex"], 0);
        assert_eq!(value["parts"][0]["notes"][0]["noteIndex"], 2);
        assert_eq!(value["parts"][0]["notes"][0]["musicalType"], "singing");
        assert_eq!(value["partCount"], 1);
    }

    #[test]
    fn exact_standard_tool_surface_is_stable() {
        let names = definitions()
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();
        assert_eq!(names, TOOL_NAMES);
    }

    #[test]
    fn direct_hosts_share_sequence_and_transport_names() {
        let flat = normalize_direct(
            HostKind::Flat,
            "transport",
            json!({ "status": "stopped", "playhead": 1.25 }),
        );
        assert_eq!(flat["playheadSeconds"], 1.25);
        assert!(flat.get("playhead").is_none());

        let legacy = normalize_direct(
            HostKind::OfficialSv1,
            "sequence",
            json!({ "timeSignatures": [{ "position": 0, "numerator": 4, "denominator": 4 }] }),
        );
        assert!(legacy.get("measureMarks").is_some());
        assert!(legacy.get("timeSignatures").is_none());
    }

    #[test]
    fn output_labels_cannot_escape_the_managed_directory() {
        assert_eq!(safe_label("../song name"), "___song_name");
        assert_eq!(safe_label(""), "project");
    }

    #[test]
    fn transport_details_are_hidden_from_standard_errors() {
        let error = standard_error("Flat MCP stdio Bridge failed after F13".to_string());
        for private_term in ["Flat MCP", "stdio", "Bridge", "F13"] {
            assert!(!error.contains(private_term));
        }
    }

    #[tokio::test]
    #[ignore = "requires a running local Flat MCP host"]
    async fn live_flat_uses_only_the_standard_surface() {
        let host = synthv_hosts::discover()
            .unwrap()
            .into_iter()
            .find(|host| host.kind == HostKind::Flat && host.running && host.endpoint.is_some())
            .expect("running Flat MCP host");
        let manager = Arc::new(McpManager::default());
        connect(&manager, Path::new("."), &host.id).await.unwrap();
        let status = read_value(&manager, &host.id, "status", json!({}))
            .await
            .unwrap();
        assert!(status.pointer("/playback/playheadSeconds").is_some());
        let tracks = read_value(&manager, &host.id, "tracks", json!({}))
            .await
            .unwrap();
        assert!(tracks.is_array());
        assert!(!host
            .capabilities
            .write_operations
            .contains(&"transport.seek"));
        disconnect(&manager, &host.id).await.unwrap();
    }
}
