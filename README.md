# SynthV Toolbox

SynthV Toolbox 是以 **Rust + Tauri** 构建的 Synthesizer V 创作工具箱，支持 Windows 与 macOS。应用既可以作为完全本地、无需模型的超级工具箱运行，也可以启用 AI 模式，获得 Copilot、智能增强和外部 MCP 工具接入。

> 本仓库只维护新版 Tauri 应用，不再包含 C# / WinUI 旧版。

## 两种运行模式

首次启动会要求选择模式，之后可在设置中随时切换。模式限制同时由界面与 Rust 后端执行，不能通过直接调用前端命令绕过。

| 能力 | 纯工具箱模式 | AI 模式 |
|---|---:|---:|
| 音频基础分析、基础 Game → MIDI、SV 工程工具 | ✓ | ✓ |
| SynthV Bridge、本地组件管理 | ✓ | ✓ |
| Game → MIDI 多参数寻优与高级自动纠正 | — | ✓ |
| 高级置信度检查、PANNs/音符统计 | — | ✓ |
| 使用已配置模型复核工作流结果 | — | ✓ |
| Copilot、会话历史、SynthV 工具编排 | 不显示入口 | ✓ |
| 外部 stdio MCP 接入 | 不显示入口 | ✓ |
| 模型运行时和模型网络请求 | 不启动 | 按需启动 |

纯工具箱模式下，Game → MIDI 固定使用 `0.08s` 配对容差，不执行多参数寻优、自动音符纠正、高级置信度检查或模型复核。AI 模式允许调整容差，并对多个候选参数评分，执行保守的八度偏移修正、重复音符合并与碎片清理；结果中会保留修正计数和置信度明细。

## 已实现功能

- **Game → MIDI**：用时间轴对齐的有词/演唱版与无词/伴奏版做音符差分，输出可导入的单音 MIDI。
- **音频分析**：输出 BPM、调性估计、能量弧、打击占比和频谱趋势；AI 模式可增加音符统计、乐器/风格倾向和人声判断。
- **SV 工程工具**：只读探测 `.svp` 版本、时代和轨道结构；在不修改源文件的前提下生成带静音参考音频轨的工程副本。
- **SynthV Bridge**：探测 Synthesizer V、安装/诊断内置 Bridge，并通过私有 stdio MCP 连接；不监听网络端口。
- **Copilot**：可持久化会话，通过已启用的 SynthV Bridge 与外部 MCP 工具工作。
- **外部 MCP**：配置、启用、测试和移除受信任的 stdio MCP 服务器。
- **组件下载队列**：将 `pi-audio`、CVRS 等受信任组件加入串行队列，使用 aria2 断点下载，并在安装前再次校验固定提交与 SHA-256。
- **SV2 账号槽位（Windows）**：保存完整官方数据根的本地槽位，事务化切换默认环境并启动 SV2；可为槽位填写用户名和邮箱标签，但不读取或伪造凭据/session 内容。
- **并发隔离（Windows）**：在用户显式准备隔离副本且本机提供 Sandboxie Plus 1.17.6 或 Classic 5.72.6 以上版本时，为每个槽位分配独立的文件、注册表与 IPC 命名空间，并允许多个槽位并发启动。

账号槽位和并发隔离是 Windows 专属能力；音频、MIDI、工程、Bridge、Copilot 与 MCP 工作流同时支持 Windows 和 macOS。

并发隔离不会拦截网络，也不会读取或伪造账号凭据，SV2 仍通过官方服务完成持续验证。第一次点击“准备隔离实例”会把该槽位的完整不透明数据复制到工具箱保管区；此后隔离实例的本地变化不会自动合并回普通槽位。同账号或工程能否跨实例同步取决于 Dreamtonics 官方服务。Sandboxie Plus / Classic 未安装时，普通槽位切换仍可独立使用。

“SV2 账号”页面会分别呈现普通启动和隔离启动，并显示实际集成的 Sandboxie 版本线、版本号、安装目录，以及每个槽位的用户名、邮箱和未准备、已准备或运行中状态。用户名与邮箱只是用户填写的本地标签，不从 Cookie、WebView2 缓存或 `license/session` 推断。重命名和数据路径位于折叠的管理区，不会干扰日常启动操作。

并发隔离是正式能力。本技术方案基于 Sandboxie 的进程树虚拟化实现，不是 Dreamtonics 原生多实例功能；第一次启动并发实例时，应用仍会明确提示这种多实例使用方式尚未被 Dreamtonics 官方承认，确认结果会保存到本地设置。工具箱不修改 SV2 二进制、不绕过账户限制，也不拦截官方联网验证；这不等于 Dreamtonics 已确认其符合全部账号政策或服务条款。当前入口只启动 SV2 standalone，不会把已经运行的 DAW 宿主或插件实例移入隔离空间。Sandboxie 启动参数固定为 `/box:<name>`，box 名称不添加 `#`。

截至当前版本，开发组没有收到因使用并发隔离而被官方警告或处理的记录，但 Dreamtonics 仍可能将其认定为不当或违规使用并采取措施。首次确认会说明：启用表示用户已知晓并自担风险，并在适用法律允许的最大范围内不追究 SynthV Toolbox 开发组的直接或连带责任。

普通切换检测到 SV2 standalone、WebView2 或已加载插件的宿主进程时，会显示包含进程名、PID 和原因的确认弹窗。用户可以取消、通过 Sandboxie 保留当前进程并以并发模式运行目标槽位，或明确选择“强制切换并启动”；强制模式会在 Rust 后端重新扫描 PID，以 `taskkill /PID <pid> /T /F` 结束列出的进程树，确认占用消失后才移动槽位目录。

本地兼容性冒烟测试已验证 Sandboxie Classic 5.73.2 可以在普通 SV2 2.2.1 已运行时启动第二个 SV2，并保持主窗口、WebView2 子进程树和网络连接正常。该结果只证明技术兼容性，不代表 Dreamtonics 对并发登录、设备计数或云同步策略的承诺。

## 安全边界

- 纯工具箱模式不会暴露 AI/MCP 设置，也不会启动模型请求。
- 模型令牌仅写入当前用户的本机配置，不返回前端。
- 外部 MCP 只能由用户显式添加和启用；它可以启动本地进程，因此只应配置可信命令。
- MIDI 和工程副本统一写入 `~/.SynthVcopilot/output/`，输出参数只接受文件名并拒绝路径穿透。
- Bridge 安装器只写入用户指定的 SynthV `scripts` 目录。
- 远程组件只能进入串行下载队列；aria2 只获取代码中固定的公开 `pi-agent` 提交，Rust 后端在安装前复核 SHA-256，未知或未固定版本的组件会被拒绝。
- 并发隔离只使用受支持版本的本机 Sandboxie Plus / Classic，拒绝未知 reparse point，不修改 SV2 二进制或官方校验流程，也不提供自动回写/合并登录缓存。
- 强制槽位切换只结束后端重新检测到的 SV2 占用 PID，不接受前端提供的任意 PID；若仍存在无 PID 的单实例锁或文件占用，切换会停止而不会移动槽位目录。

## 仓库结构

```text
src/PiDesktop.Tauri/          TypeScript/Vite UI + Rust/Tauri 后端
external/pi-agent/            Rust agent 核心与音频/CVRS 组件（submodule）
external/synthv-agent-bridge/ SynthV Bridge（submodule）
.github/workflows/desktop.yml Windows、macOS、tag Release 构建
```

## 本地开发

需要 Rust stable、Node.js `22.19+`、npm、aria2，以及对应平台的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。也可以通过 `SYNTHV_TOOLBOX_ARIA2` 指定 `aria2c` 路径。安装 `pi-audio` 时还需要 Python 3.11；macOS 构建需要 Xcode Command Line Tools。

```bash
git submodule update --init --recursive

cd external/synthv-agent-bridge
npm ci
npm run build
npm prune --omit=dev

cd ../../src/PiDesktop.Tauri
npm ci
npm run tauri dev
```

本地验证：

```bash
npm run build --prefix src/PiDesktop.Tauri
cargo fmt --manifest-path src/PiDesktop.Tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path src/PiDesktop.Tauri/src-tauri/Cargo.toml
cargo clippy --manifest-path src/PiDesktop.Tauri/src-tauri/Cargo.toml --all-targets -- -D warnings
```

## GitHub Actions 与发布

`Desktop` 工作流在 `main`、Pull Request 和手动触发时执行以下验证：

1. 检出两个 submodule，构建并裁剪内置 SynthV Bridge。
2. 检查 Python 组件、TypeScript 生产构建、Rust 格式、测试和 Clippy。
3. 在 GitHub 托管 runner 上生成 Windows x64 NSIS 安装器与 macOS Universal `.dmg` / `.app.zip`。
4. 把各平台安装包保存为 Actions artifacts。

推送符合语义版本的 tag 会自动发布，例如：

```bash
git tag v0.2.0
git push origin v0.2.0
```

tag 会注入 npm、Cargo 与 Tauri 包版本。两个平台均构建成功后，工作流会从上一个 tag 到当前 tag 汇总每一条 commit 作为“更新内容”，创建同名 GitHub Release，并附加 Windows 与 macOS 安装包。带后缀的 tag（如 `v0.2.0-beta.1`）会发布为 prerelease。

当前 CI 产物未进行 Apple Developer ID notarization 或 Windows 代码签名；正式分发前应在仓库 Secrets 中接入对应签名身份。

## License

[Apache-2.0](LICENSE)
