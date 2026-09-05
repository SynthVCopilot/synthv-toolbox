# 调研记录

- [过期后未刷新] -> 检索所有 access_expires_at 分支 -> inspect_active_session_license 直接返回 Expired；空闲流程已有 refresh_session_credentials，再写回并访问授权。
- [旧错误始终显示] -> 检查 finish_batch_results -> 旧 SyncFailed 隔离会覆盖新的刷新错误；需要保留内部状态同时展示本次真实失败。
- [HTTP 403 是否无法修复] -> 在相同机器、URL、表单、User-Agent 下比较不含真实令牌的请求 -> Windows curl 8.13 Schannel 得到 HTTP 400 JSON，PowerShell/.NET 得到 HTTP 403 HTML challenge。接口并非普遍不可达，需要定位客户端传输差异，不能只改错误文案。
- [现有 Rust 客户端是否实际被阻止] -> 编译独立 /test 诊断程序，以与生产锁文件相同的 ureq 2.12.1/rustls 0.23.43 发送原表单/headers，连续两轮对比 -> 现有默认 TLS 均为 400 JSON invalid_grant，native-tls 为 403 challenge。保留生产客户端；移除试验性的 native-tls 依赖。此前用 PowerShell 的 403 推断工具箱客户端无法续期不充分，必须用真实生产刷新链验证。
- [真实过期会话续期] -> 对三个明确的单份槽位分别运行 opt-in 生产活动分支，最初均要求 access 已过期 -> 三个槽位均 refreshed=true、refresh token 已轮换且加密写回、账号主体一致；随后分别读到 5、5、61 个授权。未注册设备/踢出会话，未输出令牌。诊断期间没有运行中的 SynthV 编辑器，该实验覆盖活动代码分支，未声称模拟了原生客户端同时写入的竞争。
- [子任务验证不足] -> 复核初步提交 -> 布尔判定测试未验证调用顺序，后续错误缓存提交会将非 SyncFailed 传入 quarantine 而触发断言。主工作区接管共享生命周期 helper 和流程测试，子任务负责纠正错误缓存与隔离结果。
- [最新失败几秒后被旧结果覆盖] -> 检查 Offline 三秒 TTL -> 对仍有隔离的槽位保留当前失败至再次预检，并让新隔离移除更早缓存；用推进缓存时间的测试验证，不实际等待。
- [403 导致无谓续期] -> 查阅 https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1 -> 401 表示 bearer token 认证失败，403 可表示权限不足；普通 403/429/5xx 不触发续期，明确重新登录错误除外。
- [隔离测试项目 all-targets Clippy] -> 运行后命中既有 sandboxie_smoke.rs 两处 unnecessary_to_owned -> 与此次修改无关，未修改该文件；实际生产 crate 的 all-targets Clippy 全部通过。
