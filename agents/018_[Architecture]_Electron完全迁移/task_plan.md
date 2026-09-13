# Electron 完全迁移

## 目标

将 Electron 设为唯一桌面 Shell，以 Node/TypeScript 承载 PI、model-auth、插件、MCP、设置与业务服务；删除 Tauri/Rust 应用及其构建发布链路。更新操作在应用内完成检查、下载、安装和重启，不需要用户打开浏览器或手动运行安装包。

## 阶段

1. 建立 Electron Main、preload、类型化 IPC 与现有 Vue/Vite renderer 的最小端到端启动。
2. 将 Tauri command 表面迁移为 Node 服务并让现有 `api.ts` 切换到 Electron bridge。
3. 合并 PI Runtime、model-auth、插件 GUI 与 MCP 权限代理，删除独立 Node 分发层。
4. 迁移平台功能、数据存储、SynthV 管理、组件任务和更新服务。
5. 使用 Electron Builder 生成签名就绪安装包与更新元数据，接入下载、安装和重启流程。
6. 删除 `src-tauri`、Cargo、Tauri 依赖和旧发布工作流，修订全部合同测试。
7. 完成干净安装、开发启动、生产构建、安装包和更新链路验证后交付。

## 强制边界

- renderer 开启 sandbox 与 context isolation，不开放 Node integration。
- preload 只暴露类型化 IPC；Main 对每个高权限调用校验输入和权限。
- 插件内部函数与高级功能继续使用全局开关、单插件授权和声明级别。
- MCP Server 的内部函数与高级功能保留独立开关，并在工具列表和调用路径双重鉴权。
- 不保留 Tauri 兼容层或旧更新下载回退。
