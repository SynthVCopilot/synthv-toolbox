# 调研与发现

- 目标分支为 `codex/dev-build-artifacts`，初始工作区干净。
- `.github/workflows/ffmpeg-verify.yml` 已按 Windows NSIS 与 macOS universal app/DMG 矩阵执行一次 `npm run tauri build`，后续步骤只做输出校验。
- `src/PiDesktop.Tauri/package.json` 的 `test:contracts` 由根 `/test` 下的 Node `.mjs` 契约串联，未使用直接声明的 YAML 解析依赖，因此新契约采用静态文本断言。
- 任务范围明确排除 Rust 和 `ensure-bridge`；本任务只涉及 workflow、根测试和 package script，以及 `/agents` 审计记录。
- 首次验证从 `src/PiDesktop.Tauri` 执行根测试路径，导致 Node 找不到 `src/PiDesktop.Tauri/test/...`；改为从 worktree 根目录执行后重试。
- 最终静态契约、Ruby YAML 解析、`actionlint` 和完整 `npm run --prefix src/PiDesktop.Tauri test:contracts` 均通过。
- 首次验证从 `src/PiDesktop.Tauri` 执行根测试路径，导致 Node 找不到 `src/PiDesktop.Tauri/test/...`；改为从 worktree 根目录执行后重试。
