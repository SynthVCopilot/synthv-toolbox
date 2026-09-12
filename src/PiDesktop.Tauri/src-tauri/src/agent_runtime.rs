use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use uuid::Uuid;

pub const PROTOCOL_VERSION: &str = "1.0";
pub const HOST_HELLO_METHOD: &str = "host.hello";
pub const RUNTIME_HELLO_METHOD: &str = "runtime.hello";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionRange {
    pub min: String,
    pub max: String,
}

impl VersionRange {
    pub fn exact(version: impl Into<String>) -> Self {
        let version = version.into();
        Self {
            min: version.clone(),
            max: version,
        }
    }

    fn includes(&self, version: &str) -> bool {
        let (Some(min), Some(version), Some(max)) = (
            parse_api_version(&self.min),
            parse_api_version(version),
            parse_api_version(&self.max),
        ) else {
            return false;
        };
        min <= version && version <= max
    }
}

fn parse_api_version(value: &str) -> Option<(u64, u64)> {
    let mut segments = value.split('.');
    let major = segments.next()?.parse().ok()?;
    let minor = segments.next()?.parse().ok()?;
    if segments.next().is_some() {
        return None;
    }
    Some((major, minor))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    pub id: String,
    pub version: String,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostHello {
    #[serde(rename = "hostId")]
    pub host_id: String,
    pub protocol: VersionRange,
    pub capabilities: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeHello {
    #[serde(rename = "runtimeId")]
    pub runtime_id: String,
    pub protocol: VersionRange,
    pub capabilities: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    AlreadyRunning,
    NotRunning,
    Io(String),
    Protocol(String),
    Remote {
        code: String,
        message: String,
        data: Option<Value>,
    },
    Closed,
}

impl Display for RuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning => write!(formatter, "Agent Runtime is already running."),
            Self::NotRunning => write!(formatter, "Agent Runtime is not running."),
            Self::Io(message) => write!(formatter, "Agent Runtime I/O failed: {message}"),
            Self::Protocol(message) => {
                write!(formatter, "Agent Runtime protocol failed: {message}")
            }
            Self::Remote { code, message, .. } => {
                write!(formatter, "Agent Runtime returned {code}: {message}")
            }
            Self::Closed => write!(formatter, "Agent Runtime closed before replying."),
        }
    }
}

impl std::error::Error for RuntimeError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcRequest {
    pub id: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcResponse {
    pub id: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            id: id.into(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(id: impl Into<String>, error: RpcError) -> Self {
        Self {
            id: id.into(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcNotification {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub event: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RuntimeMessage {
    Request(RpcRequest),
    Response(RpcResponse),
    Notification(RpcNotification),
}

pub type CapabilityFuture = Pin<Box<dyn Future<Output = Result<Value, RpcError>> + Send>>;
pub type CapabilityHandler = Arc<dyn Fn(Value) -> CapabilityFuture + Send + Sync>;

#[derive(Debug, Clone)]
pub struct RuntimeCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
}

impl RuntimeCommand {
    pub fn node(entrypoint: impl Into<PathBuf>) -> Self {
        Self {
            program: PathBuf::from("node"),
            args: vec![entrypoint.into().to_string_lossy().into_owned()],
            current_dir: None,
        }
    }
}

pub struct AgentRuntime {
    inner: Arc<Mutex<RuntimeInner>>,
    notifications: broadcast::Sender<RpcNotification>,
}

struct RuntimeInner {
    child: Option<Child>,
    writer: Option<mpsc::Sender<RuntimeMessage>>,
    pending: HashMap<String, oneshot::Sender<Result<Value, RuntimeError>>>,
    capabilities: HashMap<String, CapabilityHandler>,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRuntime {
    pub fn new() -> Self {
        let (notifications, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(Mutex::new(RuntimeInner {
                child: None,
                writer: None,
                pending: HashMap::new(),
                capabilities: HashMap::new(),
            })),
            notifications,
        }
    }

    pub async fn register_capability(&self, method: impl Into<String>, handler: CapabilityHandler) {
        self.inner
            .lock()
            .await
            .capabilities
            .insert(method.into(), handler);
    }

    pub fn subscribe_notifications(&self) -> broadcast::Receiver<RpcNotification> {
        self.notifications.subscribe()
    }

    pub async fn start(
        &self,
        command: RuntimeCommand,
        hello: HostHello,
    ) -> Result<RuntimeHello, RuntimeError> {
        self.start_process(command).await?;
        let response = self
            .request(
                HOST_HELLO_METHOD,
                serde_json::to_value(&hello).unwrap_or(Value::Null),
            )
            .await;
        let runtime_hello = response.and_then(|value| {
            serde_json::from_value::<RuntimeHello>(value)
                .map_err(|error| RuntimeError::Protocol(format!("invalid runtime hello: {error}")))
        });
        match runtime_hello {
            Ok(runtime_hello)
                if hello.protocol.includes(PROTOCOL_VERSION)
                    && runtime_hello.protocol.includes(PROTOCOL_VERSION) =>
            {
                Ok(runtime_hello)
            }
            Ok(runtime_hello) => {
                let _ = self.shutdown().await;
                Err(RuntimeError::Protocol(format!(
                    "no compatible protocol version for host {}-{} and runtime {}-{}",
                    hello.protocol.min,
                    hello.protocol.max,
                    runtime_hello.protocol.min,
                    runtime_hello.protocol.max
                )))
            }
            Err(error) => {
                let _ = self.shutdown().await;
                Err(error)
            }
        }
    }

    async fn start_process(&self, command: RuntimeCommand) -> Result<(), RuntimeError> {
        let mut inner = self.inner.lock().await;
        if let Some(child) = inner.child.as_mut() {
            if child
                .try_wait()
                .map_err(|error| RuntimeError::Io(error.to_string()))?
                .is_none()
            {
                return Err(RuntimeError::AlreadyRunning);
            }
            inner.child = None;
            inner.writer = None;
        }
        let mut process = Command::new(command.program);
        process
            .args(command.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit());
        if let Some(current_dir) = command.current_dir {
            process.current_dir(current_dir);
        }
        let mut child = process
            .spawn()
            .map_err(|error| RuntimeError::Io(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| RuntimeError::Io("could not open runtime stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RuntimeError::Io("could not open runtime stdout".to_string()))?;
        let (writer, receiver) = mpsc::channel(32);
        inner.child = Some(child);
        inner.writer = Some(writer);
        drop(inner);
        tokio::spawn(write_messages(stdin, receiver));
        tokio::spawn(read_messages(
            stdout,
            self.inner.clone(),
            self.notifications.clone(),
        ));
        Ok(())
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, RuntimeError> {
        let request = RpcRequest {
            id: Uuid::new_v4().to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            method: method.into(),
            params,
        };
        let (sender, receiver) = oneshot::channel();
        let writer = {
            let mut inner = self.inner.lock().await;
            let writer = inner.writer.clone().ok_or(RuntimeError::NotRunning)?;
            inner.pending.insert(request.id.clone(), sender);
            writer
        };
        if writer
            .send(RuntimeMessage::Request(request.clone()))
            .await
            .is_err()
        {
            self.inner.lock().await.pending.remove(&request.id);
            return Err(RuntimeError::Closed);
        }
        receiver.await.unwrap_or(Err(RuntimeError::Closed))
    }

    pub async fn notify(
        &self,
        event: impl Into<String>,
        params: Value,
    ) -> Result<(), RuntimeError> {
        let writer = self
            .inner
            .lock()
            .await
            .writer
            .clone()
            .ok_or(RuntimeError::NotRunning)?;
        writer
            .send(RuntimeMessage::Notification(RpcNotification {
                protocol_version: PROTOCOL_VERSION.to_string(),
                event: event.into(),
                params,
            }))
            .await
            .map_err(|_| RuntimeError::Closed)
    }

    pub async fn shutdown(&self) -> Result<(), RuntimeError> {
        let (mut child, pending) = {
            let mut inner = self.inner.lock().await;
            inner.writer.take();
            let child = inner.child.take().ok_or(RuntimeError::NotRunning)?;
            (child, std::mem::take(&mut inner.pending))
        };
        for sender in pending.into_values() {
            let _ = sender.send(Err(RuntimeError::Closed));
        }
        match child
            .try_wait()
            .map_err(|error| RuntimeError::Io(error.to_string()))?
        {
            Some(_) => Ok(()),
            None => {
                child
                    .kill()
                    .await
                    .map_err(|error| RuntimeError::Io(error.to_string()))?;
                child
                    .wait()
                    .await
                    .map_err(|error| RuntimeError::Io(error.to_string()))?;
                Ok(())
            }
        }
    }

    pub async fn is_running(&self) -> bool {
        let mut inner = self.inner.lock().await;
        match inner.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map(|status| status.is_none())
                .unwrap_or(false),
            None => false,
        }
    }
}

async fn write_messages(
    mut stdin: tokio::process::ChildStdin,
    mut receiver: mpsc::Receiver<RuntimeMessage>,
) {
    while let Some(message) = receiver.recv().await {
        let Ok(encoded) = serde_json::to_vec(&message) else {
            continue;
        };
        if stdin.write_all(&encoded).await.is_err()
            || stdin.write_all(b"\n").await.is_err()
            || stdin.flush().await.is_err()
        {
            break;
        }
    }
}

async fn read_messages(
    stdout: tokio::process::ChildStdout,
    inner: Arc<Mutex<RuntimeInner>>,
    notifications: broadcast::Sender<RpcNotification>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match serde_json::from_str::<RuntimeMessage>(&line) {
            Ok(RuntimeMessage::Response(response)) => resolve_response(response, &inner).await,
            Ok(RuntimeMessage::Request(request)) => {
                dispatch_capability(request, inner.clone()).await
            }
            Ok(RuntimeMessage::Notification(notification)) => {
                let _ = notifications.send(notification);
            }
            Err(error) => eprintln!("ignoring invalid Agent Runtime message: {error}"),
        }
    }
    let pending = {
        let mut state = inner.lock().await;
        state.writer = None;
        std::mem::take(&mut state.pending)
    };
    for sender in pending.into_values() {
        let _ = sender.send(Err(RuntimeError::Closed));
    }
}

async fn resolve_response(response: RpcResponse, inner: &Arc<Mutex<RuntimeInner>>) {
    let sender = inner.lock().await.pending.remove(&response.id);
    let Some(sender) = sender else {
        eprintln!(
            "received Agent Runtime response with no pending request: {}",
            response.id
        );
        return;
    };
    if response.protocol_version != PROTOCOL_VERSION {
        let _ = sender.send(Err(RuntimeError::Protocol(format!(
            "response protocol version {} is unsupported",
            response.protocol_version
        ))));
        return;
    }
    let result = match (response.ok, response.result, response.error) {
        (true, Some(result), None) => Ok(result),
        (false, None, Some(error)) => Err(RuntimeError::Remote {
            code: error.code,
            message: error.message,
            data: error.data,
        }),
        _ => Err(RuntimeError::Protocol(
            "response must contain exactly a result or an error".to_string(),
        )),
    };
    let _ = sender.send(result);
}

async fn dispatch_capability(request: RpcRequest, inner: Arc<Mutex<RuntimeInner>>) {
    let (writer, handler) = {
        let state = inner.lock().await;
        (
            state.writer.clone(),
            state.capabilities.get(&request.method).cloned(),
        )
    };
    let Some(writer) = writer else {
        return;
    };
    let response = if request.protocol_version != PROTOCOL_VERSION {
        RpcResponse::failure(
            request.id,
            RpcError {
                code: "unsupported_protocol_version".to_string(),
                message: format!("Unsupported protocol version {}.", request.protocol_version),
                data: Some(serde_json::json!({ "supported": PROTOCOL_VERSION })),
            },
        )
    } else if let Some(handler) = handler {
        match handler(request.params).await {
            Ok(result) => RpcResponse::success(request.id, result),
            Err(error) => RpcResponse::failure(request.id, error),
        }
    } else {
        RpcResponse::failure(
            request.id,
            RpcError {
                code: "capability_not_available".to_string(),
                message: format!("No host capability is registered for {}.", request.method),
                data: None,
            },
        )
    };
    if writer
        .send(RuntimeMessage::Response(response))
        .await
        .is_err()
    {
        eprintln!("could not send Agent Runtime capability response");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_messages_match_the_shared_wire_schema() {
        let message = RuntimeMessage::Response(RpcResponse::success(
            "request-1",
            serde_json::json!({ "value": 1 }),
        ));
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({
                "kind": "response", "id": "request-1", "protocolVersion": "1.0", "ok": true, "result": { "value": 1 }
            })
        );
    }
}
