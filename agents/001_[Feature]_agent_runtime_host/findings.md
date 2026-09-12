# 发现

- [现状] -> 当前 `agent` 模块直接提供 AgentLoop 和各 Provider -> 新运行时必须独立模块，避免替换既有调用链。
- [现状] -> Tauri 依赖已经启用 Tokio process、io-util、sync -> 可直接实现 Node 子进程和 JSONL 管道，无需新增依赖。
- [构建阻断] -> worktree 缺少打包资源目录 `components/synthv-agent-bridge/dist` -> 本地创建忽略的空目录后，Cargo 可完成编译和运行测试；该目录不纳入提交。
