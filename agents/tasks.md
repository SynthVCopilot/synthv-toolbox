# Pi Desktop 任务追踪

> 准则版本: v0.2.2

## 任务列表

| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |
| :--: | :------: | :------: | :------: | :--: |
| 001 | [Refactor] shared-sv2-storage | 将槽位和隔离启动的可共享内容收敛到稳定数据源，缩短隔离路径，并提供保守的本地授权缓存摘要。 | 避免重复声库下载与路径过长，同时不把本地缓存视为官方授权。 | ✅ 已完成 |
| 002 | [Feature] macos-sequential-slots | 为 macOS 提供顺序切换的 SV2 数据槽位。 | 让 macOS 用户安全切换本地 SV2 环境。 | ✅ 已完成 |
| 003 | [Research] 作词与音频获取 | 评估完整作词、平台音频导入、下载组件、自我管理和内部工具边界，并产出实施指导。 | 把现有歌词与本地音频能力收敛为可验证的端到端创作工作流。 | ✅ 已完成 |
| 004 | [Feature] 歌词项目持久化 | 将浏览器歌词草稿升级为可创建、保存、列出和打开的本地歌曲项目。 | 为完整作词、版本管理、后续音频导入和工程联动建立稳定项目边界。 | ✅ 已完成 |
| 005 | [Feature] SynthV进程与快捷键控制 | 列出所有运行中的 SynthV 进程，读取默认 F13/F14 快捷键并主动触发 Bridge 连接。 | 减少手动启动 Bridge 的步骤，使 Agent 可在受控边界内发现并连接指定实例。 | ✅ 已完成 |
| 006 | [Feature] 媒体下载组件 | 将固定版本 yt-dlp 作为受管 media-fetcher 接入组件目录和串行下载队列。 | 为 BV/YouTube 元数据预览与音频导入提供可验证、可删除的本地运行时。 | ✅ 已完成 |
| 007 | [Feature] 平台音频导入 | 实现 BV/YouTube 元数据预览、权利确认、受管 WAV 下载和来源记录。 | 打通 URL 到后续人声/伴奏分离与 SVP Cover 的真实输入链。 | ✅ 已完成 |
| 008 | [Feature] 人声伴奏分离 | 将单个本地或平台导入音频分离为 vocals 与 inst，并输出受管结果。 | 为任意来源到 MIDI/SVP Cover 提供必要的双轨输入。 | ✅ 已完成 |
| 009 | [Feature] 组件任务自管理 | 持久化组件下载队列，支持取消排队任务与重试失败任务。 | 让下载组件可恢复、可审计并由用户或 Agent 主动管理。 | ✅ 已完成 |
| 010 | [Feature] 媒体长任务管理 | 为平台导入、分离和后续 Cover 提供持久化状态、取消与重试。 | 长流程可恢复并能真实终止整个子进程树。 | ✅ 已完成 |
| 011 | [Research] 指定声库桥接边界 | 审计并明确 Bridge 对歌手身份、voice 参数、Vocal Mode 与 Unison 的能力。 | 防止快捷 Cover 流程把参数写入误报为声库身份切换。 | ✅ 已完成 |
| 012 | [Feature] 一键 Cover 编排 | 从 BV/YouTube 来源自动导入、分离、提取旋律、映射歌词并写入 SynthV。 | 支持“从来源获取并用指定声库 cover”的快捷任务。 | ✅ 已完成 |
| 013 | [Feature] Edit与Solo模式 | 定义 AI 单次编辑与自主优化两种执行策略，并落实检查点和循环边界。 | 让全自动行为有明确、可验证的自主程度与恢复语义。 | ✅ 已完成 |
| 014 | [Feature] 分声库调声学习 | 从参考人声与 A/B 结果学习，并为每个声库维护独立调声参数档案。 | 让自动调校能够适配来源演唱和不同声库模型。 | ✅ 已完成 |
| 015 | [Feature] macOS进程音频捕获 | 使用 Core Audio Process Tap 为指定 SynthV PID 提供应用级音频捕获。 | 让 Solo 自动调声在 macOS 上也能执行真实双捕获闭环。 | ✅ 已完成 |
| 016 | [BugFix] 分离组件打包 | 将 vocal-separation 脚本与依赖清单纳入发布包并在 CI 校验。 | 修复源码可用但安装包缺少分离组件的发布态断链。 | ✅ 已完成 |
| 017 | [BugFix] 组件原生下载 | 使用 ureq 内置流式下载替换 aria2，覆盖媒体导入器、组件源码、Windows FFmpeg 与 Sandboxie。 | 修复发布包依赖外部 aria2c 导致的组件下载断链。 | ✅ 已完成 |
| 018 | [Feature] 统一SynthV宿主MCP | 将官方 SV1、Flat 与官方 SV2 收敛为内置 Agent 的标准宿主连接和创作工具。 | 隐藏连接协议、索引与能力差异，同时保留真实的不支持边界。 | ✅ 已完成 |
| 019 | [Refactor] bridge-formal-component | 将 SynthV Agent Bridge 从 Git 子模块迁入应用组件目录，并保持开发、构建与打包可用。 | 让该运行时随主仓库统一版本管理与发布。 | ✅ 已完成 |
| 020 | [Feature] Agent文件访问审批 | 为内置 Agent 提供标准文件枚举与两级审批策略。 | 音频/SynthV 工作文件应直接通过，其他文件在非 Solo 模式必须由人工批准。 | ✅ 已完成 |
| 021 | [BugFix] Flat连接回退 | 在 Flat 原生 MCP 缺失或不稳定时回退到兼容 Bridge。 | Windows Flat 可能不提供 MCP，连接不能依赖单一实验性后端。 | ✅ 已完成 |
| 022 | [BugFix] actions-build-fix | 修复正式 Bridge 组件裁剪后重复构建失败及后续 Rust lint 阻断。 | 当前 main 的 Windows 与 macOS Actions 都无法进入桌面打包阶段。 | ✅ 已完成 |
| 023 | [Feature] dev-build-artifacts | 将 main、PR 与手动验证的 Windows/macOS 开发安装包上传为 Actions artifact。 | 让未打 tag 的开发构建也可以直接下载和验收。 | ✅ 已完成 |
