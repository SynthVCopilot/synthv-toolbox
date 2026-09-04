# 操作记录

- 已安全执行 OpenCode 授权列表与模型列表检查，未输出任何凭证内容。
- 已将测试模型固定为 `ollama-cloud/glm-5.2`。
- 待 HTTP MCP 实现合并后执行真实端到端任务。
- 已安装并启动最终应用，OpenCode 使用 `ollama-cloud/glm-5.2` 成功连接 Toolbox MCP、连接 Flat PID 97880、确认工程和赤羽 Plus，并排队组件。
- `media-fetcher` 已安装；`pi-audio` 与 `vocal-separation` 首次因 GUI PATH 未发现已安装的 Homebrew Python 3.11 而失败，正在修复自动发现并重试。
- 修复 Python 发现后两个失败任务原 ID 重试成功；GLM 随后暴露 Bilibili 无尾斜杠 412，已验证并固化 URL 规范化。
