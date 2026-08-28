use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pi_agent_core::ChatMessage;
use tokio::sync::RwLock;

use crate::config::{load_settings, ToolboxSettings};
use crate::mcp::McpManager;
use crate::sv2_profiles::Sv2ProfileService;

#[derive(Default)]
pub struct AgentSession {
    pub id: Option<String>,
    pub title: String,
    pub messages: Vec<ChatMessage>,
    pub created_at: String,
}

pub struct AppState {
    pub settings: Arc<RwLock<ToolboxSettings>>,
    pub agent: Arc<Mutex<AgentSession>>,
    pub mcp: Arc<McpManager>,
    pub resource_dir: PathBuf,
    pub bridge_dir: PathBuf,
    pub components_dir: PathBuf,
    pub sv2_profiles: Arc<Sv2ProfileService>,
}

impl AppState {
    pub fn new(resource_dir: PathBuf, bridge_dir: PathBuf, components_dir: PathBuf) -> Self {
        Self {
            settings: Arc::new(RwLock::new(load_settings())),
            agent: Arc::new(Mutex::new(AgentSession::default())),
            mcp: Arc::new(McpManager::default()),
            resource_dir,
            bridge_dir,
            components_dir,
            sv2_profiles: Arc::new(Sv2ProfileService::new()),
        }
    }
}
