use std::fs;
use std::path::Path;

use chrono::Utc;
use pi_agent_core::{
    AgentLoop, ChatMessage, Conversation, ConversationStore, JsonConversationStore, NoTools, Role,
};
use pi_agent_provider::PiConfig;
use serde::Serialize;
use serde_json::json;
use tauri::State;
use tokio::runtime::Handle;
use uuid::Uuid;

use crate::components::{component_list, open_component_download, ComponentInfo};
use crate::config::{
    load_model_settings, model_config_path, model_summary, save_model_settings as persist_model,
    save_settings, validate_mcp_server, AppMode, McpServerConfig, ModelSummary,
};
use crate::downloads::ComponentDownload;
use crate::mcp::McpToolExecutor;
use crate::state::{AgentSession, AppState};
use crate::sv2_concurrent::Sv2IsolationPreference;
use crate::sv2_profiles::Sv2ProfilesState;
use crate::synthv::{
    bridge_is_bundled, diagnose_bridge as diagnose_bridge_impl, failed, find_node,
    install_bridge as install_bridge_impl, normalized_path_string, scan_installations, succeeded,
    OperationResult, SynthVInstallation,
};
use crate::workflows::{self, WorkflowResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    onboarding_completed: bool,
    mode: AppMode,
    platform: String,
    app_version: String,
    config_path: String,
    model: Option<ModelSummary>,
    scripts_path: Option<String>,
    bridge_bundled: bool,
    bridge_connected: bool,
    installations: Vec<SynthVInstallation>,
    components: Vec<ComponentInfo>,
    downloads: Vec<ComponentDownload>,
    mcp_servers: Vec<McpServerConfig>,
    concurrent_disclaimer_accepted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    id: String,
    title: String,
    updated_at: String,
    message_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    id: String,
    title: String,
    messages: Vec<ChatMessage>,
}

#[tauri::command]
pub async fn bootstrap(state: State<'_, AppState>) -> Result<BootstrapState, String> {
    build_bootstrap(&state).await
}

#[tauri::command]
pub async fn complete_onboarding(
    mode: AppMode,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    {
        let mut settings = state.settings.write().await;
        settings.mode = mode;
        settings.onboarding_completed = true;
        save_settings(&settings)?;
    }
    build_bootstrap(&state).await
}

#[tauri::command]
pub async fn set_mode(mode: AppMode, state: State<'_, AppState>) -> Result<BootstrapState, String> {
    let external_ids = {
        let mut settings = state.settings.write().await;
        let ids = settings
            .mcp_servers
            .iter()
            .map(|server| server.id.clone())
            .collect::<Vec<_>>();
        settings.mode = mode;
        settings.onboarding_completed = true;
        save_settings(&settings)?;
        ids
    };
    if mode == AppMode::Toolbox {
        for id in external_ids {
            state.mcp.disconnect(&id).await;
        }
    }
    build_bootstrap(&state).await
}

#[tauri::command]
pub async fn save_model_settings(
    base_url: String,
    model: String,
    token: Option<String>,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    require_ai(&state).await?;
    persist_model(base_url, model, token)?;
    build_bootstrap(&state).await
}

#[tauri::command]
pub fn scan_synthv() -> Vec<SynthVInstallation> {
    scan_installations()
}

#[tauri::command]
pub async fn sv2_profile_state(state: State<'_, AppState>) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.state())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn import_current_sv2_profile(
    display_name: String,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.import_current(display_name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_sv2_profile(
    display_name: String,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.create_slot(display_name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rename_sv2_profile(
    slot_id: String,
    display_name: String,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.rename_slot(slot_id, display_name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_sv2_profile_identity(
    slot_id: String,
    username: String,
    email: String,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.update_identity(slot_id, username, email))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_sv2_concurrent_defaults(
    app_settings: bool,
    voice_libraries: bool,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || {
        profiles.update_concurrent_defaults(app_settings, voice_libraries)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_sv2_concurrent_content(
    slot_id: String,
    app_settings: Sv2IsolationPreference,
    voice_libraries: Sv2IsolationPreference,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || {
        profiles.update_concurrent_content(slot_id, app_settings, voice_libraries)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn activate_sv2_profile(
    slot_id: String,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.activate_slot(slot_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn launch_sv2_profile(
    slot_id: String,
    project_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.launch_slot(slot_id, project_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn force_launch_sv2_profile(
    slot_id: String,
    project_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.force_launch_slot(slot_id, project_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_sv2_profile_folder(
    slot_id: String,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.open_slot_folder(slot_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn prepare_sv2_concurrent_profile(
    slot_id: String,
    state: State<'_, AppState>,
) -> Result<Sv2ProfilesState, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.prepare_concurrent_slot(slot_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn launch_sv2_concurrent_profile(
    slot_id: String,
    project_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    if !state.settings.read().await.concurrent_disclaimer_accepted {
        return Err(
            "首次使用并发隔离前，必须确认这种运行方式尚未被 Dreamtonics 官方承认。".to_string(),
        );
    }
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || {
        profiles.launch_concurrent_slot(slot_id, project_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn accept_sv2_concurrent_disclaimer(
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    {
        let mut settings = state.settings.write().await;
        settings.concurrent_disclaimer_accepted = true;
        save_settings(&settings)?;
    }
    build_bootstrap(&state).await
}

#[tauri::command]
pub async fn open_sv2_concurrent_folder(
    slot_id: String,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    let profiles = state.sv2_profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.open_concurrent_folder(slot_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_scripts_path(
    scripts_path: String,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    let scripts_path = Path::new(scripts_path.trim());
    if !scripts_path.is_dir() {
        return Err("目标不是有效的 SynthV scripts 目录。".to_string());
    }
    let scripts_path = normalized_path_string(scripts_path);
    {
        let mut settings = state.settings.write().await;
        settings.scripts_path = Some(scripts_path);
        save_settings(&settings)?;
    }
    build_bootstrap(&state).await
}

#[tauri::command]
pub async fn install_bridge(
    scripts_path: String,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    let bridge_dir = state.bridge_dir.clone();
    tauri::async_runtime::spawn_blocking(move || install_bridge_impl(&bridge_dir, &scripts_path))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn diagnose_bridge(
    scripts_path: String,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    let bridge_dir = state.bridge_dir.clone();
    tauri::async_runtime::spawn_blocking(move || diagnose_bridge_impl(&bridge_dir, &scripts_path))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn connect_bridge(state: State<'_, AppState>) -> Result<OperationResult, String> {
    if !bridge_is_bundled(&state.bridge_dir) {
        return Ok(failed("当前构建未包含完整的 SynthV Bridge。", ""));
    }
    let Some(node) = find_node() else {
        return Ok(failed(
            "未找到 Node.js。",
            "可设置 PI_AGENT_NODE 指向 Node.js 22.19+。",
        ));
    };
    match state
        .mcp
        .connect_bridge(node, state.bridge_dir.clone())
        .await
    {
        Ok(tools) => Ok(succeeded(
            "SynthV Bridge 已连接。",
            format!("已发现工具：{}", tools.join("、")),
        )),
        Err(error) => Ok(failed("SynthV Bridge 连接失败。", error)),
    }
}

#[tauri::command]
pub fn component_downloads(state: State<'_, AppState>) -> Vec<ComponentDownload> {
    state.downloads.snapshot()
}

#[tauri::command]
pub fn queue_component_install(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ComponentDownload>, String> {
    let (snapshot, start_worker) = state.downloads.enqueue(&id)?;
    if start_worker {
        let manager = state.downloads.clone();
        let components_dir = state.components_dir.clone();
        let resource_dir = state.resource_dir.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_worker(components_dir, resource_dir).await;
        });
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn open_downloaded_component(id: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || open_component_download(&id))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn run_audio_probe(
    audio_path: String,
    advanced: bool,
    state: State<'_, AppState>,
) -> Result<WorkflowResult, String> {
    if advanced {
        require_ai(&state).await?;
    }
    let resource_dir = state.resource_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        workflows::audio_probe(audio_path, advanced, &resource_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn run_game_to_midi(
    vocal_path: String,
    instrumental_path: String,
    output_name: String,
    tolerance: f64,
    advanced: bool,
    state: State<'_, AppState>,
) -> Result<WorkflowResult, String> {
    let mode = state.settings.read().await.mode;
    if mode != AppMode::Ai && (advanced || (tolerance - 0.08).abs() > f64::EPSILON) {
        return Err(
            "纯工具箱模式仅提供固定参数的基础 MIDI 提取；高级纠正、置信度检查和参数微调只在 AI 模式可用。"
                .to_string(),
        );
    }
    let resource_dir = state.resource_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        workflows::game_to_midi(
            vocal_path,
            instrumental_path,
            output_name,
            tolerance,
            advanced,
            &resource_dir,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn run_project_probe(
    project_path: String,
    state: State<'_, AppState>,
) -> Result<WorkflowResult, String> {
    let resource_dir = state.resource_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        workflows::project_probe(project_path, &resource_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn add_project_reference(
    project_path: String,
    audio_path: String,
    track_name: String,
    begin_seconds: f64,
    output_name: String,
    state: State<'_, AppState>,
) -> Result<WorkflowResult, String> {
    let resource_dir = state.resource_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        workflows::add_project_reference(
            project_path,
            audio_path,
            track_name,
            begin_seconds,
            output_name,
            &resource_dir,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn review_workflow(
    kind: String,
    data: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String, String> {
    require_ai(&state).await?;
    if !matches!(
        kind.as_str(),
        "game-midi" | "audio-insight" | "project-probe" | "project-reference"
    ) {
        return Err("工作流类型不受支持。".to_string());
    }
    let payload = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
    if payload.len() > 128_000 {
        return Err("工作流结果过大，无法提交模型复核。".to_string());
    }
    let model = load_model_settings().ok_or_else(|| "请先在设置中配置模型。".to_string())?;
    if model.auth_token.is_empty() {
        return Err("模型访问令牌尚未配置。".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let config_json = json!({
            "provider": "anthropic",
            "anthropic": {
                "base_url": model.base_url,
                "model": model.model,
                "auth_token": model.auth_token,
            }
        })
        .to_string();
        let config = PiConfig::from_json(&config_json).map_err(|error| error.to_string())?;
        let provider = config.build_provider().map_err(|error| error.to_string())?;
        let mut messages = vec![ChatMessage {
            role: Role::System,
            content: "你是 SynthV Toolbox 的工作流复核器。只根据结构化结果判断可靠性、异常和下一步；不得声称已修改文件。用简洁中文输出：结论、风险、建议参数。".to_string(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }];
        let prompt = format!("工作流类型：{kind}\n请复核以下 JSON：\n{payload}");
        let added = AgentLoop::new(provider.as_ref(), &NoTools)
            .run_turn(&mut messages, &prompt)
            .map_err(|error| error.to_string())?;
        added
            .into_iter()
            .rev()
            .find(|message| message.role == Role::Assistant && !message.content.trim().is_empty())
            .map(|message| message.content)
            .ok_or_else(|| "模型没有返回可见的复核内容。".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_mcp_server(
    server: McpServerConfig,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    require_ai(&state).await?;
    validate_mcp_server(&server)?;
    state.mcp.disconnect(&server.id).await;
    {
        let mut settings = state.settings.write().await;
        if let Some(existing) = settings
            .mcp_servers
            .iter_mut()
            .find(|existing| existing.id == server.id)
        {
            *existing = server;
        } else {
            settings.mcp_servers.push(server);
        }
        save_settings(&settings)?;
    }
    build_bootstrap(&state).await
}

#[tauri::command]
pub async fn delete_mcp_server(
    id: String,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    require_ai(&state).await?;
    state.mcp.disconnect(&id).await;
    {
        let mut settings = state.settings.write().await;
        settings.mcp_servers.retain(|server| server.id != id);
        save_settings(&settings)?;
    }
    build_bootstrap(&state).await
}

#[tauri::command]
pub async fn test_mcp_server(
    id: String,
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    require_ai(&state).await?;
    let server = {
        let settings = state.settings.read().await;
        settings
            .mcp_servers
            .iter()
            .find(|server| server.id == id)
            .cloned()
            .ok_or_else(|| "找不到 MCP 配置。".to_string())?
    };
    match state.mcp.test_config(&server).await {
        Ok(tools) => Ok(succeeded(
            format!("{} 已连接。", server.name),
            format!("发现 {} 个工具：{}", tools.len(), tools.join("、")),
        )),
        Err(error) => Ok(failed(format!("{} 连接失败。", server.name), error)),
    }
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<ConversationSummary>, String> {
    require_ai(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        JsonConversationStore::new(pi_agent_core::history_dir())
            .list()
            .map(|items| {
                items
                    .into_iter()
                    .map(|conversation| ConversationSummary {
                        id: conversation.id,
                        title: conversation.title,
                        updated_at: conversation.updated_at,
                        message_count: visible_messages(&conversation.messages).len(),
                    })
                    .collect()
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn new_conversation(state: State<'_, AppState>) -> Result<ConversationSnapshot, String> {
    require_ai(&state).await?;
    let now = Utc::now().to_rfc3339();
    let session = AgentSession {
        id: Some(Uuid::new_v4().to_string()),
        title: "新对话".to_string(),
        messages: Vec::new(),
        created_at: now.clone(),
    };
    let conversation = session_to_conversation(&session, now)?;
    save_conversation(&conversation)?;
    let snapshot = snapshot(&conversation);
    *state
        .agent
        .lock()
        .map_err(|_| "会话状态锁已损坏".to_string())? = session;
    Ok(snapshot)
}

#[tauri::command]
pub async fn open_conversation(
    id: String,
    state: State<'_, AppState>,
) -> Result<ConversationSnapshot, String> {
    require_ai(&state).await?;
    validate_conversation_id(&id)?;
    let requested = id.clone();
    let conversation = tauri::async_runtime::spawn_blocking(move || {
        JsonConversationStore::new(pi_agent_core::history_dir())
            .get(&requested)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "找不到该会话。".to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let session = AgentSession {
        id: Some(conversation.id.clone()),
        title: conversation.title.clone(),
        messages: conversation.messages.clone(),
        created_at: conversation.created_at.clone(),
    };
    *state
        .agent
        .lock()
        .map_err(|_| "会话状态锁已损坏".to_string())? = session;
    Ok(snapshot(&conversation))
}

#[tauri::command]
pub async fn send_message(
    input: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    require_ai(&state).await?;
    let input = input.trim().to_string();
    if input.is_empty() {
        return Err("消息不能为空。".to_string());
    }
    if input.chars().count() > 32_000 {
        return Err("消息超过 32,000 字符限制。".to_string());
    }
    let model = load_model_settings().ok_or_else(|| "请先在设置中配置模型。".to_string())?;
    if model.auth_token.is_empty() {
        return Err("模型访问令牌尚未配置。".to_string());
    }
    let mcp_configs = state.settings.read().await.mcp_servers.clone();
    state.mcp.ensure_configured(&mcp_configs).await?;
    let bindings = state.mcp.bindings().await;
    let runtime = Handle::current();
    let session = state.agent.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config_json = json!({
            "provider": "anthropic",
            "anthropic": {
                "base_url": model.base_url,
                "model": model.model,
                "auth_token": model.auth_token,
            }
        })
        .to_string();
        let config = PiConfig::from_json(&config_json).map_err(|error| error.to_string())?;
        let provider = config.build_provider().map_err(|error| error.to_string())?;
        let mut session = session.lock().map_err(|_| "会话状态锁已损坏".to_string())?;
        ensure_session(&mut session);
        let added = if bindings.is_empty() {
            AgentLoop::new(provider.as_ref(), &NoTools).run_turn(&mut session.messages, &input)
        } else {
            let executor = McpToolExecutor::new(bindings, runtime);
            AgentLoop::new(provider.as_ref(), &executor).run_turn(&mut session.messages, &input)
        }
        .map_err(|error| error.to_string())?;
        if session.title == "新对话" {
            session.title = input.chars().take(28).collect();
        }
        let conversation = session_to_conversation(&session, Utc::now().to_rfc3339())?;
        save_conversation(&conversation)?;
        Ok(visible_messages(&added))
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn require_ai(state: &State<'_, AppState>) -> Result<(), String> {
    if state.settings.read().await.mode != AppMode::Ai {
        return Err("此能力只在 AI 模式下可用。请先在设置中切换模式。".to_string());
    }
    Ok(())
}

async fn build_bootstrap(state: &State<'_, AppState>) -> Result<BootstrapState, String> {
    let settings = state.settings.read().await.clone();
    Ok(BootstrapState {
        onboarding_completed: settings.onboarding_completed,
        mode: settings.mode,
        platform: std::env::consts::OS.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        config_path: model_config_path().to_string_lossy().into_owned(),
        model: model_summary(),
        scripts_path: settings
            .scripts_path
            .as_deref()
            .map(|path| normalized_path_string(Path::new(path))),
        bridge_bundled: bridge_is_bundled(&state.bridge_dir),
        bridge_connected: state.mcp.is_connected("synthv").await,
        installations: scan_installations(),
        components: component_list(&state.resource_dir),
        downloads: state.downloads.snapshot(),
        mcp_servers: settings.mcp_servers,
        concurrent_disclaimer_accepted: settings.concurrent_disclaimer_accepted,
    })
}

fn ensure_session(session: &mut AgentSession) {
    if session.id.is_some() {
        return;
    }
    let now = Utc::now().to_rfc3339();
    session.id = Some(Uuid::new_v4().to_string());
    session.title = "新对话".to_string();
    session.created_at = now;
}

fn session_to_conversation(
    session: &AgentSession,
    updated_at: String,
) -> Result<Conversation, String> {
    Ok(Conversation {
        id: session
            .id
            .clone()
            .ok_or_else(|| "会话尚未初始化".to_string())?,
        title: session.title.clone(),
        created_at: session.created_at.clone(),
        updated_at,
        messages: session.messages.clone(),
    })
}

fn snapshot(conversation: &Conversation) -> ConversationSnapshot {
    ConversationSnapshot {
        id: conversation.id.clone(),
        title: conversation.title.clone(),
        messages: visible_messages(&conversation.messages),
    }
}

fn visible_messages(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages
        .iter()
        .filter(|message| {
            matches!(message.role, Role::User | Role::Assistant) && !message.content.is_empty()
        })
        .cloned()
        .collect()
}

fn validate_conversation_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("会话 ID 非法。".to_string());
    }
    Ok(())
}

fn save_conversation(conversation: &Conversation) -> Result<(), String> {
    validate_conversation_id(&conversation.id)?;
    let directory = pi_agent_core::history_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(format!("{}.json", conversation.id));
    let temporary = directory.join(format!("{}.json.tmp", conversation.id));
    fs::write(
        &temporary,
        serde_json::to_string_pretty(conversation).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if target.exists() {
        fs::remove_file(&target).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, &target).map_err(|error| error.to_string())
}
