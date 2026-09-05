//! SynthV Toolbox 内置 Agent 运行时。
//!
//! Agent 循环、Provider、会话历史与组件目录都属于主应用，不再通过外部
//! workspace 或动态库接入。

pub mod catalog;
pub mod engine;
pub mod error;
pub mod history;
pub mod openai_chat;
pub mod openai_codex;
pub mod paths;
pub mod provider;
pub mod traecode;
pub mod workbuddy;

pub use catalog::{
    default_catalog, Audience, AudioAnalysis, ComponentKind, ComponentSpec, ComponentState,
    SoundToMidiRequest,
};
pub use engine::{
    AgentLoop, AgentProvider, AgentStep, ChatMessage, EchoProvider, NoTools, Role, ToolCall,
    ToolDefinition, ToolExecutor, ToolResult,
};
pub use error::{AgentError, AgentErrorKind, Result};
pub use history::{Conversation, ConversationStore, JsonConversationStore};
pub use openai_chat::{OpenAiChatConfig, OpenAiChatProvider};
pub use openai_codex::{OpenAiCodexConfig, OpenAiCodexProvider};
pub use paths::{config_path, data_root, history_dir, models_dir, output_dir, safe_join};
pub use provider::{AnthropicConfig, AnthropicProvider};
pub use traecode::{
    TraeCodeConfig, TraeCodeOutput, TraeCodeProvider, TraeLoginStatus, TraeToolCall,
};
pub use workbuddy::{
    WorkBuddyAccountInfo, WorkBuddyAuthState, WorkBuddyCredential, WorkBuddyOAuth,
    WorkBuddyOAuthConfig, WorkBuddyPollState,
};
