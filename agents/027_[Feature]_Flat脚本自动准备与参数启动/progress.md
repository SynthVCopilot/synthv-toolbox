# 操作记录

- 已将用户追加的 Flat 自动脚本准备与参数启动登记为独立任务。
- 已定位 `connect_flat`、`connect_legacy_bridge`、`install_legacy_bridge`、脚本目录发现和 F13/F14 快捷键实现。
- 已确认：启动仅适用于稳定 `flat` 主机标识；工程参数必须是现有普通 `.svp` 文件。原生 MCP 仍优先，失败后安装器通过 `--target` 更新 Anthronics 目录，随后 F5、F13 与有界轮询在同次连接内完成。
- 更新 `synthv_unified.rs`：为 `synthv_connect` 增加受限 `projectPath`、Flat 启动后 PID 发现轮询、安装后 F5 重扫，并保留原生 MCP 优先。
- 更新 `synthv_hosts.rs`：增加跨平台 Flat 可执行文件解析与 `Command` 参数启动；Windows 继续限定 Anthronics Flat 脚本目录。
- 新增根契约 `test/flat-auto-script-launch.mjs` 并追加至现有 `test:contracts` 命令，未覆盖任务 026 的测试入口。
- 已执行 `cargo fmt --all`、`cargo check`、Flat 参数路径 Rust 单测、Flat 原生失败回退单测与新根契约，均通过。
