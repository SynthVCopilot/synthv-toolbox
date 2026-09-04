use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio::sync::RwLock;

use crate::agent::ChatMessage;
use crate::agent_files::FileApprovalManager;
use crate::audio_prep::AudioPreparationService;
use crate::config::ToolboxSettings;
use crate::credential_balancer::CredentialBalancer;
use crate::downloads::ComponentDownloadManager;
use crate::http_api::HttpApiManager;
use crate::mcp::McpManager;
use crate::media_tasks::MediaTaskManager;
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
    pub file_approvals: Arc<FileApprovalManager>,
    pub mcp: Arc<McpManager>,
    pub resource_dir: PathBuf,
    pub bridge_dir: PathBuf,
    pub components_dir: PathBuf,
    pub downloads: Arc<ComponentDownloadManager>,
    pub media_tasks: Arc<MediaTaskManager>,
    pub audio_preparation: Arc<AudioPreparationService>,
    pub sv2_profiles: Arc<Sv2ProfileService>,
    pub svp_passthrough_only: AtomicBool,
    pub http_api: Arc<HttpApiManager>,
    pub credential_balancer: Arc<Mutex<CredentialBalancer>>,
}

impl AppState {
    pub fn new(
        resource_dir: PathBuf,
        bridge_dir: PathBuf,
        components_dir: PathBuf,
        svp_passthrough_only: bool,
        settings: ToolboxSettings,
    ) -> Self {
        let audio_preparation = AudioPreparationService::new(resource_dir.clone());
        let mcp = Arc::new(McpManager::default());
        let media_tasks =
            MediaTaskManager::persistent(resource_dir.clone(), bridge_dir.clone(), mcp.clone());
        let credential_balancer = Arc::new(Mutex::new(CredentialBalancer::new(
            settings.credential_routes(),
        )));
        Self {
            settings: Arc::new(RwLock::new(settings)),
            agent: Arc::new(Mutex::new(AgentSession::default())),
            file_approvals: Arc::new(FileApprovalManager::default()),
            mcp,
            resource_dir,
            bridge_dir,
            components_dir,
            downloads: Arc::new(ComponentDownloadManager::persistent()),
            media_tasks,
            audio_preparation,
            sv2_profiles: Arc::new(Sv2ProfileService::new()),
            svp_passthrough_only: AtomicBool::new(svp_passthrough_only),
            http_api: Arc::new(HttpApiManager::default()),
            credential_balancer,
        }
    }
}
