# 调研与发现

- `ToolboxAudioToolExecutor` 已统一承载媒体、Cover、宿主发现与文件审批工具，HTTP 层应直接复用它而不是复制能力。
- OpenCode 支持远程 MCP，因此 Toolbox 只需提供标准 Streamable HTTP MCP 入口；模型凭证继续由 OpenCode 自己保管。
- 接口默认关闭并固定监听 `127.0.0.1`，避免启用设置无意中把桌面控制面暴露到局域网。
