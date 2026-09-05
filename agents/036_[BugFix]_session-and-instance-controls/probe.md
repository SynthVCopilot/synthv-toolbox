# 授权探测修复记录

- [x] 审查 `sv2_account_probe.rs` 与 `sv2_session_guard.rs` 的缓存、同步和原子替换路径。
- [x] 确认 SyncFailed 被槽位级无期 quarantine 覆盖：一次旧副本或写入竞争会持续遮蔽同一物理 session 的后续实际状态。
- [x] 添加 opt-in 只读诊断：解密后仅输出会话结构、过期布尔值、公开 issuer 和客户端匹配结果。
- [x] 用随机临时 fixture 验证生产持久化路径能替换、重读、解密并验证 session。
- [ ] 根据本机诊断区分端点拒绝、传输不确定和真实凭据轮换，再修改刷新处理。
