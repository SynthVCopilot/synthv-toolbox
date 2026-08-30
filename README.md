# SynthV Toolbox

SynthV Toolbox 是以 **Rust + Tauri** 构建的 Synthesizer V 创作工具箱，支持 Windows 与 macOS。应用既可以作为完全本地、无需模型的工具箱运行，也可以启用 AI 模式，获得 Copilot、智能增强和外部 MCP 工具接入。

> 本仓库只维护新版 Tauri 应用，不再包含 C# / WinUI 旧版。

## 两种运行模式

首次启动会要求选择模式，之后可在设置中随时切换。模式限制同时由界面与 Rust 后端执行，不能通过直接调用前端命令绕过。

| 能力 | 纯工具箱模式 | AI 模式 |
|---|---:|---:|
| 音频基础分析、演唱音频 → MIDI / SynthV、SV 工程文件工具 | ✓ | ✓ |
| SynthV Bridge、本地组件管理 | ✓ | ✓ |
| 演唱音频提取的多参数寻优与高级自动纠正 | — | ✓ |
| 高级置信度检查、PANNs/音符统计 | — | ✓ |
| 使用已配置模型复核工作流结果 | — | ✓ |
| Copilot、会话历史、SynthV 工具编排 | 不显示入口 | ✓ |
| 外部 stdio MCP 接入 | 不显示入口 | ✓ |
| 模型运行时和模型网络请求 | 不启动 | 按需启动 |

纯工具箱模式下，演唱音频提取固定使用 `0.08s` 配对容差，不执行多参数寻优、自动音符纠正、高级置信度检查或模型复核。AI 模式允许调整容差，并对多个候选参数评分，执行保守的八度偏移修正、重复音符合并与碎片清理；结果中会保留修正计数和置信度明细。

## 已实现功能

- **演唱音频 → MIDI / SynthV**：用时间轴对齐的有词/演唱版与无词/伴奏版做音符差分；默认输出单音 MIDI，连接 Bridge 后可继续导入当前 SynthV 工程。
- **音频分析**：输出 BPM、调性估计、能量弧、打击占比和频谱趋势；AI 模式可增加音符统计、乐器/风格倾向和人声判断。
- **SV 工程转换器**：把本地 MIDI、MusicXML 或 MXL 中明确的单声部安全导入当前 SynthV 工程；导入前后均由 Bridge 校验，源速度不会自动应用，最终由用户在 SynthV 中检查并保存。它不跨版本直译 SV1 / SV2 的歌手、唱法与参数。
- **SV 工程文件工具**：只读探测 `.svp` 版本、时代和轨道结构；生成带静音参考轨或清空 Automation/Smart Pitch 的无参工程副本；按选定轨道同时导出普通 LRC 与增强逐字 LRC。以上操作都读取已保存的磁盘工程，不覆盖源文件。
- **SynthV Bridge**：探测 Synthesizer V、安装/诊断内置 Bridge，并通过私有 stdio MCP 连接；不监听网络端口。
- **片段 A/B 检查（Windows）**：通过 Bridge 精确定位、播放和恢复播放头，并使用 WASAPI 进程回环只捕获所选 SynthV standalone 进程树。基线 A 可持续复用；候选 B 捕获后会自动消除回环延迟并输出轻量差异指标，无需重复完整渲染或启动高级音频模型。详见 [片段 A/B 捕获设计](docs/ab-clip-capture.zh-CN.md)。
- **Copilot**：可持久化会话，通过已启用的 SynthV Bridge 与外部 MCP 工具工作。
- **外部 MCP**：配置、启用、测试和移除受信任的 stdio MCP 服务器。
- **组件下载队列**：将 `pi-audio`、CVRS 和 Windows x64 的 Sandboxie Plus 官方安装包加入串行队列，使用 aria2 断点下载，并在使用前再次校验固定版本与 SHA-256。
- **SV2 账号槽位（Windows）**：保存完整官方数据根的本地槽位，事务化切换默认环境并启动 SV2；可为槽位填写用户名和邮箱标签。用户明确开启账号登录指示器后，预检会在 Rust 后端按 SV2 的本机格式解密 `license/session` 以取得 JWT，但不会读取密码、伪造凭据或把 JWT 返回前端；仅把标准 claims 中经过长度、控制字符、空白与邮箱格式检查的 `name` / `email`（必要时以 `preferred_username` 作为姓名回退）作为账号识别信息显示。
- **账号占用锁与登录态恢复（Windows）**：“SV2 账号”页预检普通实例、插件、WebView2、Sandboxie 进程及会话失效证据；受保护启动后若用户取消 SV2 的“踢下其他设备”选择而使登录态消失，下次由工具箱启动该槽位前会尝试原样恢复。
- **显式账号登录指示器（Windows）**：功能默认关闭，首次开启前以弹窗说明并要求确认。开启后只在进入“SV2 账号”页面和用户手动刷新时访问账号服务，不做定时轮询，也不由其他工具或智能路由旁路触发。绿点表示官方服务在该检查时刻接受了与 SV2 启动一致的无踢出设备登录事件，红点表示本机占用、恢复冲突或服务返回明确并发冲突，黄点表示远端状态未知。
- **应用更新检查**：在“工具箱”中按需查询官方 GitHub Releases，对比当前版本与最新稳定版、查看发布说明并打开官方发布页；不会静默下载或安装。
- **声库授权清单（Windows）**：账号登录预检使用当前 JWT 查询许可清单，只提取状态为 active 的 `Voice Database` / `Voice Databases 2` 产品名用于工程路由；每个槽位仍可保存用户明确确认的补充名称。本地发现的不透明声库目录只表示该机器存在安装痕迹，不等于该账号拥有授权，也不会把内部 ID 当作产品名展示。
- **并发隔离（Windows）**：在用户显式准备隔离副本且本机提供 Sandboxie Plus 1.17.6 或 Classic 5.72.6 以上版本时，为每个槽位分配独立的文件、注册表与 IPC 命名空间，并允许多个槽位并发启动。
- **可选 `.svp` 智能启动（Windows）**：当 Toolbox 已在运行并启用此功能时，读取工程中公开的声库引用，结合会话预检、占用证据与账号许可清单选择最优槽位；只有会话被账号服务接受且官方授权完整匹配时才可静默启动，其他情况要求用户确认。

账号槽位、并发隔离和进程级片段捕获是 Windows 专属能力；其余音频、MIDI、工程、Bridge、Copilot 与 MCP 工作流同时支持 Windows 和 macOS。

并发隔离不会拦截网络或伪造账号凭据，SV2 仍通过官方服务完成持续验证。第一次点击“准备隔离实例”会把该槽位的完整不透明数据复制到工具箱保管区；账号登录指示器启用后只在显式触发时于后端内存中解密该副本的 session，并只向前端返回状态、授权摘要以及清洗后的账号姓名/邮箱识别值。此后隔离实例的本地变化不会自动合并回普通槽位。同账号或工程能否跨实例同步取决于 Dreamtonics 官方服务。Sandboxie Plus / Classic 未安装时，普通槽位切换仍可独立使用。

“SV2 账号”页面会分别呈现普通启动和隔离启动，并显示实际集成的 Sandboxie 版本线、版本号、安装目录，以及每个槽位的用户名、邮箱和未准备、已准备或运行中状态。槽位用户名与邮箱仍是用户填写的本地标签；只有在用户确认开启账号登录指示器并执行预检后，页面才会额外显示从 access JWT 标准 claims 提取并清洗的姓名/邮箱用于识别，不从 Cookie 或 WebView2 缓存推断，也不把这些识别值写回槽位清单。重命名和数据路径位于折叠的管理区，不会干扰日常启动操作。

普通与隔离启动都会启用账号占用锁：启动前把现有 `license/session` 作为不透明字节保存到当前用户的短期恢复区，并记录 SHA-256；如果 session 在启动后的 10 分钟窗口内消失，状态会变为“等待恢复”。下一次由工具箱启动同一槽位时，仅在目标 session 仍不存在且快照校验通过时恢复；若 SV2 已生成新 session，旧快照会直接丢弃，绝不覆盖。正常退出会清理短期快照；登录态保护器不解析快照，账号预检也绝不读取恢复区。主动退出账号发生在启动窗口以外时不会自动恢复。

账号登录指示器默认关闭；开启弹窗会明确告知它不是 dry-run，并在用户确认后持久化开关。开启后，进入“SV2 账号”页面时执行一次预检，之后只有用户点击“重新预检/刷新”才再次访问；页面停留、恢复可见、选择性同步、`.svp` 路由和启动命令均不会触发敏感接口。预检安全读取并解密真实数据根中的 `license/session`；access JWT 临期时会自动使用 refresh token 续期，并以临时文件同步后原子替换加密 session。同一槽位、同一账号主体的普通与隔离副本共同选出最新的一份 session 作为唯一 authority；即使两份缓存的 Keycloak 登录标识已经漂移，也只提交一次 refresh、一轮原生等价的 `enroll_device(false)` 检查和一次授权查询，再立即把 authority 的 token、access expiry 与写入时间收敛到其他闲置副本。若缓存中的设备 ID 已被服务端判定失效，该轮检查会按原生语义以空 ID 重试，但所有请求始终固定为 `kickout_other_sessions=false`。若官方登录事件返回新的设备身份，则按 SV2 原生语义同步该身份，同时逐份保留 `user_id` 之后的不透明扩展字段；不同槽位绝不跨写，同槽位若检测到不同账号主体则隔离该副本，不发第二轮预检也不静默覆盖。任一原子同步发生竞争或刷新响应无法验证时，整个账号槽位会在当前 Toolbox 进程内持续标记为待同步并从路由排除；session 瞬时缺失不会解除该隔离，只有后续显式预检完整成功并收敛副本后才会修复。成功会登记/续用本设备并原子保存返回的设备 ID，冲突只标记 Busy，绝不自动发送 `true` 或踢出其他会话。普通与隔离文件在物理上继续隔离，但账号卡只呈现一个合并后的账号结论；环境差异只用于选择可启动模式。本地安装目录不会进入账号授权模型，只有官方许可结果或用户明确确认的补充记录可作为授权。除清洗后的姓名/邮箱识别值外，解密密钥、JWT、明文 session 和完整响应只在 Rust 后端内存中处理，不进入日志、清单或前端；磁盘上只更新 SV2 自身的加密 session。智能路由只消费最近一次脱敏结果，没有缓存时保持未知并要求确认。

隔离内容可以细分控制。应用设置（`settings`）和声库数据（`databases`）各有一个全局默认开关；每个账户又可分别选择“跟随全局”“开启隔离”或“关闭隔离（共享）”，界面会显示解析后的实际状态。默认值保持两项都隔离，以兼容既有安全行为。关闭某项隔离时，工具箱只为对应目录写入该 box 的 Sandboxie `OpenFilePath` 直通规则；账号会话、WebView2、注册表和 IPC 仍然隔离。策略修改在下一次隔离启动时生效；共享目录可能被并发实例同时写入，应由用户自行评估工程环境与声库更新操作。

并发隔离是正式能力。本技术方案基于 Sandboxie 的进程树虚拟化实现，不是 Dreamtonics 原生多实例功能；第一次启动并发实例时，应用仍会明确提示这种多实例使用方式尚未被 Dreamtonics 官方承认，确认结果会保存到本地设置。工具箱不修改 SV2 二进制、不绕过账户限制，也不拦截官方联网验证；这不等于 Dreamtonics 已确认其符合全部账号政策或服务条款。当前入口只启动 SV2 standalone，不会把已经运行的 DAW 宿主或插件实例移入隔离空间。Sandboxie 启动参数固定为 `/box:<name>`，box 名称不添加 `#`。

截至当前版本，开发组没有收到因使用并发隔离而被官方警告或处理的记录，但 Dreamtonics 仍可能将其认定为不当或违规使用并采取措施。首次确认会说明：启用表示用户已知晓并自担风险，并在适用法律允许的最大范围内不追究 SynthV Toolbox 开发组的直接或连带责任。

普通切换检测到 SV2 standalone、WebView2 或已加载插件的宿主进程时，会显示包含进程名、PID 和原因的确认弹窗。用户可以取消、通过 Sandboxie 保留当前进程并以并发模式运行目标槽位，或明确选择“强制切换并启动”；强制模式会在 Rust 后端重新扫描 PID，以 `taskkill /PID <pid> /T /F` 结束列出的进程树，确认占用消失后才移动槽位目录。

本地兼容性冒烟测试已验证 Sandboxie Classic 5.73.2 可以在普通 SV2 2.2.1 已运行时启动第二个 SV2，并保持主窗口、WebView2 子进程树和网络连接正常。该结果只证明技术兼容性，不代表 Dreamtonics 对并发登录、设备计数或云同步策略的承诺。

## `.svp` 智能启动边界

智能启动是可关闭的候选文件处理器，不会注入、修改或劫持 Synthesizer V 进程。只有 Toolbox 已经运行时，它才会分析 `.svp` 中声明的声库，排除已确认忙碌或等待登录态恢复的槽位，并在普通与 Sandboxie 环境对应的最近一次预检证据中选择最优账号。最近一次无踢出登录事件已被官方服务接受且官方声库授权完整匹配时可自动启动；占用、会话或授权任一项未知时只给出候选并要求用户确认，不做模糊猜测。真正启动前会重新检查本机占用与脱敏缓存证据，但不会隐式刷新 JWT 或调用登录接口。

Toolbox 未运行时，或智能启动开关关闭时，`.svp` 会透传给启用功能前记录的原文件处理器，不进行账号路由。Windows 只把 SynthV Toolbox 注册为“打开方式”候选，不修改受系统保护的 `UserChoice`；用户必须在 Windows 默认应用设置中亲自确认由 Toolbox 处理 `.svp`，关闭功能也不会擅自改回系统默认项。

## 安全边界

- 纯工具箱模式不会暴露 AI/MCP 设置，也不会启动模型请求。
- 模型令牌仅写入当前用户的本机配置，不返回前端。
- 外部 MCP 只能由用户显式添加和启用；它可以启动本地进程，因此只应配置可信命令。
- MIDI、工程副本和 LRC 统一写入 `~/.SynthVcopilot/output/`，输出参数只接受文件名并拒绝路径穿透。
- A/B 片段只从用户选择的 SynthV standalone PID 及其子进程捕获，保存为 `~/.SynthVcopilot/output/ab-captures/` 下的单声道 PCM16 WAV 与 JSON 元数据；检测到音频数据中断或 Bridge Session 变化时拒绝结果。当前不捕获 DAW 内的 SynthV 插件。
- Bridge 安装器只写入用户指定的 SynthV `scripts` 目录。
- 远程组件只能进入串行下载队列；aria2 只获取公开 `pi-agent` 的固定提交，或官方 Sandboxie GitHub Release 中固定版本的 x64 安装包，Rust 后端在使用前逐文件复核 SHA-256，未知或未固定版本的组件会被拒绝。Sandboxie 仅下载到本机并打开所在位置，工具箱不会静默安装其内核驱动。
- 并发隔离只使用受支持版本的本机 Sandboxie Plus / Classic，拒绝未知 reparse point，不修改 SV2 二进制或官方校验流程；登录态恢复只回写同一槽位、SHA-256 校验通过且目标仍为空的短期快照，不做跨槽位或运行中合并。
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

Windows NSIS 产物是单个多语言安装包，内置简体中文与 English，并按系统语言预选、允许用户切换。检测到旧版本仍在运行时，交互式安装器会先询问用户，确认后才结束当前用户下的 Toolbox；静默安装无法取得确认时会中止。随后安装器静默移除旧程序文件并保留用户数据与快捷方式，再写入新版本。

推送符合语义版本的 tag 会自动发布，例如：

```bash
git tag v0.2.0
git push origin v0.2.0
```

tag 会注入 npm、Cargo 与 Tauri 包版本。两个平台均构建成功后，工作流会从上一个 tag 到当前 tag 汇总每一条 commit 作为“更新内容”，创建同名 GitHub Release，并附加 Windows 与 macOS 安装包。带后缀的 tag（如 `v0.2.0-beta.1`）会发布为 prerelease。

当前 CI 产物未进行 Apple Developer ID notarization 或 Windows 代码签名；正式分发前应在仓库 Secrets 中接入对应签名身份。

## License

[Apache-2.0](LICENSE)
