# 调研与发现

- 当前 `OAuthAccountMetadata`、ProviderPool 和模型摘要仅表达 OAuth；Anthropic Provider 已具备 API Key 请求模式，但没有钥匙串录入路径。
- 现有 OpenAI Codex Provider 固定调用 ChatGPT 订阅端点并要求 account id，不能把 OpenAI Platform API Key 伪装成 Codex OAuth。
- OpenAI 官方 API 文档要求平台 API Key 使用 Bearer 认证，模型可通过 `/v1/models` 枚举，模型调用使用 Responses API；API Key 必须由后端钥匙串持有，不能回显到 renderer 或日志。
- UI 搜索输入在 dialog 的父级网格中未占满整行，导致用户截图中的右侧窄竖条。
- API Key 输入仅在提交事件内读取；提交前即清空 DOM 输入，再调用后端，因此不会因重渲染、预览状态或错误提示回显密钥。
- 模型可选性以当前选中的认证方式决定：OAuth 需要已授权账号，API Key 需要后端返回 `apiKeyConfigured`。
- API Key 不可复用 OAuth 凭据服务：使用独立 `com.synthvcopilot.toolbox.api-key` 服务，并在设置写入失败时恢复原钥匙串值，防止界面状态与真实凭据不一致。
- OpenAI Platform API Key 的运行时使用 `https://api.openai.com/v1/responses`、Bearer header 且不发送 ChatGPT account id；OAuth 仍维持既有 Codex subscription endpoint 与 header。
- 三段式认证 UI 需要同时读取 OAuth 与 API Key 两套目录；单一 `models` 字段会随全局认证状态切换而丢失另一条目录，因此摘要改为 `oauthModels` 与 `apiKeyModels`。
- 安装态供应商标签不能写死为官方订阅，否则 API Key 页面会产生错误暗示；统一为 `Claude / Anthropic` 与 `OpenAI / Codex`，描述同时列出 OAuth 和 API Key。
- 三段式状态机将认证方式、提供商列表和详情分离，避免用户在未选择认证方式时看到不匹配的模型或配置。
- 后端契约已稳定为 `oauthModels` 与 `apiKeyModels`；详情页只读取当前认证方式的目录，并在该方式未就绪时隐藏模型列表。
