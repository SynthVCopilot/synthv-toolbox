# 发现

- [现状] -> `api.ts` 直接依赖 Tauri invoke、Channel 和文件对话框，`main.ts` 使用 Tauri event 与 WebView 拖放。 -> [结论] 需要以最小特权的 Electron preload 桥接替换这些渲染器调用。
- [现状] -> 浏览器开发预览使用内置的模拟响应。 -> [结论] 预览仅在没有桌面桥接时启用，保留现有行为。
- [约束] -> 本次范围不含业务 IPC handler。 -> [结论] 主进程只暴露受限 invoke、事件订阅和打开文件对话框协议，业务实现由后续宿主层注册。
