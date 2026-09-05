# Pi Desktop 项目索引

> 最后更新：2026-09-05

## 项目目标

为 Synthesizer V Studio 2 提供 Windows 和 macOS 桌面工具箱，包括账号槽位、受约束的并发启动和可选 AI 工作流。

## 技术栈

- Tauri 2 + Rust 后端
- TypeScript、Vue 3 和 Vite 前端
- Windows 上通过 Sandboxie 配置隔离进程树
- macOS 上通过顺序切换受管数据根提供槽位

## 模块结构

- `src/PiDesktop.Tauri/src-tauri/src/sv2_profiles.rs`：账号槽位、切换和启动编排。
- `src/PiDesktop.Tauri/src-tauri/src/sv2_concurrent.rs`：Sandboxie 账号环境与单份槽位数据映射。
- `src/PiDesktop.Tauri/src-tauri/src/sv2_account_probe.rs`：显式账号预检与授权摘要。
- `src/PiDesktop.Tauri/src-tauri/src/sv2_sync.rs`：安全的槽位资源同步。
- `src/PiDesktop.Tauri/src`：Tauri 前端。
- `src/PiDesktop.Tauri/src-tauri/src/lyric_projects.rs`：歌词项目的本地创建、保存、读取和列表，写入范围固定在 Toolbox 数据根。
- `src/PiDesktop.Tauri/src-tauri/src/synthv_control.rs`：运行中 SynthV 进程发现、F13/F14 Bridge 快捷键注入与主动连接。
- `src/PiDesktop.Tauri/src-tauri/src/components.rs`：包含固定版本 FFmpeg 与 media-fetcher 等组件的下载、校验、安装和删除边界。
- `src/PiDesktop.Tauri/src-tauri/src/downloads.rs`：组件任务串行队列、持久化、恢复、排队取消与失败重试。
- `src/PiDesktop.Tauri/src-tauri/src/media_import.rs`：BV/YouTube 来源规范化、元数据预览、受管 WAV 下载与来源 manifest。
- `src/PiDesktop.Tauri/src-tauri/src/media_tasks.rs`：平台导入、分离与一键 Cover 的持久化串行任务；支持取消、重试、歌词 MIDI、Bridge 导入和 `.svp` 保存验证。
- `src/PiDesktop.Tauri/src-tauri/src/managed_process.rs`：受限 stdout/stderr 的跨平台可终止进程树执行器。
- `src/PiDesktop.Tauri/src-tauri/src/config.rs`：应用模式、Edit/Solo Agent 工作模式、AI 提供商与持久化设置。
- `src/PiDesktop.Tauri/src-tauri/src/tuning_profiles.rs`：参考演唱特征映射、按声库隔离档案与 A/B 反馈学习。
- `src/PiDesktop.Tauri/src-tauri/src/audio_capture.rs`：Windows 进程回环与 macOS Core Audio Process Tap 的 SynthV 指定进程短片段捕获、连续性检查和本地 A/B 指标。
- `src/PiDesktop.Tauri/src-tauri/src/mcp/http_client.rs`：仅 loopback 的 Flat Streamable HTTP MCP 客户端，支持 2025-06-18 握手、工具列表/调用、JSON/SSE 响应和有界错误处理。
- `src/PiDesktop.Tauri/src-tauri/native/macos_process_tap.mm`：macOS 14.2+ 私有 Process Tap、aggregate device、IOProc 与 PCM WAV 原生实现。
- `src/PiDesktop.Tauri/src-tauri/components/synthv-agent-bridge`：随桌面应用统一版本管理的 SynthV 内部查询、编辑与能力边界组件；明确报告歌手身份不可由官方脚本 API 读取或分配。
- `src/PiDesktop.Tauri/src-tauri/components/vocal-separation`：固定依赖的 Demucs 双轨分离运行时入口。
- `src/PiDesktop.Tauri/src-tauri/src/workflows.rs`：音频分析、分离、MIDI 与工程处理工作流编排。
- `docs/lyric-and-audio-workflow-guide.zh-CN.md`：作词、平台音频导入、下载组件和内部工具的评估与实施指导。
