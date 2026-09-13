# 调查记录

- 当前 renderer 的全部宿主调用集中在 `src/api.ts`，可用 Electron preload bridge 替换 Tauri `invoke` 与 `Channel`。
- 当前 Rust crate 同时承载桌面生命周期、业务服务、权限代理、更新、SynthV 系统集成与大量算法，迁移必须以现有命令表面为验收清单。
- Tauri 打包资源包含独立 Node、Agent Runtime 依赖树和多个组件目录，是当前碎片化资源与额外 Runtime 的主要来源。
- Electron ASAR 可以合并 JavaScript 资源；需要原始路径执行的组件应通过 `asarUnpack` 明确列出。
- Electron `safeStorage` 可以密封 model-auth 的完整 OAuth/API Key 凭据，renderer 只接收脱敏元数据。
- HTTP MCP 服务只监听 loopback；工具列举与调用都必须读取当次 internal/advanced 配置，不能依赖客户端提交权限字段。
- 自动更新需要 `autoDownload` 与 `autoInstallOnAppQuit`，并在 `update-downloaded` 后调用 `quitAndInstall` 才能满足一次点击完成更新。
