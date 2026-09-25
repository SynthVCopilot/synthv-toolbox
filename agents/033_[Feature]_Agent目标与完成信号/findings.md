# Findings

## 现状审计（2026-09-25）

[Agent 目标不明确] -> [审查 `packages/agent-runtime/src/index.ts`、`ai-service.ts`、renderer Copilot 页] -> 结论如下：

- `createPiSessionFactory` 以 `noTools: "builtin"` 创建 Pi 会话，只保留插件扩展注册的工具；没有任何规划或结束工具。
- `AiService.send_message` 调用 `session.initialize` 时不传 `systemPrompt`，Agent 没有角色、目标或结束约定。
- `PiSession.prompt()` 在 Pi 运行结束后只返回最后一条 assistant 文本；运行是"完成"、"等待用户"还是"中途停下"无法区分。
- `session.send` 结果只有 `{ sessionId, accepted, message }`；宿主把非空文本视为成功。
- Renderer `renderMessage` 只渲染纯文本，`ChatMessage` 无结构化状态字段。
- HTTP `/agent` 端点直接返回 `send_message` 的消息数组，同样缺少完成状态。

## Pi SDK 0.85.1 可用机制

- `DefaultResourceLoader({ extensionFactories })` 支持内联扩展，无需文件路径。
- `pi.registerTool` / `defineTool` 支持 `promptSnippet`、`promptGuidelines`，工具说明自动进入系统提示。
- 工具 `execute()` 返回 `terminate: true` 时，若同批次结果都为终止，则跳过后续 LLM 调用（官方 `structured-output.ts` 示例）。
- 事件：`before_agent_start`（可改系统提示）、`agent_end`、`agent_settled`（确认 Pi 不再自动继续）、`turn_end`、`tool_execution_end`。
- 官方 `todo.ts` 示例把状态存在 tool result `details` 中，从会话分支重建。
- 官方 `plan-mode` 示例用 `Plan:` 段落和 `[DONE:n]` 标记追踪步骤，属于文本约定，弱于工具调用。

## 成熟产品参考

- Claude Code `TodoWrite`：整表替换，状态 `pending | in_progress | completed`，同一时间仅一个 `in_progress`。
- OpenAI Codex `update_plan`：`explanation + plan[{ step, status }]`，同样整表替换。
- Claude Code Stop hook / Codex goal 续跑：运行结束但目标未达成时注入继续指令，设上限防止死循环。

## 附带发现（不在本任务范围）

- `command-registry.ts` 的 `send_message` 总是发到最近更新的会话（`conversations[0]`），而不是 renderer 当前打开的会话。
- 本地 `main` 与 `origin/main` 已分叉（本地独有 8 个提交，远端独有 749 个提交）；本分支基于 `origin/main` 的 `25d2062`。
