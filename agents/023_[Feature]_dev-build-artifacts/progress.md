# 操作记录

- 已读取 `agent-mode` 规范并检查项目索引、任务追踪、工作区状态。
- 已检查现有 `ffmpeg-verify.yml`、桌面 package scripts 与根契约测试样式。
- 已完成 workflow、根静态契约和 `test:contracts` 接入。
- 首次验证因工作目录导致相对路径错误，尚待从 worktree 根目录重跑。
- 2026-09-03：子分支提交 `04d78af`，并在合并后将两个 upload 步骤收敛为一个矩阵通用步骤，Windows 和 macOS 均写入按 target 命名的临时目录。
- 2026-09-03：读取 run 33824656718 的 Windows job 日志，确认原构建错误已消失，修复 workflow 契约的 CRLF 跨平台兼容。
- 2026-09-03：根据 hosted runner 警告将 Rust 缓存 action 升级为 `actions/cache@v5`，并增加契约断言。
- 根据提交前要求，将 workflow 名称改为 `Toolbox Dev Build`、artifact 名称加入 `dev`，并复用 macOS `dmg_path`。
- 已完成 workflow、根静态契约和 `test:contracts` 接入。
- 首次验证因工作目录导致相对路径错误，尚待从 worktree 根目录重跑。
