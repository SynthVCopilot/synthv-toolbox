# 操作记录

- 已将用户追加的 Flat 自动脚本准备与参数启动登记为独立任务。
- 已定位 `connect_flat`、`connect_legacy_bridge`、`install_legacy_bridge`、脚本目录发现和 F13/F14 快捷键实现。
- 已确认：启动仅适用于稳定 `flat` 主机标识；工程参数必须是现有普通 `.svp` 绝对路径。原生 MCP 仍优先，失败后安装器通过 `--target` 更新实际脚本目录，macOS 直接调用宿主菜单重扫和脚本启动，Windows 保留 F13 回退。
- 更新 `synthv_unified.rs`：为 `synthv_connect` 增加受限 `projectPath`、Flat 启动后 PID 发现与原生 MCP 就绪宽限轮询，并保留原生 MCP 优先。
- 更新 `synthv_hosts.rs`：通过 Flat 外层启动器使用独立 `Command` 参数启动；脚本目录覆盖 Dreamtonics 与 Anthronics 两种变体并优先采用现有目录。
- 新增根契约 `test/flat-auto-script-launch.mjs` 并追加至现有 `test:contracts` 命令，未覆盖任务 026 的测试入口。
- 已执行 `cargo fmt --all`、`cargo check`、Flat 参数路径 Rust 单测、Flat 原生失败回退单测与新根契约，均通过。
- 首次实机启动暴露了包内 Studio 可执行文件绕过原生 MCP、脚本装入错误厂商目录和进程/MCP 状态竞态；均已按真实 Flat 行为修正。
- 最终安装态从 `flat` 未运行开始，单次 `synthv_connect` 使用工程绝对路径启动新 PID 83753，等待匹配 PID 的原生 MCP Ready 后连接成功，并通过 `synthv_read(project)` 读回 1 轨、2 Part 的目标工程。
- 正确的兼容脚本已自动安装到当前 Flat 实际使用的 Dreamtonics 脚本目录；测试期间产生的 Anthronics 错误目录副本已移入废纸篓。
- 全量 Rust 测试 207 项通过、2 项真实宿主测试按设计忽略；全部前端契约与 release Tauri/DMG 构建通过。
