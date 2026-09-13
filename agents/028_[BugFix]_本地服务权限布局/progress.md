# Progress

- 2026-09-13：创建独立 worktree `codex/connections-layout`，基于 `origin/main`。
- 2026-09-13：检查 `renderMcp`、`renderSettings`、`styles.css`、`test/http-mcp-ui.mjs` 与现有 `.fluent-select` 样式。
- 2026-09-13：将本地服务页面拆成接口访问、特权访问和保存操作三个区域；端点与特权卡片在 720px 以下改为单列。
- 2026-09-13：核查 `@model-auth/vue`、项目依赖和相邻仓库，未找到可复用的通用 Fluent 下拉组件；没有用本地 CSS 样式冒充 kit 组件。
- 2026-09-13：执行 `node test/http-mcp-ui.mjs`、`node test/autostart-behavior.mjs` 和 `npm run build:renderer`，全部通过。
- 2026-09-13：已移除验证期间建立的本地依赖目录 junction；worktree 不保留构建环境链接。
- 2026-09-13：最终版本再次执行 `npm --prefix src/PiDesktop.Tauri run build:renderer`，通过后移除了临时依赖 junction。
