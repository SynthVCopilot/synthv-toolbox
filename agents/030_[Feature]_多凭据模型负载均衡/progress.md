# 操作记录

- 已登记任务并确认现有 ProviderPool 的 OAuth 顺序故障转移和 API Key 单值存储边界。
- 新增 credential balancer、ApiKeyMetadata/AiApiKeySummary、多 key keyring 事务和 add/remove Tauri commands；移除单 key 兼容路径。
- ProviderPool 改为同一 provider+model 的 OAuth/API Key 混合候选轮转，保留 OAuth 刷新和模型资格过滤。
- `Cargo.toml` 注册根 `test/credential_balancer.rs`；执行 `cargo fmt --all`、`cargo check -q`、`cargo test -q`，结果 216 passed / 2 ignored，集成调度测试 2 passed。
