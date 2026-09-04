# Findings

## 初始状态

- 指定 worktree 位于 `/Users/user/.codex/worktrees/synthv-toolbox/actions-build-fix`，当前分支为 `codex/actions-build-fix`，起点为 `79dd5f1`，工作树初始干净。
- Bridge 构建脚本位于 `src/PiDesktop.Tauri/scripts/ensure-bridge.mjs`；当前无条件执行 `npm run build`，仅在 `node_modules` 缺失时执行一次完整 `npm ci`。
- Bridge 的 `@types/node`、TypeScript 等构建依赖位于 `devDependencies`，而 CI 会先构建再裁剪生产依赖。
- `downloads.rs` 已发现 `map(|item| *item = previous)` 的 unit closure 候选。
- `workflows.rs` 的过多参数具体触发点待通过 clippy 输出确认。

## 实现结论

- Bridge 的有效入口定义为 `dist/src/cli.js` 与 `dist/legacy-sv1/src/cli.js`；两个文件同时存在时 `ensure-bridge` 立即成功退出，不触碰已裁剪的 `node_modules`。
- Bridge 入口缺失时统一执行 `npm ci --include=dev --no-audit --no-fund`，确保构建依赖恢复后再运行 `npm run build`。
- `game_to_midi_cancellable` 的八个参数收敛到 `GameToMidiRequest`，调用方使用具名字段，保留所有取消、输出和资源路径语义。
- `game_to_midi_cancellable` 使用 `request.resource_dir` 配置 FFmpeg 环境，避免请求结构重构后引用已删除的局部变量。
- `downloads.rs` 的回滚由显式 `if let Some` 完成，避免 `Option::map` 产生 unit closure lint。
- [集成复核] -> 无条件依赖 `dist` 会使本地源码改动不再重建 -> 仅当 GitHub Actions 的 `CI=true` 且两个 CLI 入口完整时复用预构建；本地开发继续正常重建。
- [`actionlint` 全量检查] -> 发布说明的 `git log` 格式串在单引号内使用 GitHub 表达式，触发 SC2016 -> 改用 Actions 默认的 `GITHUB_REPOSITORY` 环境变量和安全的双引号格式。
