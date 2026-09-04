use std::sync::Arc;

use axum::{
    extract::{Json, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    net::TcpListener,
    runtime::Handle,
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

use crate::{
    agent::{ToolCall, ToolExecutor},
    audio_capture::{ToolboxAudioToolContext, ToolboxAudioToolExecutor},
    config::DEFAULT_HTTP_API_PORT,
    mcp::McpToolExecutor,
    state::AppState,
};

const PROTOCOL_VERSION: &str = "2025-06-18";
const ENDPOINT_PATH: &str = "/mcp";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpApiStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub endpoint: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct HttpApiManager {
    state: Mutex<ManagerState>,
}

#[derive(Default)]
struct ManagerState {
    port: u16,
    running: bool,
    last_error: Option<String>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl HttpApiManager {
    pub async fn status_async(&self, enabled: bool, port: u16) -> HttpApiStatus {
        let state = self.state.lock().await;
        HttpApiStatus {
            enabled,
            running: state.running,
            port,
            endpoint: enabled.then(|| endpoint(port)),
            last_error: state.last_error.clone(),
        }
    }

    pub async fn start_if_enabled(self: Arc<Self>, context: HttpApiContext) -> Result<(), String> {
        if context.enabled {
            self.start(context).await
        } else {
            self.stop().await;
            Ok(())
        }
    }

    pub async fn start(self: &Arc<Self>, context: HttpApiContext) -> Result<(), String> {
        if let Err(error) = validate_port(context.port) {
            let mut state = self.state.lock().await;
            state.port = context.port;
            state.running = false;
            state.last_error = Some(error.clone());
            return Err(error);
        }
        {
            let state = self.state.lock().await;
            if state.running && state.port == context.port {
                return Ok(());
            }
        }
        self.stop().await;
        let listener = match TcpListener::bind(("127.0.0.1", context.port)).await {
            Ok(listener) => listener,
            Err(error) => {
                let message = format!("无法启动本地 HTTP MCP（端口 {}）：{error}", context.port);
                let mut state = self.state.lock().await;
                state.port = context.port;
                state.running = false;
                state.last_error = Some(message.clone());
                return Err(message);
            }
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.state.lock().await;
            state.port = context.port;
            state.running = true;
            state.last_error = None;
            state.shutdown = Some(sender);
        }
        let manager = Arc::clone(self);
        let task = tokio::spawn(async move {
            let router = Router::new()
                .route("/health", get(health))
                .route(ENDPOINT_PATH, get(get_mcp).post(post_mcp))
                .with_state(Arc::new(context));
            let result = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await;
            let mut state = manager.state.lock().await;
            state.running = false;
            state.shutdown = None;
            if let Err(error) = result {
                state.last_error = Some(format!("HTTP MCP 服务已停止：{error}"));
            }
        });
        self.state.lock().await.task = Some(task);
        Ok(())
    }

    pub async fn stop(&self) {
        let (sender, task) = {
            let mut state = self.state.lock().await;
            (state.shutdown.take(), state.task.take())
        };
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
        if let Some(task) = task {
            let _ = task.await;
        }
        let mut state = self.state.lock().await;
        state.running = false;
        state.last_error = None;
    }
}

#[derive(Clone)]
pub struct HttpApiContext {
    pub enabled: bool,
    pub port: u16,
    pub mcp: Arc<crate::mcp::McpManager>,
    pub settings: Arc<tokio::sync::RwLock<crate::config::ToolboxSettings>>,
    pub bridge_dir: std::path::PathBuf,
    pub resource_dir: std::path::PathBuf,
    pub components_dir: std::path::PathBuf,
    pub downloads: Arc<crate::downloads::ComponentDownloadManager>,
    pub media_tasks: Arc<crate::media_tasks::MediaTaskManager>,
    pub file_approvals: Arc<crate::agent_files::FileApprovalManager>,
}

impl HttpApiContext {
    pub fn from_state(state: &AppState) -> Self {
        Self {
            enabled: false,
            port: DEFAULT_HTTP_API_PORT,
            mcp: state.mcp.clone(),
            settings: state.settings.clone(),
            bridge_dir: state.bridge_dir.clone(),
            resource_dir: state.resource_dir.clone(),
            components_dir: state.components_dir.clone(),
            downloads: state.downloads.clone(),
            media_tasks: state.media_tasks.clone(),
            file_approvals: state.file_approvals.clone(),
        }
    }

    async fn executor(&self) -> Result<ToolboxAudioToolExecutor, String> {
        let settings = self.settings.read().await.clone();
        self.mcp.ensure_configured(&settings.mcp_servers).await?;
        let runtime = Handle::current();
        let work_mode = settings.agent_work_mode;
        Ok(ToolboxAudioToolExecutor::new(
            McpToolExecutor::new(self.mcp.bindings().await, runtime.clone()),
            ToolboxAudioToolContext {
                manager: self.mcp.clone(),
                runtime,
                bridge_dir: self.bridge_dir.clone(),
                resource_dir: self.resource_dir.clone(),
                components_dir: self.components_dir.clone(),
                downloads: self.downloads.clone(),
                media_tasks: self.media_tasks.clone(),
                file_approvals: self.file_approvals.clone(),
                conversation_id: "http-mcp".to_string(),
                work_mode,
            },
        ))
    }
}

fn endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}{ENDPOINT_PATH}")
}

pub fn validate_port(port: u16) -> Result<(), String> {
    if port == 0 {
        Err("HTTP MCP 端口必须是 1–65535。".to_string())
    } else {
        Ok(())
    }
}

async fn health(State(context): State<Arc<HttpApiContext>>) -> impl IntoResponse {
    Json(json!({"status":"ok", "enabled": context.enabled, "port": context.port}))
}

async fn get_mcp() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

async fn post_mcp(
    State(context): State<Arc<HttpApiContext>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let wants_sse = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .any(|item| item.trim() == "text/event-stream")
        })
        .unwrap_or(false);
    let response = match handle_rpc(&context, request).await {
        Ok(Some(value)) => value,
        Ok(None) => return StatusCode::ACCEPTED.into_response(),
        Err((id, code, message)) => {
            json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
        }
    };
    if wants_sse {
        let body = format!("data: {}\n\n", response);
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(body.into())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    } else {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            Json(response),
        )
            .into_response()
    }
}

async fn handle_rpc(
    context: &HttpApiContext,
    request: Value,
) -> Result<Option<Value>, (Value, i32, String)> {
    let object =
        request
            .as_object()
            .ok_or((Value::Null, -32600, "无效的 JSON-RPC 请求。".to_string()))?;
    let id = object.get("id").cloned();
    let method = object.get("method").and_then(Value::as_str).ok_or((
        id.clone().unwrap_or(Value::Null),
        -32600,
        "JSON-RPC method 缺失。".to_string(),
    ))?;
    if id.is_none() {
        if method == "notifications/initialized" {
            return Ok(None);
        }
        return Ok(None);
    }
    let id = id.unwrap();
    let result = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "synthv-toolbox", "version": env!("CARGO_PKG_VERSION")}
        }),
        "ping" => json!({}),
        "tools/list" => {
            let executor = context
                .executor()
                .await
                .map_err(|error| (id.clone(), -32603, error))?;
            let tools = executor.tools().into_iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": serde_json::from_str::<Value>(&tool.input_schema_json).unwrap_or_else(|_| json!({"type":"object"}))
            })).collect::<Vec<_>>();
            json!({"tools": tools})
        }
        "tools/call" => {
            let params = object.get("params").and_then(Value::as_object).ok_or((
                id.clone(),
                -32602,
                "tools/call params 无效。".to_string(),
            ))?;
            let name = params.get("name").and_then(Value::as_str).ok_or((
                id.clone(),
                -32602,
                "tools/call 缺少 name。".to_string(),
            ))?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let executor = context
                .executor()
                .await
                .map_err(|error| (id.clone(), -32603, error))?;
            let result = executor
                .execute(&ToolCall {
                    id: id.to_string(),
                    tool_name: name.to_string(),
                    arguments_json: arguments.to_string(),
                })
                .map_err(|error| (id.clone(), -32603, error.to_string()))?;
            json!({"content":[{"type":"text","text":result.result_json}], "isError":result.is_error})
        }
        _ => return Err((id, -32601, format!("不支持的方法：{method}"))),
    };
    Ok(Some(json!({"jsonrpc":"2.0", "id":id, "result":result})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_zero_port() {
        assert!(validate_port(0).is_err());
        assert!(validate_port(17_831).is_ok());
        assert!(validate_port(u16::MAX).is_ok());
    }

    #[tokio::test]
    async fn initialize_and_ping_use_json_rpc_envelopes() {
        let context = HttpApiContext {
            enabled: true,
            port: 17_831,
            mcp: Arc::new(crate::mcp::McpManager::default()),
            settings: Arc::new(tokio::sync::RwLock::new(
                crate::config::ToolboxSettings::default(),
            )),
            bridge_dir: std::path::PathBuf::new(),
            resource_dir: std::path::PathBuf::new(),
            components_dir: std::path::PathBuf::new(),
            downloads: Arc::new(crate::downloads::ComponentDownloadManager::persistent()),
            media_tasks: crate::media_tasks::MediaTaskManager::persistent(
                std::path::PathBuf::new(),
                std::path::PathBuf::new(),
                Arc::new(crate::mcp::McpManager::default()),
            ),
            file_approvals: Arc::new(crate::agent_files::FileApprovalManager::default()),
        };
        let response = handle_rpc(
            &context,
            json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSION);
        let response = handle_rpc(&context, json!({"jsonrpc":"2.0","id":2,"method":"ping"}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response["result"], json!({}));
    }
}
