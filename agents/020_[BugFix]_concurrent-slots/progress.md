# 前端并发修复进度

- 读取 agent-mode、项目索引、并发任务计划与 findings。
- 检查 `main.ts`、`types.ts`、`api.ts` 和 `synthv_control.rs` 的并发/PID/进程渲染路径。
- 扩展 `SynthVProcess` 的 `windowTitle` 字段与预览数据。
- 移除同账号已有隔离 PID 对并发启动按钮和隔离会话环境的阻塞。
- 账号页加入实例列表：窗口标题、PID、普通主槽/隔离并发模式和账号名称。
- 添加活跃页面限定的 2 秒进程与槽位状态刷新。
- 更新声库按账号/隔离实例独立保存的全局文案。
- Windows 进程枚举读取可见窗口标题，并修正 windows-sys 0.61 的 HWND/BOOL 类型。
