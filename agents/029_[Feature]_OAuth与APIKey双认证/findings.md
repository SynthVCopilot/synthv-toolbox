# 调研与发现

- 当前 `OAuthAccountMetadata`、ProviderPool 和模型摘要仅表达 OAuth；Anthropic Provider 已具备 API Key 请求模式，但没有钥匙串录入路径。
- 现有 OpenAI Codex Provider 固定调用 ChatGPT 订阅端点并要求 account id，不能把 OpenAI Platform API Key 伪装成 Codex OAuth。
- OpenAI 官方 API 文档要求平台 API Key 使用 Bearer 认证，模型可通过 `/v1/models` 枚举，模型调用使用 Responses API；API Key 必须由后端钥匙串持有，不能回显到 renderer 或日志。
- UI 搜索输入在 dialog 的父级网格中未占满整行，导致用户截图中的右侧窄竖条。
- API Key 输入仅在提交事件内读取；提交前即清空 DOM 输入，再调用后端，因此不会因重渲染、预览状态或错误提示回显密钥。
- 模型可选性以当前选中的认证方式决定：OAuth 需要已授权账号，API Key 需要后端返回 `apiKeyConfigured`。
