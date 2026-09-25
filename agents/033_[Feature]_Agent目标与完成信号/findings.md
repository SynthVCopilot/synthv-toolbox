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

## 设计修订记录

[todo 阻止结束] -> [Rosmontis 指出 todo 不应决定能否结束] -> 移除 `completed` 对 todo 全部结束的校验，改为三类信号 + 预算。
[固定预算表 6/16/40/100 轮] -> [Rosmontis 要求统计学设计] -> 改为覆盖率定档；经验分位数若直接把预算截断的运行当作完整样本，会让 Low/Mid 预算自我锁死在当前值，因此按右删失用 Kaplan–Meier 估计；删失过多无法估到目标分位时取 max(先验分位, 历史最大值)。
[先验参数] -> 轮次中位数 4、log σ 0.9；Token 中位数 60k、log σ 1.0 -> 先验预算 Low 7 轮/97k，Mid 19 轮/325k，High 49 轮/969k。
[Pi 压缩参数] -> `compaction.reserveTokens` 决定触发点（contextWindow - reserve），`keepRecentTokens` 决定保留量；`SettingsManager.applyOverrides` 可按轮覆盖，压缩时实时读取。
[Pi 工具异常] -> pi-agent-core `agent-loop.js` 将工具 `execute()` 抛出的错误转为 `isError` 结果交给模型，不会中断运行。
[预算中途停止] -> 用 `tool_call` 返回 `{ block, terminate }` 平滑结束，而不是 `abort()`；超支最多一轮。

## 范围外缺口

- Agent 目前没有接入任何 Toolbox 能力（下载/分离/GAME/音素检查/导入 SV/调参），也没有 Copilot 角色系统提示；翻唱类长任务在接入这些工具前无法实际执行。

## 实现阶段发现

- [子 agent worktree 基点] -> Workflow 创建的 worktree 位于 `25d2062` 而非任务分支 HEAD -> 子 agent 按指令 `git reset --hard 6af45d6` 后建分支；后续派发需同样指定基点。
- [SettingsManager.applyOverrides] -> 读 `settings-manager.js` -> 内部 `deepMergeObjects`，嵌套合并 `compaction`，可按轮覆盖。
- [预算耗尽判定时机] -> `turn_end` 在工具执行后触发，耗尽判定晚于本轮工具调用 -> 耗尽后 Pi 仍会发起下一次 LLM 调用，再由 `tool_call` 阻断；实际 LLM 调用最多比 `maxTurns` 多 1 次。
- [测试替身] -> 单轮 `prompt()` 只对应一个内部回合时无法覆盖预算阻断 -> 替身支持单次 `prompt()` 内多回合。
- [electron-ai-service 测试] -> `data:` URL 模块中无法解析裸包名 `@synthv-toolbox/runtime-protocol` -> 测试将其重写为已构建 `dist/index.js` 的 `file://` 绝对路径。
- [sandbox] -> `synthv-service.mjs` 写真实 `~/Library/Application Support/Dreamtonics` 在沙箱中 EACCES -> 既有问题，与本任务无关。
