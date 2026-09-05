# 调研与发现

- 当前 `opencode_catalog.rs` 会读取 `https://models.dev/api.json` 并缓存 15 分钟，但结果只通过 `opencode_provider_catalog` 命令暴露；模型连接向导实际读取 `model_summary()` 中的静态 `AiProviderId::model_options()`。
- 运行时协议仍只能限于已实现的 Anthropic、OpenAI/Codex、WorkBuddy 与 TraeCode；models.dev 只能提供展示与模型目录，不能把任意目录提供商自动提升为可执行适配器。
- 审计发现目录模型按发布日期排序后使用相邻去重，重复 ID 若被不同发布日期的模型隔开会保留多次；改为稳定的全局 ID 去重。
- 运行时 models.dev 目录不再插入未被目录筛选接受的内置默认模型，避免将回退 ID 标记为 models.dev 来源。
- `sync_route` 保留已有健康状态；另补上永久失败状态对迟到瞬态失败的保护，只有显式 `upsert` 才会重置健康状态。
- 缓存刷新失败时会继续返回上次目录并附带错误状态；无缓存时使用内置回退。此审计没有请求线上 models.dev。
