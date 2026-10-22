# Toneshuttle 声梭

Toneshuttle（声梭）是面向人声与音频创作的通用桌面工具箱，支持 Windows 和 macOS。它把音频准备、分析、音频转 MIDI、歌词处理和 AI Agent 集中在一个应用中，并通过本地 MCP 服务器和插件系统与其他工具协作。Synthesizer V 支持作为可选集成提供。

本项目原名 Synthesizer V Toolbox。升级到 Toneshuttle 时，可执行文件、安装目录和数据目录会一并改为 Toneshuttle，设置、账号、插件和开机自启动自动迁移，应用内更新继续可用。

## 主要功能

- 音频准备：导入和整理素材，分离人声与伴奏
- 音频分析：节奏、调性和整体特征
- 音频转 MIDI：从演唱音频生成 MIDI，并保留歌词和标记信息
- 歌词工作区：写词、识别、校对和导出歌词
- 导入、检查和整理 MIDI 与 MusicXML 文件，导出结果写入独立位置
- AI Agent：启用并配置模型账号后协助完成创作流程，需要确认的操作由用户批准
- 本地 MCP 服务器：让 Claude Code、Codex、Cursor 等外部客户端调用工具箱能力
- 插件系统：通过插件扩展工具和界面

## Synthesizer V 集成（可选）

面向 Synthesizer V 用户的可选集成，可在「设置 > 集成」中关闭；关闭后上述通用功能不受影响。

- Bridge：连接 SynthV Bridge，在当前工程中继续处理结果；通过统一 Agent 接口连接官方 SV1、Flat 或官方 SV2，隐藏底层 Bridge/MCP 差异
- SV2 账号槽位：Windows 和 macOS 都提供可选的 SV2 本地数据槽位，可在 SV2 完全退出后顺序切换并启动。Windows 还提供工程智能启动和可选的并发隔离辅助功能。同账号可在普通或隔离环境启动多个进程，共用该账号槽位的数据；声库按账号独立保存，默认跨账号仅同步设置和脚本等内容。账号页可按窗口标题和 PID 查看实例及账号关联
- .svp 工具：导入、检查和整理 SynthV 工程文件，导出歌词与工程副本，方便校对和备份

所有账号相关功能均不会修改 Synthesizer V 程序，并始终由用户主动启用和确认。

## 连接 MCP 客户端

在「连接」页开启 MCP 工具接口后，Toneshuttle 在本机提供 `http://127.0.0.1:17831/mcp`（默认端口）。每个请求都需要携带 Bearer 令牌，令牌显示在「连接」页；该页还可为 Claude Code、Codex 和 Cursor / VS Code 生成可直接粘贴的客户端配置。

## 使用原则

- 基础工具可独立使用；AI 功能仅在用户启用后运行。
- 外部工具、插件和账号相关功能均需由用户主动配置或确认。
- 工程处理会保留原文件，导出结果写入独立位置。
- 使用任何第三方服务时，请遵守其适用的服务条款与账号政策。

## Trademark and affiliation

*Toneshuttle is not affiliated with or endorsed by Dreamtonics.*

“Synthesizer V” is a trademark of Dreamtonics and is used only to identify compatible software.

## 开发与发布

构建、测试和发布说明请参阅项目内的开发文档与工作流配置。发布版本请从项目的 GitHub Releases 页面获取。发布与 macOS 签名流程见 [发布流程](docs/release-process.md)。

作词、平台音频导入、下载组件和内部工具的评估与操作指导请参阅 [作词与音频导入工作流指导](docs/lyric-and-audio-workflow-guide.zh-CN.md)。

官方 SV1、Flat 与官方 SV2 的统一 Agent 连接、能力和导出流程请参阅 [统一 SynthV 宿主接口](docs/unified-synthv-hosts.zh-CN.md)。

## License

[Apache-2.0](LICENSE)

使用 Toneshuttle 前，请阅读[使用条款](src/PiDesktop.Tauri/electron/assets/TERMS-OF-USE.txt)。该条款独立于 Apache-2.0 许可证。
