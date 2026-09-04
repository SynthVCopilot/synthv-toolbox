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

## 真实 Windows Actions 复现

- [run 33824920882 / job 100875483752] -> Windows x64 在 `Test Rust core and FFmpeg fixtures` 失败，后续 lint 与打包步骤被跳过 -> 日志确认 `windows-sys` 0.61.2 下 `Foundation::BOOL` 不存在、Win32 HWND 参数已改为官方 `HWND` 指针类型，且 `synthv_hosts.rs` 的 `FileTypeExt::is_reparse_point` 不存在。
- [平台 import] -> `Stdio`、`quiet_command` 仅由 macOS 分支使用，`FileTypeExt` 不提供所需 API -> 将 import 限定到 macOS，并使用 Windows `MetadataExt::file_attributes` 与 `FILE_ATTRIBUTE_REPARSE_POINT`。
- [Windows target cargo check] -> 已安装 `x86_64-pc-windows-msvc`，并成功检查 `windows-sys v0.61.2`；项目随后在 `ring` C 编译阶段失败 -> 当前 macOS 主机无 Windows MSVC C 工具链，缺少目标编译环境的 `assert.h`，不是 Rust 源码诊断。
- [run 33826755787 Windows Clippy] -> Rust 编译与 204 项平台测试已通过，但 macOS 应用常量及辅助解析函数在 Windows 非测试 target 上成为 dead code -> 将生产仅 macOS 的符号收窄到 `target_os = "macos"`，仅为跨平台纯测试需要的符号保留 `test` 条件。
- [run 33826067978 / Windows job 100878878085] -> Rust 已成功编译并运行测试，203 passed、4 failed、2 ignored -> 失败仅为四个显式依赖 `SV1_APP`、`FLAT_APP`、`Contents/MacOS` 或 `FLAT_MAC_SCRIPTS` 的 macOS fixture；三个 Windows 专用 host 测试均通过。
- [测试边界] -> `same_executable_is_disambiguated_by_app_bundle_path` 同样使用 macOS 风格路径，但在 Windows job 通过 -> 该测试保留跨平台执行，只限定用户点名的四个 fixture。
- [Windows lint 边界] -> 四个 fixture 限定到 macOS 后，`FLAT_EXECUTABLE_PATH` 与 `FLAT_MAC_SCRIPTS` 会在 Windows 失去测试侧引用 -> 分别按 `not(windows)` 与 `target_os = "macos"` 收窄常量，避免后续 Windows clippy 产生死代码告警。
