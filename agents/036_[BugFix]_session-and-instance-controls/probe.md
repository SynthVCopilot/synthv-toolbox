# 授权探测修复记录

- [x] 审查 `sv2_account_probe.rs` 与 `sv2_session_guard.rs` 的缓存、同步和原子替换路径。
- [x] 确认 SyncFailed 被槽位级无期 quarantine 覆盖：一次旧副本或写入竞争会持续遮蔽同一物理 session 的后续实际状态。
- [x] 添加 opt-in 只读诊断：解密后仅输出会话结构、过期布尔值、公开 issuer 和客户端匹配结果。
- [x] 用随机临时 fixture 验证生产持久化路径能替换、重读、解密并验证 session。
- [x] 本机只读授权检查确认未过期会话能返回授权且前后文件未变化；会话 `azp` 与旧硬编码 client id 不同。
- [x] 未过期 access token 仅执行授权 GET；受信 issuer 的 `azp` 用于过期会话刷新。HTTP 403/429/5xx 记录为端点不可用，不进入 rotation quarantine。
