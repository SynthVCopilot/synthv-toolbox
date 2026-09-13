# Findings

- [安装版 SVG Logo 不显示] -> 发现 HTML 与动态渲染模板都使用 `/assets/...` 根绝对路径。Electron 以 `file://` 打开页面时，这会解析到磁盘根目录而非 `dist/assets`。
- [安装程序和托盘图标] -> SVG 适用于渲染层；Windows 和 macOS 的系统图标必须分别由 ICO 和 ICNS 提供，不能用 SVG 取代。
- [生产构建验证] -> `dist/index.html` 不再含 `/assets/` 根绝对引用，且 `dist/assets/synthv-toolbox-logo.svg` 已输出。
