# Pi Desktop 项目索引

> 最后更新：2026-09-02

## 项目目标

为 Synthesizer V Studio 2 提供 Windows 和 macOS 桌面工具箱，包括账号槽位、受约束的并发启动和可选 AI 工作流。

## 技术栈

- Tauri 2 + Rust 后端
- TypeScript、Vue 3 和 Vite 前端
- Windows 上通过 Sandboxie 配置隔离进程树
- macOS 上通过顺序切换受管数据根提供槽位

## 模块结构

- `src/PiDesktop.Tauri/src-tauri/src/sv2_profiles.rs`：账号槽位、切换和启动编排。
- `src/PiDesktop.Tauri/src-tauri/src/sv2_concurrent.rs`：Sandboxie 副本与共享内容配置。
- `src/PiDesktop.Tauri/src-tauri/src/sv2_account_probe.rs`：显式账号预检与授权摘要。
- `src/PiDesktop.Tauri/src-tauri/src/sv2_sync.rs`：安全的槽位资源同步。
- `src/PiDesktop.Tauri/src`：Tauri 前端。
- `src/PiDesktop.Tauri/src-tauri/src/lyric_projects.rs`：歌词项目的本地创建、保存、读取和列表，写入范围固定在 Toolbox 数据根。
- `docs/lyric-and-audio-workflow-guide.zh-CN.md`：作词、平台音频导入、下载组件和内部工具的评估与实施指导。
