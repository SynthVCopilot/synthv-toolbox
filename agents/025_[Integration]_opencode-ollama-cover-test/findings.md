# 调研与发现

- 当前 OpenCode 已登记 Ollama Cloud API 授权；凭证位于 OpenCode 自身凭证存储中，本任务不读取、复制或写入密钥。
- `opencode models` 当前列出的 Ollama Cloud GLM 最新版本为 `ollama-cloud/glm-5.2`。
- 本机未安装本地 `ollama` CLI，因此测试明确使用 OpenCode 的 Ollama Cloud provider，而不是假装存在本地 Ollama 服务。
- Synthesizer V Studio 2 Pro Flat 当前正在运行；仍需通过新 MCP 入口验证宿主枚举与连接状态。
- Flat 重启后原生 MCP 枚举到 91 个歌手，赤羽 Plus 的精确数据库名为 `MEDIUM5·Chiyu PLUS`、版本 100；目标工程已通过路径参数打开。
- GLM 首次安装组件时发现 GUI 应用只能解析 `/usr/bin/python3` 3.9，虽然 Homebrew Python 3.11 已安装在 `/opt/homebrew/bin/python3.11`；组件发现器需要主动探测标准 Homebrew 路径。
- 当前网络对无尾斜杠的 Bilibili `/video/BV…` 请求返回 412，但同一请求规范为 `/video/BV…/` 后，两个来源均由固定版本 media-fetcher 正常解析；无需读取浏览器 Cookie。
