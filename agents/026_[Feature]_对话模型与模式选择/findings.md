# 调研与发现

- 当前后端只支持 `anthropic` 与 `openai-codex` 两种可执行 Agent 提供商；models.dev 的 OpenCode 目录仅是发现信息，不能把任意目录项伪装成已实现的运行时。
- 设置页使用可展开供应商卡片和原生模型下拉框；用户要求改为弹窗内搜索、列表点击选择供应商。
- Edit/Solo 已由 `set_agent_work_mode` 持久化并在每轮消息前注入系统策略，移动入口不需要修改后端执行语义。
- 对话页顶部目前只有静态 AI 标记，适合承载当前供应商、模型与 Edit/Solo 选择入口。
- 提供商弹窗仅从 `aiProviderState` 的运行时提供商摘要生成；已移除设置页对 OpenCode/models.dev 目录的展示和选择入口，目录内容不会影响可执行提供商集合。
- 模型、浏览器授权和账号移除仍调用既有 Rust API；前端不读取或保存 OAuth 凭据。
