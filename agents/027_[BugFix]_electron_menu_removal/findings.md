# 调研记录

- [默认菜单] -> Electron `BrowserWindow` 未设置应用菜单 -> Windows 生产窗口会显示 Electron 默认 File/Edit 菜单；应使用 `Menu.setApplicationMenu(null)` 在应用就绪时统一清除。
- [验证环境] -> 初次运行完整合同套件时缺少工作区 `typescript` 可执行文件，后续以 `npm ci --ignore-scripts` 安装锁定依赖，构建后完整套件通过。
