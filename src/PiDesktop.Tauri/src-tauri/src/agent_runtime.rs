use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    AlreadyRunning,
    NotRunning,
    Io(String),
    Protocol(String),
    Remote { code: String, message: String },
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
            Self::Remote { code, message } => {
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
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcNotification {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeMessage {
    Request(RpcRequest),
    Response(RpcResponse),
    Notification(RpcNotification),
}

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
}

struct RuntimeInner {
    child: Option<Child>,
    writer: Option<mpsc::Sender<RuntimeMessage>>,
    pending: HashMap<String, oneshot::Sender<Result<Value, RuntimeError>>>,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimeInner {
                child: None,
                writer: None,
                pending: HashMap::new(),
            })),
        }
    }

    pub async fn start(&self, command: RuntimeCommand) -> Result<(), RuntimeError> {
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
        tokio::spawn(read_messages(stdout, self.inner.clone()));
        Ok(())
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, RuntimeError> {
        let request = RpcRequest {
            id: Uuid::new_v4().to_string(),
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
        method: impl Into<String>,
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
                method: method.into(),
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
            let pending = std::mem::take(&mut inner.pending);
            (child, pending)
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

async fn read_messages(stdout: tokio::process::ChildStdout, inner: Arc<Mutex<RuntimeInner>>) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let message = match serde_json::from_str::<RuntimeMessage>(&line) {
            Ok(message) => message,
            Err(_) => continue,
        };
        if let RuntimeMessage::Response(response) = message {
            let sender = inner.lock().await.pending.remove(&response.id);
            if let Some(sender) = sender {
                let result = match (response.result, response.error) {
                    (_, Some(error)) => Err(RuntimeError::Remote {
                        code: error.code,
                        message: error.message,
                    }),
                    (Some(result), None) => Ok(result),
                    (None, None) => Err(RuntimeError::Protocol(
                        "response did not contain a result or error".to_string(),
                    )),
                };
                let _ = sender.send(result);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_messages_use_a_stable_type_tag() {
        let message = RuntimeMessage::Request(RpcRequest {
            id: "request-1".to_string(),
            method: "runtime.ping".to_string(),
            params: serde_json::json!({ "value": 1 }),
        });

        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({
                "type": "request",
                "id": "request-1",
                "method": "runtime.ping",
                "params": { "value": 1 }
            })
        );
    }
}
