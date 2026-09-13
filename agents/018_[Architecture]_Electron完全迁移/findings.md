# 调查记录

- 当前 renderer 的全部宿主调用集中在 `src/api.ts`，可用 Electron preload bridge 替换 Tauri `invoke` 与 `Channel`。
- 当前 Rust crate 同时承载桌面生命周期、业务服务、权限代理、更新、SynthV 系统集成与大量算法，迁移必须以现有命令表面为验收清单。
- Tauri 打包资源包含独立 Node、Agent Runtime 依赖树和多个组件目录，是当前碎片化资源与额外 Runtime 的主要来源。
- Electron ASAR 可以合并 JavaScript 资源；需要原始路径执行的组件应通过 `asarUnpack` 明确列出。
- Electron `safeStorage` 可以密封 model-auth 的完整 OAuth/API Key 凭据，renderer 只接收脱敏元数据。
- HTTP MCP 服务只监听 loopback；工具列举与调用都必须读取当次 internal/advanced 配置，不能依赖客户端提交权限字段。
- 自动更新需要 `autoDownload` 与 `autoInstallOnAppQuit`，并在 `update-downloaded` 后调用 `quitAndInstall` 才能满足一次点击完成更新。
- Electron 自带 Node/V8，PI Runtime 可以作为 Main 进程内服务运行；无需继续打包独立 Node sidecar。
- renderer 与 host 使用独立 TypeScript 构建目标，修改 UI 时无需重新编译平台宿主。
- Sandboxie 并发槽位必须同时校验 FileRootPath，并把虚拟 AppData 路径以 junction 指向槽位权威目录，否则启动成功也不能保证账号隔离。
