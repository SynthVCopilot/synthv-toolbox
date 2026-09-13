# Progress

- 已创建独立 worktree `codex/autostart-tray`，基于 `origin/main`。
- 已审阅前端开机启动设置调用、Electron 主进程和现有合同测试。
- 已将 `SynthVService` 的开机启动状态替换为 Electron 登录项控制器，保留非 Electron 测试的文件后备实现。
- 已在主进程创建托盘菜单；窗口关闭时隐藏，托盘点击、菜单和二次实例均会显示并聚焦窗口。
- 已添加 `test/electron-autostart-tray.mjs` 并纳入 `test:contracts`。
- 已通过 `npm run build:electron`、`npm run test:contracts`、`npm run test:electron-main` 验证。
