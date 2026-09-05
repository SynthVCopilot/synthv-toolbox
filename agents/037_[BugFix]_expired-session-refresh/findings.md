# 调研记录

- [过期后未刷新] -> 检索所有 access_expires_at 分支 -> inspect_active_session_license 直接返回 Expired；空闲流程已有 refresh_session_credentials，再写回并访问授权。
- [旧错误始终显示] -> 检查 finish_batch_results -> 旧 SyncFailed 隔离会覆盖新的刷新错误；需要保留内部状态同时展示本次真实失败。
- [HTTP 403 是否无法修复] -> 在相同机器、URL、表单、User-Agent 下比较不含真实令牌的请求 -> Windows curl 8.13 Schannel 得到 HTTP 400 JSON，PowerShell/.NET 得到 HTTP 403 HTML challenge。接口并非普遍不可达，需要定位客户端传输差异，不能只改错误文案。
- [现有 Rust 客户端是否实际被阻止] -> 编译独立 /test 诊断程序，以与生产锁文件相同的 ureq 2.12.1/rustls 0.23.43 发送原表单/headers，连续两轮对比 -> 现有默认 TLS 均为 400 JSON invalid_grant，native-tls 为 403 challenge。保留生产客户端；移除试验性的 native-tls 依赖。此前用 PowerShell 的 403 推断工具箱客户端无法续期不充分，必须用真实生产刷新链验证。
