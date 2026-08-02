# pi-desktop

> SynthVCopilot 的 **WinUI 3 桌面应用**（C# / .NET 10）。提供 GUI 对话与历史、
> 配置 agent、安装各组件的能力。以 git submodule 引用
> [`pi-agent`](https://github.com/SynthVCopilot/pi-agent)，在**同进程内**驱动 agent。

## 功能

| 页面 | 能力 |
|---|---|
| 对话 | 与 Pi Agent 的 GUI 对话 |
| 历史 | 会话历史列表（`IConversationStore`） |
| 配置 Agent | 选模型后端、指向 synthv-agent-bridge 仓库、测试 `sv_status` |
| 组件 | 安装 ffmpeg、本地 whisper、游戏音高识别模型、Sound→(含词)MIDI，及直接导入 MIDI/MusicXML |

## 架构

```
MainWindow (NavigationView)
  ├─ ChatPage / HistoryPage / AgentConfigPage / ComponentsPage
  └─ App.Agent : DesktopAgentService ── P/Invoke ──▶ pi_agent.dll (Rust, v3)
                                                        ├─ pi-agent-core  (agent 循环/历史/组件)
                                                        ├─ pi-agent-mcp   (MCP stdio → synthv-agent-bridge)
                                                        └─ pi-agent-ffi   (C-ABI)
```

桌面壳与 agent 的通信是**进程内 P/Invoke 直调**（不起 sidecar），满足「原生 WinUI 3 内部通信」。
只有两类子进程由 pi-agent 内部管理：SynthV 桥 (`node dist/src/cli.js`) 与组件可执行文件 (ffmpeg 等)。

## submodule

```bash
git submodule update --init --recursive
```

`pi-agent` 位于 `external/pi-agent`，由 `src/PiDesktop/PiDesktop.csproj` 以 ProjectReference 引用。

## 构建

需要 **.NET 10 SDK** + **Windows App SDK / WinUI 3 工作负载** + **Rust 工具链 (cargo)**
（csproj 的 `BuildPiAgentDll` target 会自动 `cargo build --release -p pi-agent-ffi` 并把
`pi_agent.dll` 拷进输出目录）：

```bash
git submodule update --init --recursive
dotnet build src/PiDesktop/PiDesktop.csproj
```

未打包(unpackaged) 运行，`WindowsPackageType=None`、`WindowsAppSDKSelfContained=true`。

## 状态

骨架阶段：四个页面与进程内 agent 通道已就位，默认用占位回显后端 (`echo`)。
真实模型后端、桥连接测试、组件安装器与 Sound→MIDI 管线为后续填充。
