# 调查记录

- 本地 MCP 使用 `http_api.rs` 的 HTTP JSON-RPC 入口，当前发布音频工具执行器提供的普通工具。
- HTTP 服务配置已有 MCP、Agent 与端口字段，适合在同一设置对象中加入两个默认关闭的授权字段。
- 插件 Runtime 已通过 `host.capability.invoke` 分发内部与高级能力；MCP 应复用同一个操作实现，避免权限边界漂移。
- MCP 客户端可以跳过 `tools/list` 直接请求 `tools/call`，因此列表过滤之外必须在调用路径再次鉴权。
