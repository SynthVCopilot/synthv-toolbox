# 操作记录

- 已安全执行 OpenCode 授权列表与模型列表检查，未输出任何凭证内容。
- 已将测试模型固定为 `ollama-cloud/glm-5.2`。
- 待 HTTP MCP 实现合并后执行真实端到端任务。
- 已安装并启动最终应用，OpenCode 使用 `ollama-cloud/glm-5.2` 成功连接 Toolbox MCP、连接 Flat PID 97880、确认工程和赤羽 Plus，并排队组件。
- `media-fetcher` 已安装；`pi-audio` 与 `vocal-separation` 首次因 GUI PATH 未发现已安装的 Homebrew Python 3.11 而失败，正在修复自动发现并重试。
- 修复 Python 发现后两个失败任务原 ID 重试成功；GLM 随后暴露 Bilibili 无尾斜杠 412，已验证并固化 URL 规范化。
- 参考音频已成功导入；首次 Demucs 分离暴露缺少 soundfile 后端，GLM 已在当前受管 venv 补装并重试，源码依赖清单同步锁定该包。
- 参考分离已完成；运行态旧 pi-audio 缺失 `source-style`，且目标平台一体化 Cover 受 412 影响，正在以同版本包内组件源码和受管本地音频 Cover 入口完成修复。
- 完整参考 vocals 已用包内 `source-style` 实测输出九项特征；目标 Cover 到 90% 后因 Flat singer 未注册失败，已加入 F5 自动刷新与一次重试，并保留两个原始检查点。
- 已用全新 Flat 进程和 F5 复核：Mai 可指派、赤羽 Plus 仍未注册；调整 Cover 在该边界下继续写谱并返回 `requiresHostRegistration`，不再丢失整条任务。
- `learn_tuning_from_source` 两次被 OpenCode 的单次 MCP 超时取消；已将长音频风格分析限制为中段 45 秒窗口，真实参考 vocals 从约 3 分钟降至 14 秒。
