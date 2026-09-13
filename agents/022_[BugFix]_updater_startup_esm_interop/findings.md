# 调研记录

- [启动崩溃] -> 已安装应用以 ESM 执行 `electron/updater.ts` 编译产物 -> `electron-updater` 是 CommonJS，具名 ESM 导入 `autoUpdater` 不受支持，抛出 `SyntaxError: Named export 'autoUpdater' not found`。
- [依赖安装] -> 直接 `npm ci` -> 本地 `agent-runtime` 的 prepare 脚本先于 TypeScript 安装运行，导致 `tsc` 不存在；使用 `npm ci --ignore-scripts` 安装验证依赖，并单独构建工作区包。
