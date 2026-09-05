# SynthV Toolbox

SynthV Toolbox 是面向 Synthesizer V 创作流程的桌面工具箱，支持 Windows 和 macOS。它把常用的音频、MIDI、工程文件和 Bridge 工具集中在一个应用中；需要时也可启用 AI 辅助功能。

## 主要功能

- 将演唱音频转换为 MIDI 或 SynthV 可用素材
- 分析音频的节奏、调性和整体特征
- 导入、检查和整理 MIDI、MusicXML 与 SynthV 工程文件
- 导出歌词与工程副本，方便校对和备份
- 连接 SynthV Bridge，在当前工程中继续处理结果
- 通过统一 Agent 接口连接官方 SV1、Flat 或官方 SV2，隐藏底层 Bridge/MCP 差异
- 通过 Copilot 与用户配置的工具协助完成创作流程

## 平台支持

音频、MIDI、工程文件、Bridge 与 Copilot 工作流支持 Windows 和 macOS。

Windows 和 macOS 都提供可选的 SV2 本地数据槽位，可在 SV2 完全退出后顺序切换并启动。Windows 还提供工程智能启动和可选的并发隔离辅助功能。 同账号可启动多个并发实例，共用该账号槽位的数据；声库按账号独立保存，默认跨账号仅同步设置和脚本等内容。账号页可按窗口标题和 PID 查看实例及账号关联。所有账号相关功能均不会修改 Synthesizer V 程序，并始终由用户主动启用和确认。

## 使用原则

- 基础工具可独立使用；AI 功能仅在用户启用后运行。
- 外部工具和账号相关功能均需由用户主动配置或确认。
- 工程处理会保留原文件，导出结果写入独立位置。
- 使用任何第三方服务时，请遵守其适用的服务条款与账号政策。

## 开发与发布

构建、测试和发布说明请参阅项目内的开发文档与工作流配置。发布版本请从项目的 GitHub Releases 页面获取。

作词、平台音频导入、下载组件和内部工具的评估与操作指导请参阅 [作词与音频导入工作流指导](docs/lyric-and-audio-workflow-guide.zh-CN.md)。

官方 SV1、Flat 与官方 SV2 的统一 Agent 连接、能力和导出流程请参阅 [统一 SynthV 宿主接口](docs/unified-synthv-hosts.zh-CN.md)。

## License

[Apache-2.0](LICENSE)
