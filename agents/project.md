# Pi Desktop 项目索引
> 最后更新：2026-09-13

## 项目目标

提供 Synthesizer V Toolbox 桌面应用、可安装的 TypeScript/JavaScript 插件与可选 AI 协作能力。

## 技术栈

- Electron Main 与安全 preload 桌面宿主
- Vue/Vite renderer 工作台
- 同进程 PI Agent Runtime 与 model-auth
- Electron Builder 与 electron-updater

## 模块结构

- `src/PiDesktop.Tauri/electron`：桌面生命周期、IPC、更新与本地服务
- `src/PiDesktop.Tauri/src`：不依赖桌面框架的 Vue renderer
- `src/PiDesktop.Tauri/components`：随应用分发的 Bridge 与创作组件
- `packages/runtime-protocol`：宿主、运行时与插件共享协议
- `packages/agent-runtime`：PI 会话、模型访问和插件运行时
- `packages/plugin-sdk`：插件作者使用的后端与 GUI SDK
- `test`：Node/Electron 合同与行为测试
