use std::fmt;

/// Toolbox Agent 统一错误类型（保持轻量，不引入 anyhow/thiserror）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentErrorKind {
    Other,
    Http(u16),
    Transport,
}

#[derive(Debug)]
pub struct AgentError {
    message: String,
    kind: AgentErrorKind,
}

impl AgentError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
            kind: AgentErrorKind::Other,
        }
    }

    pub fn http(status: u16, msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
            kind: AgentErrorKind::Http(status),
        }
    }

    pub fn transport(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
            kind: AgentErrorKind::Transport,
        }
    }

    pub fn kind(&self) -> AgentErrorKind {
        self.kind
    }
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AgentError {}

impl From<serde_json::Error> for AgentError {
    fn from(e: serde_json::Error) -> Self {
        AgentError::new(format!("json: {e}"))
    }
}

impl From<std::io::Error> for AgentError {
    fn from(e: std::io::Error) -> Self {
        AgentError::new(format!("io: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, AgentError>;
