# Task plan

## 已确认决策（Rosmontis，2026-09-25）

- 目标由 Agent 在 `update_plan` 中复述，并写出可验证的完成标准；完成信号逐条给出完成依据。
- todo 只用于进度追踪，不决定能否结束。
- 结束由三类信号决定：`complete_task`（完成）、`request_input`（缺少核心信息时主动阻断循环并退出）、预算耗尽（自动停止）。
- 预算内模型停止推进时自动续跑；只有非协议工具的成功执行算作推进，连续空转超过档位上限后标记 `incomplete`。
- 提供商错误立即结束运行并把错误返回给用户；用户可随时停止运行（`cancelled`）。
- 档位 Low / Mid / High / Max 采用统计学设计：分别覆盖 68.27% / 95.45% / 99.73% 的运行，Max 不设上限。
- 预算同时限制 LLM 轮次与 Token（未命中缓存的输入 + 缓存写入 + 输出），任一耗尽即停止。
- 预算按档位分层：对该档位最近 200 次运行的轮次与 Token 分别做带删失（预算耗尽的运行）的对数正态 MAP 拟合（EM，先验折合 8 个伪样本），上限取 exp(μ + kσ)，k = 1/2/3；由联合界保证两者同时满足的比例 ≥ 2Φ(k)−1 = 68.27%/95.45%/99.73%。
- 档位越高，思考强度越高、自动压缩触发越晚、保留的最近上下文越多、允许的空转续跑越多。
- 档位在 Copilot 对话头切换并全局保存；Copilot 界面展示当前目标、todo、完成状态与预算用量。

## 接口契约（`packages/runtime-protocol`）

- 计划：`AgentTodo`、`AgentPlan`、`checkAgentPlan`、`validateAgentPlan`、`AGENT_PLAN_LIMITS`。
- 档位：`AgentEffortLevel`、`AGENT_EFFORT_LEVELS`、`DEFAULT_AGENT_EFFORT`、`AGENT_EFFORT_PROFILES`。
- 预算：`AgentRunBudget`、`AgentBudgetUsage`、`AgentUsageSample`、`estimateAgentRunBudget`、`validateAgentRunBudget`。
- 结果：`AgentRunStatus`、`AgentRunOutcome`、`validateAgentRunOutcome`。
- 会话：`session.initialize` 可带最新 `outcome` 回填计划与待回答的问题；`session.send` 带 `budget`，返回 `{ sessionId, accepted, message, outcome }`；`session.cancel` 停止当前运行。

## 步骤

- [x] 审计现有 Agent Runtime、宿主与 renderer 链路，记录到 `findings.md`。
- [x] 确认目标来源、结束信号、预算档位、续跑与界面范围。
- [x] 在 `packages/runtime-protocol` 落地共享类型、统计预算与校验函数，并补协议测试。
- [x] 子任务 A：Runtime 注册 `update_plan` / `complete_task` / `request_input`，按轮执行预算、续跑、思考强度与压缩策略，返回 `outcome`。
- [x] 子任务 B：宿主持久化 `outcome`、按历史估计预算、保存档位；renderer 展示档位切换、当前目标、todo、状态与预算用量。
- [x] 对抗式审查两个子任务的实现并修复确认的问题（26 条确认，三路修复 + 独立复核 + 残留修正）。
- [x] 合并子分支，运行 Runtime 构建、Electron 构建与合同测试，并在 renderer 预览中做视觉验证。
- [x] 更新 `project.md`、`tasks.md` 与本任务记录并提交。
- [x] 按主基线重写本地 `main`：旧 WinUI 历史备份为 `legacy/pi-desktop-winui`，`main` 指向 `origin/main` + 本任务提交。
