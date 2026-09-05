//! SynthV Toolbox 的极简 MCP (Model Context Protocol) stdio 客户端。
//!
//! 以子进程方式拉起本地 stdio MCP server（如 synthv-agent-bridge 的
//! `node dist/src/cli.js`），用换行分隔的 JSON-RPC 2.0 做 initialize /
//! tools/list / tools/call。零第三方 SDK，仅 serde_json + tokio。

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

/// 如何拉起一个 MCP server 子进程。
#[derive(Debug, Clone)]
pub struct McpServerSpec {
    pub command: String,
    pub args: Vec<String>,
    pub working_dir: Option<PathBuf>,
    pub env: HashMap<String, String>,
}

/// MCP 客户端错误。
#[derive(Debug)]
pub struct McpError(pub String);

impl fmt::Display for McpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for McpError {}
impl From<std::io::Error> for McpError {
    fn from(e: std::io::Error) -> Self {
        McpError(format!("io: {e}"))
    }
}
impl From<serde_json::Error> for McpError {
    fn from(e: serde_json::Error) -> Self {
        McpError(format!("json: {e}"))
    }
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<std::result::Result<Value, McpError>>>>>;

/// 一个运行中的 MCP stdio 客户端。Drop 时 kill 子进程。
pub struct McpStdioClient {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicI64,
    _child: Child,
}

impl McpStdioClient {
    /// 拉起子进程并启动读循环。
    pub fn start(spec: &McpServerSpec) -> std::result::Result<Self, McpError> {
        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = &spec.working_dir {
            cmd.current_dir(dir);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError("无 stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError("无 stdout".into()))?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let read_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(node) = serde_json::from_str::<Value>(&line) else {
                    continue; // 非 JSON 行（日志）忽略
                };
                let Some(id) = node.get("id").and_then(|v| v.as_i64()) else {
                    continue; // 服务器发起的 notification：六工具面不需要处理
                };
                if let Some(tx) = read_pending.lock().await.remove(&id) {
                    if let Some(err) = node.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("MCP error")
                            .to_string();
                        let _ = tx.send(Err(McpError(msg)));
                    } else {
                        let _ = tx.send(Ok(node.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
            }
            for (_, pending) in read_pending.lock().await.drain() {
                let _ = pending.send(Err(McpError("响应流已关闭（子进程可能已退出）".into())));
            }
        });

        Ok(Self {
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicI64::new(0),
            _child: child,
        })
    }

    async fn request(&self, method: &str, params: Value) -> std::result::Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_line(&msg).await?;

        rx.await
            .map_err(|_| McpError("响应通道关闭（子进程可能已退出）".into()))?
    }

    async fn notify(&self, method: &str, params: Value) -> std::result::Result<(), McpError> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.write_line(&msg).await
    }

    async fn write_line(&self, msg: &Value) -> std::result::Result<(), McpError> {
        let mut line = serde_json::to_string(msg)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// MCP 握手。
    pub async fn initialize(
        &self,
        client_name: &str,
        client_version: &str,
    ) -> std::result::Result<Value, McpError> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": {} },
                    "clientInfo": { "name": client_name, "version": client_version }
                }),
            )
            .await?;
        self.notify("notifications/initialized", json!({})).await?;
        Ok(result)
    }

    /// 列出工具。
    pub async fn list_tools(&self) -> std::result::Result<Value, McpError> {
        self.request("tools/list", json!({})).await
    }

    /// 调用工具。
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
    ) -> std::result::Result<Value, McpError> {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }
}
