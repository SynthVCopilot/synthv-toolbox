# Pi Desktop 任务追踪
> 准则版本: v0.2.2

## 任务列表

| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |
| :--: | :------: | :------: | :------: | :--: |
| 001 | [Feature]_agent_runtime_host | 增加 Node Agent Runtime 生命周期和 JSONL RPC 骨架 | 将 AI 运行时从原生宿主构建中分离 | ✅ 已完成 |
| 002 | [Feature]_runtime_protocol_compatibility | 对齐共享协议并处理运行时向宿主发起的能力调用 | 建立可验证的双向运行时边界 | ✅ 已完成 |
| 003 | [Architecture]_Pi_Runtime与扩展架构重构 | 接通 Rust 宿主、Pi 运行时、model-auth、插件后端与 GUI 贡献 | 将频繁变化的 AI 和扩展层移出 Rust 编译边界 | ✅ 已完成 |
