# 操作记录

- 已登记任务并确认现有 ProviderPool 的 OAuth 顺序故障转移和 API Key 单值存储边界。
- 新增 credential balancer、ApiKeyMetadata/AiApiKeySummary、多 key keyring 事务和 add/remove Tauri commands；移除单 key 兼容路径。
- ProviderPool 改为同一 provider+model 的 OAuth/API Key 混合候选轮转，保留 OAuth 刷新和模型资格过滤。
- `Cargo.toml` 注册根 `test/credential_balancer.rs`；执行 `cargo fmt --all`、`cargo check -q`、`cargo test -q`，结果 216 passed / 2 ignored，集成调度测试 2 passed。
- 已将 `AiProviderSummary` 从单一 `apiKeyConfigured` 改为 `apiKeys: AiApiKeySummary[]`，并同步预览 API 的新增、删除和模型资格。
- 已将三段式 API Key 详情改为标签+密钥新增表单和多凭据列表，显示模型数量、健康/冷却状态及逐项移除。
- 已更新 `add_ai_api_key(provider,label,apiKey)` 与 `remove_ai_api_key(provider,credentialId)` 调用，不回显密钥。
- 已更新 root `dual-auth-ui` 契约；`npm run build`、双认证和对话模型定向测试通过。
