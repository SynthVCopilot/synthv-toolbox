# 前端并发与实例追踪审计

## 范围

前端并发启动交互、账号页运行实例列表、SynthV 进程 DTO 的窗口标题字段。账号声库同步策略由后端同步模块负责，本分支只更新前端文案。

## 决策

- 已运行的隔离 PID 只用于展示和账号关联，不再作为同账号启动按钮的禁用条件。
- 隔离环境的会话探测仍在恢复中时保持阻塞；已运行本身不阻塞，因为同一账号允许多个 Sandboxie 实例。
- 实例列表按进程 PID 优先匹配 `slot.concurrent.runningPids`，其余普通进程匹配 `activeSlotId`，无法匹配时显示“未知环境 / 未关联账号”。
- 进程列表后台每 2 秒更新，仅在账号页或 Bridge 页可见且没有前台操作时执行；不轮询账号授权探测。
- Windows 进程探测补充可见窗口标题，macOS 返回空标题并由前端回退到进程名。

## 验证

- TypeScript DTO 与渲染代码已同步。
- `cargo check` 进入项目 build script，但因本地缺少 `components/synthv-agent-bridge/node_modules` 资源而停止；Rust 修改已按 windows-sys 0.61 的 `HWND`/`BOOL` 签名调整。
