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
  └─ App.Agent : DesktopAgentService  ── 进程内 ──▶  PiAgent.Core.PiAgentHost
                                                        ├─ AgentLoop (IAgentProvider)
                                                        ├─ SynthVBridge (MCP stdio → synthv-agent-bridge)
                                                        ├─ IConversationStore
                                                        └─ IComponentInstaller
```

桌面壳与 agent 的通信是**纯进程内方法调用 + 事件**，没有额外网络/IPC。
只有两类子进程由 pi-agent 内部管理：SynthV 桥 (`node dist/src/cli.js`) 与组件可执行文件 (ffmpeg 等)。

## submodule

```bash
git submodule update --init --recursive
```

`pi-agent` 位于 `external/pi-agent`，由 `src/PiDesktop/PiDesktop.csproj` 以 ProjectReference 引用。

## 构建

需要 **.NET 10 SDK** 与 **Windows App SDK / WinUI 3 工作负载**：

```bash
dotnet workload install # 首次：确保安装 Windows App SDK 相关组件（或用 Visual Studio 打开）
dotnet build src/PiDesktop/PiDesktop.csproj
```

未打包(unpackaged) 运行，`WindowsPackageType=None`、`WindowsAppSDKSelfContained=true`。

## 状态

骨架阶段：四个页面与进程内 agent 通道已就位，默认用占位回显后端 (`echo`)。
真实模型后端、桥连接测试、组件安装器与 Sound→MIDI 管线为后续填充。
