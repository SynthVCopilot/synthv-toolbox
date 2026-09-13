# Progress

- 已确认当前 Electron 构建资源包含 ICO 和 ICNS，但这些资源不会自动成为主进程运行时文件。
- 已增加 `prepare-electron-assets.mjs`，由 `build:host` 复制图标到 `dist/electron/assets`。
- 已将 BrowserWindow 与 Tray 统一为主进程相邻的图标路径。
- 已新增 `test/electron-resource-paths.mjs`，验证源码引用和构建后 ICO/ICNS 文件。
- 已通过 `npm run build:electron`、`npm run test:contracts` 与 `npm run test:electron-main`。
