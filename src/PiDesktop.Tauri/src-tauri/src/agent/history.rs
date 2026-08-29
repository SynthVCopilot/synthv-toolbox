use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::engine::ChatMessage;
use super::error::Result;

/// 一次可持久化的会话（对话历史 + 元数据），供桌面「历史」列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// ISO-8601 字符串（由调用方生成，核心不依赖时钟）。
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<ChatMessage>,
}

/// 会话历史存储抽象。
pub trait ConversationStore: Send + Sync {
    fn list(&self) -> Result<Vec<Conversation>>;
    fn get(&self, id: &str) -> Result<Option<Conversation>>;
    fn save(&self, conversation: &Conversation) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
}

/// 把每个会话存成 `{dir}/{id}.json` 的本地实现。
pub struct JsonConversationStore {
    dir: PathBuf,
}

impl JsonConversationStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
}

impl ConversationStore for JsonConversationStore {
    fn list(&self) -> Result<Vec<Conversation>> {
        if !self.dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(c) = serde_json::from_str::<Conversation>(&text) {
                    out.push(c);
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    fn get(&self, id: &str) -> Result<Option<Conversation>> {
        let path = self.path_for(id);
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(path)?;
        Ok(Some(serde_json::from_str(&text)?))
    }

    fn save(&self, conversation: &Conversation) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let tmp = self.path_for(&format!("{}.tmp", conversation.id));
        fs::write(&tmp, serde_json::to_string_pretty(conversation)?)?;
        fs::rename(&tmp, self.path_for(&conversation.id))?; // 原子替换，防半写
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<()> {
        let path = self.path_for(id);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

/// 便捷：统一数据根下的默认历史目录（~/.SynthVcopilot/history）。
pub fn default_history_dir() -> PathBuf {
    super::paths::history_dir()
}
