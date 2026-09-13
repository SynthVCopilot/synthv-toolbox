# Findings

`src/PiDesktop.Tauri/src/api.ts` 是现有命令名称的唯一调用清单。首批包含启动设置、插件状态、Agent Runtime 会话和 HTTP MCP 状态；其他业务域保留在 Rust 宿主。
