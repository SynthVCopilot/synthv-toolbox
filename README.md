# pi-desktop

> SynthVCopilot 的 **WinUI 3 桌面应用**（C# / .NET 10）。提供 GUI 对话与历史、
> 配置 agent、安装各组件的能力。以 git submodule 引用
> [`pi-agent`](https://github.com/SynthVCopilot/pi-agent)，在**同进程内**驱动 agent。

## 功能

| 页面 | 能力 |
|---|---|
| 对话 | 与 Pi Agent 的 GUI 对话；音频写入请求引导到“音频准备”页确认 |
| 音频准备 | 选择/拖入本地文件、格式检测、PCM WAV 准备、响度测量与确认后标准化、前后试听、打开位置/复制路径/另存为 |
| 历史 | 会话历史列表（`IConversationStore`） |
| 配置 Agent | 选模型后端、指向 synthv-agent-bridge 仓库、测试 `sv_status` |
| 组件 | 安装、更新、卸载 Pi Desktop 私有 FFmpeg；显示系统/显式配置来源，其他组件明确标为计划中 |

## 架构

```
MainWindow (NavigationView)
  ├─ ChatPage / AudioPreparationPage / HistoryPage / AgentConfigPage / ComponentsPage
  ├─ App.Ffmpeg : FfmpegService ── P/Invoke（后台任务/轮询/取消）──┐
  └─ App.Agent  : DesktopAgentService ── P/Invoke ───────────────▶ pi_agent.dll (Rust, v3)
                                                        ├─ pi-agent-core  (agent 循环/历史/组件)
                                                        ├─ pi-agent-mcp   (MCP stdio → synthv-agent-bridge)
                                                        └─ pi-agent-ffi   (C-ABI)
```

桌面壳与 agent 的通信是**进程内 P/Invoke 直调**（不起 sidecar），满足「原生 WinUI 3 内部通信」。
只有两类子进程由 pi-agent 内部管理：SynthV 桥 (`node dist/src/cli.js`) 与组件可执行文件 (ffmpeg 等)。

FFmpeg 的 Agent 工具面只保留只读的 `ffmpeg_probe` 与 `ffmpeg_loudness_analyze`。
生成 PCM WAV 与响度标准化只通过 Desktop 的直接 C ABI 路径执行，并在写入前显示输入、参数和输出位置供用户确认。
输出保存在 `~/.SynthVcopilot/output/ffmpeg`，不会覆盖源文件，也不会自动导入 SynthV；用户可试听、打开位置、复制路径或另存为。
默认响度目标 `-16 LUFS / -1.5 dBTP / 11 LRA` 是通用试听预设，不是 SynthV 强制标准。

## submodule

```bash
git submodule update --init --recursive
```

`pi-agent` 位于 `external/pi-agent`，由 `src/PiDesktop/PiDesktop.csproj` 的构建目标调用 Cargo，
并把对应架构的 `pi_agent.dll` 复制到 Desktop 输出目录。

## 构建

需要 **.NET 10 SDK** + **Windows App SDK / WinUI 3 工作负载** +
**Visual Studio 2022 C++ Build Tools（MSVC linker 与 Windows SDK）** + **Rust 工具链 (cargo)**
（csproj 的 `BuildPiAgentDll` target 会自动 `cargo build --release -p pi-agent-ffi` 并把
`pi_agent.dll` 拷进输出目录）：

```bash
git submodule update --init --recursive
dotnet build src/PiDesktop/PiDesktop.csproj -p:Platform=x64
# ARM64 machine / output:
rustup target add aarch64-pc-windows-msvc
dotnet build src/PiDesktop/PiDesktop.csproj -p:Platform=ARM64
```

`BuildPiAgentDll` compiles the matching Rust target explicitly: x64 uses
`x86_64-pc-windows-msvc`, and ARM64 uses `aarch64-pc-windows-msvc`. The native
DLL is copied from that target's `release` directory, so an ARM64 package never
accidentally carries an x64 `pi_agent.dll`. The non-GUI ABI smoke test is:

```bash
dotnet run --project tools/PiAgentSmoke/PiAgentSmoke.csproj -p:Platform=x64
```

It validates the static component catalog, dynamic FFmpeg status JSON, and—if
a healthy system FFmpeg/ffprobe pair is already available on PATH—a local probe
job through polling and deterministic job-handle disposal. It never downloads
or installs FFmpeg.

未打包(unpackaged) 运行，`WindowsPackageType=None`、`WindowsAppSDKSelfContained=true`。

## 当前边界

- 保持现有 `pi-agent → synthv-agent-bridge → SynthV` 实时音符写入链路；音频辅助页不修改 Bridge 协议或 SynthV 工程。
- V1 一次处理一个本地文件，不做批处理、任意 FFmpeg 参数、自动 CVRS 或自动 SynthV 音频导入。
- 默认仍可使用占位回显后端 (`echo`)；真实模型后端和后续音频模型组件不由本次 FFmpeg 辅助功能实现。
