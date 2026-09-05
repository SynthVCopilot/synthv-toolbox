# 调研记录

- [过期后未刷新] -> 检索所有 access_expires_at 分支 -> inspect_active_session_license 直接返回 Expired；空闲流程已有 refresh_session_credentials，再写回并访问授权。
- [旧错误始终显示] -> 检查 finish_batch_results -> 旧 SyncFailed 隔离会覆盖新的刷新错误；需要保留内部状态同时展示本次真实失败。
