# 发现

- [服务文件] -> 当前分支不存在 `electron/updater.ts` 或 `services/runtime-host.ts`，指定提交也未提供可读取文件。 -> [结论] 本次按主进程所需的稳定接口实现服务边界，业务实现可在后续替换。
- [运行时分发] -> `@synthv-toolbox/agent-runtime` 已声明 package exports 与生产依赖。 -> [结论] 作为 Electron 的生产依赖打进 ASAR，不继续准备独立 Node 运行时资源。
- [前端] -> 渲染器已移除 Tauri 调用。 -> [结论] 可以移除 Tauri JavaScript 包和启动脚本，同时保留 Vue/Vite 浏览器预览。
