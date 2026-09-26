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

## 对抗式审查结论（26 条确认）

- [既有缺陷] `AiService.resolveModelSelection` 返回 `{ apiKey, credentialId }`，而 Runtime `hostModelSelection` 要求 `credentials[]` -> 真实应用中每次 `session.initialize` 都失败；两端测试都用假对象所以未暴露。
- [空转判定] 任意工具调用（含 `update_plan`、报错的 `complete_task`）都重置空转计数 -> Max 档可无限循环；其余档把停滞记成 `budget_exhausted` 污染统计 -> 改为仅统计非协议工具的成功执行（`tool_execution_end`）。
- [提供商错误] Pi 的 LLM 失败不会让 `session.prompt()` 抛错，只在 assistant 消息上标 `stopReason: "error"` -> 循环继续并返回空的 `incomplete` -> 改为出错即停止并抛出 `errorMessage`。
- [prompt cache] 每轮在系统提示里写入计数和计划会改变缓存前缀，续跑时整段上下文按 cache write 计费并消耗预算 -> 系统提示只保留静态协议文本，动态上下文放进首轮自定义消息与续跑提示。
- [信号被覆盖] Pi 只有整批结果都 `terminate` 才结束；同批 `update_plan` 会清掉完成信号 -> 信号设置后阻断后续所有工具调用。
- [压缩与消息] 压缩会替换消息数组，按下标切片取回复会丢失 -> 改为从 `turn_end` 事件采集本轮文本；压缩的 LLM 调用未计入 Token。
- [统计] 两个指标分别取 q 分位，联合覆盖率低于 q；200 样本窗口无法识别 99.73% 分位（High 退化为样本最大值）；删失回退无法让预算增长；各档位样本混合估计 -> 改为按档位分层、带删失的对数正态 MAP（EM）拟合，每个指标取 μ+kσ（k=1/2/3），由联合界保证两者同时满足的比例 ≥ 2Φ(k)−1 = 68.27%/95.45%/99.73%。
- [界面] 运行无法停止且全局忙碌遮罩锁死应用；目标卡片挤掉消息区；最小窗口宽度下对话头溢出；预算提示过期；重启或切换模型后丢失待回答的问题 -> 新增 `session.cancel`、独立的运行中状态与停止按钮、卡片放入滚动区并吸顶、对话头换行、每次运行后刷新预算、用最新 outcome 回填。
- [驳回] 并发发送重置计数（与另一条确认项重复）、非 assistant 消息带 outcome（无写入路径）、空转上限多一次（符合定义）。
