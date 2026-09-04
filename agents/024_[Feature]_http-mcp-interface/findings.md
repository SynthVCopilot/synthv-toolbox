# 调研与发现

- `ToolboxAudioToolExecutor` 已统一承载媒体、Cover、宿主发现与文件审批工具，HTTP 层应直接复用它而不是复制能力。
- OpenCode 支持远程 MCP，因此 Toolbox 只需提供标准 Streamable HTTP MCP 入口；模型凭证继续由 OpenCode 自己保管。
- 接口默认关闭并固定监听 `127.0.0.1`，避免启用设置无意中把桌面控制面暴露到局域网。
- 设置使用 `serde(rename_all = "camelCase")`；新增字段应直接进入 `ToolboxSettings` 与 bootstrap DTO，默认端口为 17831。
- `ToolboxAudioToolExecutor` 是同步 `ToolExecutor`，需要在 HTTP 请求线程中复用与 `send_message` 相同的 MCP bindings、文件审批、工作模式和会话 ID 上下文。
- Tauri setup 是同步闭包；启用态 HTTP 服务应在 `app.manage(AppState)` 后通过 Tauri Tokio runtime 异步启动，并把 bind 错误写入状态而不是让应用启动失败。
- OpenCode 1.18.19 当前对未运行的 `http://127.0.0.1:17831/mcp` 报告 `SSE error: Unable to connect`；这是服务未启用时的预期结果。实现兼容其 `Accept: application/json, text/event-stream` 探测，并用 GET 405/Allow: POST 表明会话入口只接受 POST。
