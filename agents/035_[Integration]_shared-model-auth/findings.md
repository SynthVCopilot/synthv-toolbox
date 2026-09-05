# 技术发现

- [当前实现] -> 当前页面以 Vue 外壳承载由 `shell.ts` 生成的 HTML；认证向导并未直接由 `AppShell.vue` 实现 -> 需要在外壳中提供共享 Vue 组件的挂载点并移除旧的 HTML 事件实现。
- [共享包契约] -> `@model-auth/vue` v0.1.0 导出 `ModelAuthDialog`、`useModelAuth` 和八类共享动作 -> 当前 Toolbox 只暴露 OAuth/API Key 添加删除、模型选择和目录刷新，缺少凭据启停/权重、OAuth 开关与策略更新。
- [运行时边界] -> WorkBuddy 保持现有浏览器 OAuth 和系统凭据库路径；TraeCode 保持本机官方 CLI 边界 -> 仅映射共享动作，不新增 Node 认证 sidecar，也不把不可用能力伪装为可用。
- [TRAE 企业 CLI] -> 官方环境变量文档确认 `TRAE_HOME` 覆盖 CLI 配置与运行时目录 -> 当前 Rust provider 会读取用户级 CLI 状态且 JSONL 能力合同尚未验证，因此已将 TRAE 标记为不可用并拒绝登录/运行时调用，避免错误访问用户全局会话。
- [v0.2 取消] -> 当前 v0.1.0 发布 tarball 的 `ModelAuthHost.execute` 仅接收 action -> 不能伪造 v0.2 的 `AbortSignal` 上下文；后续升级应映射 signal 到 Tauri operation ID 并由关闭对话框取消 OAuth。
- [复审修正] -> custom element 在全局 `run` 中重渲染会重置步骤，且一次性监听器会丢失重试事件 -> 改为本地 busy/error 操作状态；失败保留 provider detail，关闭时取消 operation ID。
- [WorkBuddy 目录] -> models.dev 不含 WorkBuddy provider -> 仅从 zhipuai、deepseek、tencent-tokenhub 的实际条目收集模型，并与已验证的 WorkBuddy runtime ID 精确相交；离线目录不补充模型。
