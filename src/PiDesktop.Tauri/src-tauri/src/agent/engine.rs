use serde::{Deserialize, Serialize};

use super::error::Result;

/// 一条对话消息的角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// 一条对话消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
}

/// 模型请求的一次工具调用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub tool_name: String,
    /// 入参的 JSON 文本。
    pub arguments_json: String,
}

/// 一次工具执行结果，回喂给模型。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub result_json: String,
    #[serde(default)]
    pub is_error: bool,
}

/// 模型可见的工具定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema 文本。
    pub input_schema_json: String,
}

/// 一次 agent 步进的产物。
#[derive(Debug, Clone)]
pub struct AgentStep {
    pub assistant_text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

impl AgentStep {
    pub fn wants_tools(&self) -> bool {
        !self.tool_calls.is_empty()
    }
}

/// 模型后端抽象。
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> &str;
    fn step(&self, conversation: &[ChatMessage], tools: &[ToolDefinition]) -> Result<AgentStep>;
}

/// 把模型请求的工具调用真正执行（通常路由到 SynthV 桥或本地组件）。
pub trait ToolExecutor: Send + Sync {
    fn tools(&self) -> Vec<ToolDefinition>;
    fn execute(&self, call: &ToolCall) -> Result<ToolResult>;
}

/// 空工具执行器：未连桥/未装组件时的占位。
pub struct NoTools;
impl ToolExecutor for NoTools {
    fn tools(&self) -> Vec<ToolDefinition> {
        Vec::new()
    }
    fn execute(&self, call: &ToolCall) -> Result<ToolResult> {
        Ok(ToolResult {
            tool_call_id: call.id.clone(),
            result_json: "{\"error\":\"未连接工具\"}".to_string(),
            is_error: true,
        })
    }
}

/// 与后端无关的 agent 主循环：步进 provider → 执行工具 → 追加结果 → 再步进。
pub struct AgentLoop<'a> {
    provider: &'a dyn AgentProvider,
    executor: &'a dyn ToolExecutor,
    max_tool_iterations: usize,
}

impl<'a> AgentLoop<'a> {
    pub fn new(provider: &'a dyn AgentProvider, executor: &'a dyn ToolExecutor) -> Self {
        Self {
            provider,
            executor,
            max_tool_iterations: 24,
        }
    }

    /// 跑一整轮：追加用户消息，循环处理工具，返回本轮新增的全部消息。
    pub fn run_turn(
        &self,
        conversation: &mut Vec<ChatMessage>,
        user_input: &str,
    ) -> Result<Vec<ChatMessage>> {
        let mut added = Vec::new();
        let user_msg = ChatMessage::user(user_input);
        conversation.push(user_msg.clone());
        added.push(user_msg);

        for _ in 0..self.max_tool_iterations {
            let step = self.provider.step(conversation, &self.executor.tools())?;

            let mut assistant =
                ChatMessage::assistant(step.assistant_text.clone().unwrap_or_default());
            if step.wants_tools() {
                assistant.tool_calls = step.tool_calls.clone();
            }
            conversation.push(assistant.clone());
            added.push(assistant);

            if !step.wants_tools() {
                break;
            }

            for call in &step.tool_calls {
                let result = self.executor.execute(call)?;
                let tool_msg = ChatMessage {
                    role: Role::Tool,
                    content: result.result_json.clone(),
                    tool_calls: Vec::new(),
                    tool_call_id: Some(result.tool_call_id.clone()),
                };
                conversation.push(tool_msg.clone());
                added.push(tool_msg);
            }
        }

        Ok(added)
    }
}

/// 占位后端：回显最后一条用户消息，供无 API key 时打通链路。
pub struct EchoProvider;
impl AgentProvider for EchoProvider {
    fn id(&self) -> &str {
        "echo"
    }
    fn step(&self, conversation: &[ChatMessage], _tools: &[ToolDefinition]) -> Result<AgentStep> {
        let last_user = conversation.iter().rev().find(|m| m.role == Role::User);
        let text = match last_user {
            Some(m) => format!("（占位后端）收到：{}", m.content),
            None => "（占位后端）你好，我是 SynthV Toolbox 的回显后端。".to_string(),
        };
        Ok(AgentStep {
            assistant_text: Some(text),
            tool_calls: Vec::new(),
        })
    }
}
