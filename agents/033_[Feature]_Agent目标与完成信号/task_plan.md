# Task plan

## 已确认决策（Rosmontis，2026-09-25）

- 目标由 Agent 在 `update_plan` 中复述，并写出可验证的完成标准；完成信号逐条给出完成依据。
- todo 只用于进度追踪，不决定能否结束。
- 结束由三类信号决定：`complete_task`（完成）、`request_input`（缺少核心信息时主动阻断循环并退出）、预算耗尽（自动停止）。
- 预算内模型停止推进时自动续跑；连续空转续跑超过档位上限后标记 `incomplete`。
- 档位 Low / Mid / High / Max 采用统计学设计：分别覆盖 68.27% / 95.45% / 99.73% 的运行，Max 不设上限。
- 预算同时限制 LLM 轮次与 Token（未命中缓存的输入 + 缓存写入 + 输出），任一耗尽即停止。
- 预算取本地已完成运行的经验分位数（Kaplan–Meier 处理预算截断的删失样本），样本不足时使用对数正态先验。
- 档位越高，思考强度越高、自动压缩触发越晚、保留的最近上下文越多、允许的空转续跑越多。
- 档位在 Copilot 对话头切换并全局保存；Copilot 界面展示当前目标、todo、完成状态与预算用量。

## 接口契约（`packages/runtime-protocol`）

- 计划：`AgentTodo`、`AgentPlan`、`checkAgentPlan`、`validateAgentPlan`、`AGENT_PLAN_LIMITS`。
- 档位：`AgentEffortLevel`、`AGENT_EFFORT_LEVELS`、`DEFAULT_AGENT_EFFORT`、`AGENT_EFFORT_PROFILES`。
- 预算：`AgentRunBudget`、`AgentBudgetUsage`、`AgentUsageSample`、`estimateAgentRunBudget`、`validateAgentRunBudget`。
- 结果：`AgentRunStatus`、`AgentRunOutcome`、`validateAgentRunOutcome`。
- 会话：`session.initialize` 可带 `plan` 回填；`session.send` 带 `budget`，返回 `{ sessionId, accepted, message, outcome }`。

## 步骤

- [x] 审计现有 Agent Runtime、宿主与 renderer 链路，记录到 `findings.md`。
- [x] 确认目标来源、结束信号、预算档位、续跑与界面范围。
- [x] 在 `packages/runtime-protocol` 落地共享类型、统计预算与校验函数，并补协议测试。
- [ ] 子任务 A：Runtime 注册 `update_plan` / `complete_task` / `request_input`，按轮执行预算、续跑、思考强度与压缩策略，返回 `outcome`。
- [ ] 子任务 B：宿主持久化 `outcome`、按历史估计预算、保存档位；renderer 展示档位切换、当前目标、todo、状态与预算用量。
- [ ] 对抗式审查两个子任务的实现并修复确认的问题。
- [ ] 合并子分支，运行 Runtime 构建、Electron 构建与合同测试。
- [ ] 更新 `project.md`、`tasks.md` 与本任务记录，提交并合并到本地 `main`。
