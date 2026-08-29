use std::fmt;

/// Toolbox Agent 统一错误类型（保持轻量，不引入 anyhow/thiserror）。
#[derive(Debug)]
pub struct AgentError(pub String);

impl AgentError {
    pub fn new(msg: impl Into<String>) -> Self {
        AgentError(msg.into())
    }
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AgentError {}

impl From<serde_json::Error> for AgentError {
    fn from(e: serde_json::Error) -> Self {
        AgentError(format!("json: {e}"))
    }
}

impl From<std::io::Error> for AgentError {
    fn from(e: std::io::Error) -> Self {
        AgentError(format!("io: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, AgentError>;
