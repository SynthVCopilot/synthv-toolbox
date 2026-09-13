# Progress

- 已建立独立 worktree `codex/svg-logo`。
- 已检查页面 Logo 引用、Vite 配置与现有平台图标资源。
- 将所有页面和动态模板内的 Logo URL 改为 `./assets/synthv-toolbox-logo.svg`，并将 Vite 的 `base` 设为相对路径。
- 新增 `test/renderer-logo-assets.mjs`，检查源引用、Vite 配置和 SVG 资源存在性。
- 已执行 `npm ci --no-audit --no-fund`、`npm run build`、合同测试和构建产物检查；全部通过。
