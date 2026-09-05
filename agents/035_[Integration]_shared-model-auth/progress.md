# 操作记录

- 已读取 `/Users/user/.codex/skills/agent-mode/SKILL.md` 全文。
- 已确认 `/Users/user/.codex/worktrees/synthv-toolbox/shared-model-auth` 基于 `df098a3` 且工作树干净。
- 已检查 `@model-auth/vue` v0.1.0 的 `useModelAuth.ts`、`types.ts` 和 core index，以及可用的 v0.1.0 发布 tarball。
- 已定位当前 Rust 命令注册与认证状态/向导前端边界。
- 已使用 README 中的 GitHub Release v0.1.0 tarball URL 安装并锁定 `@model-auth/vue`，未使用 npm registry。
- 已把 `model-auth-dialog` custom element 挂入静态 Vue shell，并把 OAuth、API Key、移除、凭据启停/权重、OAuth 开关、策略、模型选择和目录刷新映射到前端预览与 Tauri 命令。
- 已执行 `node ../../test/shared-model-auth.mjs`、`npm run build`、`cargo check` 与 `cargo test credential_balancer --lib`；全部通过。
- 已本地安装 v0.2.0 Vue tarball 完成构建和 custom-element 行为测试；发布 tarball URL 尚未提供，仓库依赖继续指向已发布的 v0.1.0 URL。
- 已删除旧 HTML 向导、事件分支和步骤状态；新增 jsdom custom-element 点击/事件测试，验证 OAuth 事件和关闭事件。
- 已让 OAuth 回调轮询与 WorkBuddy 轮询接受 operation ID 取消；TRAE CLI 的登录、状态、退出和执行子进程现在设置应用拥有的 `TRAE_HOME`。
- 已补充 Rust 回归测试：authorization registration 的 Drop 清理、TRAE 状态文本不会把 unauthenticated 误判为已登录、取消登录会在 CLI 发现前退出。
- 已将 TRAE 的账号默认模型输出标为 `account-default-readonly`，使其不被表述为 models.dev 目录元数据；后端仅接受该唯一默认模型。
- 已升级正式发布的 v0.2.1，合并远端并发更新并重新运行前端、Rust 全 targets 测试与严格 Clippy。
- 首次跨平台构建仅在 Rust 格式检查失败；运行格式化并通过本地格式检查后提交 `22bc1a6`。后续 Dev Build `33959264673` 的 Windows x64 与 macOS Universal 均成功，已确认两个未过期的开发产物。
