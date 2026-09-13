# Findings

- [问题现象] `electron/assets` 只有 `icon.ico` 与 `icon.icns`，而托盘原实现引用 Vite 公共 PNG。 -> [结论] 将 Electron 原生图标复制入 `dist/electron/assets`，从主进程相邻路径加载，确保 ASAR 内路径一致。
- [验证] `build:electron` 后 `dist/electron/assets/icon.ico` 与 `icon.icns` 均存在，且完整合同套件与主进程冒烟测试通过。 -> [结论] 运行时图标路径已随 `dist/**/*` 进入 Electron Builder 的 ASAR 文件集。
