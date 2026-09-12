# Pi Desktop 项目索引
> 最后更新：2026-09-12

## 项目目标

提供 Synthesizer V Toolbox 桌面应用与可选 AI 协作能力。

## 技术栈

- Tauri 2 与 Rust 原生宿主
- Vue 工作台前端
- Tokio 异步运行时
- 独立 Node.js Agent Runtime，使用 Pi SDK 与 model-auth

## 模块结构

- `src/PiDesktop.Tauri/src-tauri`：原生宿主和业务服务
- `packages/runtime-protocol`：宿主、运行时与插件共享协议
- `packages/agent-runtime`：Pi 会话、模型访问和插件后端进程
- `packages/plugin-sdk`：插件作者使用的后端与 GUI SDK
- `test`：独立 Rust 集成测试
