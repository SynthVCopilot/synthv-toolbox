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
- **SV 工程工具**：只读探测 `.svp` 版本、时代和轨道结构；生成带静音参考轨或清空 Automation/Smart Pitch 的无参工程副本；按选定轨道同时导出普通 LRC 与增强逐字 LRC。以上操作都读取已保存的磁盘工程，不覆盖源文件。
- **SynthV Bridge**：探测 Synthesizer V、安装/诊断内置 Bridge，并通过私有 stdio MCP 连接；不监听网络端口。
- **Copilot**：可持久化会话，通过已启用的 SynthV Bridge 与外部 MCP 工具工作。
- **外部 MCP**：配置、启用、测试和移除受信任的 stdio MCP 服务器。
- **组件下载队列**：将 `pi-audio`、CVRS 和 Windows x64 的 Sandboxie Plus 官方安装包加入串行队列，使用 aria2 断点下载，并在使用前再次校验固定版本与 SHA-256。
- **SV2 账号槽位（Windows）**：保存完整官方数据根的本地槽位，事务化切换默认环境并启动 SV2；账号页只报告每个槽位的 `license/session` 文件是否存在，不把文件存在解释为已登录，也不要求手工填写用户名或邮箱。
- **本地 session 保护与恢复（Windows）**：工具箱页预检普通实例、插件、WebView2 与 Sandboxie 进程；若受保护启动后本地 session 在观察窗口内消失，下次由工具箱启动该槽位前会尝试原样恢复，但不推断文件消失的原因。
- **低频账号状态检测（Windows）**：进入“SV2 账号”或“超级工具箱”页面时立即检查一次，页面可见期间再以低频率刷新；同一时间只执行一轮本机进程快照。红点只表示确认存在本机占用，黄点表示远端状态未验证；在没有权威服务端结果时不显示绿色“无人使用”。
- **零猜测账号资料（Windows）**：不读取商店目录缓存，不用本机安装项、文件名、邮箱片段或 session 消失推断账号身份、声库授权或远端占用。没有经过验证的官方结果时，用户名、邮箱和授权声库统一显示“未验证”。
- **并发隔离（Windows）**：在用户显式准备隔离副本且本机提供 Sandboxie Plus 1.17.6 或 Classic 5.72.6 以上版本时，为每个槽位分配独立的文件、注册表与 IPC 命名空间，并允许多个槽位并发启动。
- **可选 `.svp` 智能启动（Windows）**：当 Toolbox 已在运行并启用此功能时，读取工程中公开的声库引用并排除确认存在本机占用的槽位；在没有可验证授权结果时始终要求用户确认，不自动猜测账号或声库。

账号槽位和并发隔离是 Windows 专属能力；音频、MIDI、工程、Bridge、Copilot 与 MCP 工作流同时支持 Windows 和 macOS。

并发隔离不会拦截网络，也不会修改、上传或伪造账号凭据，SV2 仍通过官方服务完成持续验证。账号资料探测只检查受信槽位中 `license/session` 的普通文件元数据，不读取内容；本地恢复功能会把原始字节作为不透明快照复制，但不解析、展示或发送。第一次点击“准备隔离实例”会把该槽位的完整不透明数据复制到工具箱保管区；此后隔离实例的本地变化不会自动合并回普通槽位。同账号或工程能否跨实例同步取决于 Dreamtonics 官方服务。Sandboxie Plus / Classic 未安装时，普通槽位切换仍可独立使用。

“SV2 账号”页面会分别呈现普通启动和隔离启动，并显示实际集成的 Sandboxie 版本线、版本号、安装目录，以及每个槽位的 session 文件状态和未准备、已准备或运行中状态。密码、Cookie、令牌和 session 原文不会进入前端、日志或 MCP；用户名、邮箱和声库授权没有权威查询结果时保持“未验证”。未激活槽位可直接在账号卡片上设为默认，无需打开管理页面，也不会自动启动 SV2。

普通与隔离启动都会启用本地 session 保护：启动前把现有 `license/session` 作为不透明字节保存到当前用户的短期恢复区，并记录 SHA-256；如果 session 在启动后的 10 分钟窗口内消失，状态会变为“等待恢复”。下一次由工具箱启动同一槽位时，仅在目标 session 仍不存在且快照校验通过时恢复；若 SV2 已生成新 session，旧快照会直接丢弃，绝不覆盖。session 保留到正常退出时会清理短期快照，工具箱也不会解析、展示或发送其内容。观察窗口外发生的文件消失不会自动恢复，也不会被归因为退出、过期或远端冲突。

进入“SV2 账号”或“超级工具箱”页面会立即刷新当前账号占用预检，页面保持可见时再以低频率更新。它只能确定本机普通/插件/WebView2/Sandboxie 占用；受保护 session 被清除只会触发本地恢复状态，不再解释为其他设备占用。远端状态始终保持“未验证”，不会误报为无人使用。

SV2 自带账号页的确定链路是：SV2 进程内部通过 JUCE WebView native function 取得短期 JWT，再以 Bearer 凭据查询 Dreamtonics。本机已检查的 `license/session` 样本不是 JWT，也没有经过验证的协议证明该文件可直接发送给账号 API；JUCE native function 仅存在于 SV2 自己的 WebView 组件中，目前没有可供独立 Toolbox 调用的外部 broker。因此本版本不会上传、猜解或依次尝试解释 session，也不会复用 `authr3-frontend` 客户端冒充官方页面。只有在存在经过验证的 broker 与响应契约后，远端身份和授权查询才会启用。

隔离内容可以细分控制。应用设置（`settings`）和声库数据（`databases`）各有一个全局默认开关；每个账户又可分别选择“跟随全局”“开启隔离”或“关闭隔离（共享）”，界面会显示解析后的实际状态。默认值保持两项都隔离，以兼容既有安全行为。关闭某项隔离时，工具箱只为对应目录写入该 box 的 Sandboxie `OpenFilePath` 直通规则；账号会话、WebView2、注册表和 IPC 仍然隔离。策略修改在下一次隔离启动时生效；共享目录可能被并发实例同时写入，应由用户自行评估工程环境与声库更新操作。

并发隔离是正式能力。本技术方案基于 Sandboxie 的进程树虚拟化实现，不是 Dreamtonics 原生多实例功能；第一次启动并发实例时，应用会显示“潜在风险功能告知”，确认结果保存到本地设置。工具箱不修改 SV2 二进制、不绕过账户限制，也不拦截官方联网验证；这不等于 Dreamtonics 已确认其符合全部账号政策或服务条款。Sandboxie 的内部配置名称不会显示在应用或隔离窗口标题中。

截至当前版本，开发组没有收到因使用并发隔离而被官方警告或处理的记录，但 Dreamtonics 仍可能将其认定为不当或违规使用并采取措施。首次确认会说明：启用表示用户已知晓并自担风险，并在适用法律允许的最大范围内不追究 SynthV Toolbox 开发组的直接或连带责任。

普通切换检测到 SV2 standalone、WebView2 或已加载插件的宿主进程时，会显示包含进程名、PID 和原因的确认弹窗。用户可以取消、通过 Sandboxie 保留当前进程并以并发模式运行目标槽位，或明确选择“强制切换并启动”；强制模式会在 Rust 后端重新扫描 PID，以 `taskkill /PID <pid> /T /F` 结束列出的进程树，确认占用消失后才移动槽位目录。

本地兼容性冒烟测试已验证 Sandboxie Classic 5.73.2 可以在普通 SV2 2.2.1 已运行时启动第二个 SV2，并保持主窗口、WebView2 子进程树和网络连接正常。该结果只证明技术兼容性，不代表 Dreamtonics 对并发登录、设备计数或云同步策略的承诺。

## `.svp` 智能启动边界

智能启动是可关闭的候选文件处理器，不会注入、修改或劫持 Synthesizer V 进程。只有 Toolbox 已经运行时，它才会分析 `.svp` 中声明的声库，排除已确认忙碌或有本地 session 待恢复的槽位，并在条件满足时选择普通启动或 Sandboxie 并发启动。工程没有可识别的人声声库时可以选择空闲账号；工程需要的授权没有可验证证据时只给出候选并要求用户确认，不做模糊猜测。

Toolbox 未运行时，或智能启动开关关闭时，`.svp` 会透传给启用功能前记录的原文件处理器，不进行账号路由。Windows 只把 SynthV Toolbox 注册为“打开方式”候选，不修改受系统保护的 `UserChoice`；用户必须在 Windows 默认应用设置中亲自确认由 Toolbox 处理 `.svp`，关闭功能也不会擅自改回系统默认项。

## 安全边界

- 纯工具箱模式不会暴露 AI/MCP 设置，也不会启动模型请求。
- 模型令牌仅写入当前用户的本机配置，不返回前端。
- 外部 MCP 只能由用户显式添加和启用；它可以启动本地进程，因此只应配置可信命令。
- MIDI、工程副本和 LRC 统一写入 `~/.SynthVcopilot/output/`，输出参数只接受文件名并拒绝路径穿透。
- Bridge 安装器只写入用户指定的 SynthV `scripts` 目录。
- 远程组件只能进入串行下载队列；aria2 只获取公开 `pi-agent` 的固定提交，或官方 Sandboxie GitHub Release 中固定版本的 x64 安装包，Rust 后端在使用前逐文件复核 SHA-256，未知或未固定版本的组件会被拒绝。Sandboxie 仅下载到本机并打开所在位置，工具箱不会静默安装其内核驱动。
- 并发隔离只使用受支持版本的本机 Sandboxie Plus / Classic，拒绝未知 reparse point，不修改 SV2 二进制或官方校验流程；本地 session 恢复只回写同一槽位、SHA-256 校验通过且目标仍为空的短期快照，不做跨槽位或运行中合并。
- 强制槽位切换只结束后端重新检测到的 SV2 占用 PID，不接受前端提供的任意 PID；若仍存在无 PID 的单实例锁或文件占用，切换会停止而不会移动槽位目录。

## 仓库结构

```text
src/PiDesktop.Tauri/          TypeScript/Vite UI + Rust/Tauri 后端
├─ src-tauri/src/agent/       Toolbox 内置 Agent 运行时
└─ src-tauri/components/      Toolbox 内置音频/CVRS 组件源码
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

`Desktop` 工作流仅在推送 `v*` tag 时运行；普通分支 push、Pull Request 和无 tag 的提交不会触发构建。发布构建会执行以下验证：

1. 检出 SynthV Bridge submodule，构建并裁剪内置 Bridge。
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
