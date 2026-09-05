# 调研与发现

- 当前 OpenCode 已登记 Ollama Cloud API 授权；凭证位于 OpenCode 自身凭证存储中，本任务不读取、复制或写入密钥。
- 完整生成任务执行时，OpenCode 列出的 Ollama Cloud GLM 最新版本为 `ollama-cloud/glm-5.2`；最终验收时目录已新增 `ollama-cloud/glm-5.3`，因此另用 5.3 通过 MCP 做了安装态只读验收。
- 本机未安装本地 `ollama` CLI，因此测试明确使用 OpenCode 的 Ollama Cloud provider，而不是假装存在本地 Ollama 服务。
- Synthesizer V Studio 2 Pro Flat 当前正在运行；仍需通过新 MCP 入口验证宿主枚举与连接状态。
- Flat 重启后原生 MCP 枚举到 91 个歌手，赤羽 Plus 的精确数据库名为 `MEDIUM5·Chiyu PLUS`、版本 100；目标工程已通过路径参数打开。
- GLM 首次安装组件时发现 GUI 应用只能解析 `/usr/bin/python3` 3.9，虽然 Homebrew Python 3.11 已安装在 `/opt/homebrew/bin/python3.11`；组件发现器需要主动探测标准 Homebrew 路径。
- 当前网络对无尾斜杠的 Bilibili `/video/BV…` 请求返回 412，但同一请求规范为 `/video/BV…/` 后，两个来源均由固定版本 media-fetcher 正常解析；无需读取浏览器 Cookie。
- Demucs 首次完成推理后因 torchaudio 2.7 没有可用保存后端而失败；安装 `soundfile` 后后端恢复，因此它必须进入受管分离组件的锁定依赖，不能依赖 Agent 临时 pip 修改。
- 已打包的 `pi-audio` 已包含 `source-style`，但默认安装仍从旧固定远程 revision 取源码，造成运行态命令缺失；改为从同版本应用包安装可消除双版本维护和源码漂移。
- Cover 一体化流程只接受平台 URL，无法消费已由 Agent 成功下载的受管 WAV；增加仅允许 `~/.SynthVcopilot` 普通音频的本地 Cover 工具，作为平台限流后的安全续跑入口。
- Flat 在声库文件安装后仍可能未把 singer 注册进当前运行时；Cover 的精确指派失败时应主动发送 F5 刷新并只重试一次，失败则保留检查点和真实错误。
- 实测 `part.assign_singer` 可成功指派已注册的 Mai，但赤羽 Plus 在重启与 F5 后仍返回未注册；歌手注册失败应成为非致命结构化结果，不能阻止已经提取出的音符写入和工程保存。
- 完整 320 秒参考音频的 pyin 分析约需 3 分钟，超过 OpenCode MCP 工具超时；使用中段 45 秒代表窗口后保留原始总时长并在 14 秒内输出同一九字段契约。
- 超时解决后发现 Python 输出仍为 snake_case，而 Rust `SourceStyleFeatures` 使用 camelCase；统一组件输出字段后才能真正写入调校档案。
- 最终 Cover 任务完成并通过快捷键保存验证：生成 375 个音符，高置信度分数 0.787，工程与 MIDI、分离人声、伴奏和检查点均已落盘。
- 赤羽 Plus 虽出现在 Flat 歌手枚举和本地声库目录中，当前 Flat 运行时仍拒绝注册版本 100；工程保留乐谱并将 `assigned=false`、`requiresHostRegistration=true` 作为真实结果。
- 参考音频已成功形成赤羽 Plus 独立调校档案，但 Flat 的公开能力为 `voiceParameters.write=false`，因此该档案不能在 Flat 中自动写入；官方 SV2 Bridge 仍是参数写入宿主。
