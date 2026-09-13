# 进度记录

- 2026-09-12：确认采用全局、插件、manifest 三层授权模型。
- 2026-09-12：定位到协议、插件状态和 `host.capability.invoke` 的强制边界实现位置。
- 2026-09-12：新增 `host.internal` 与 `host.advanced`，插件状态默认关闭两项特权；宿主每次能力调用均重新验证安装清单、启用状态、全局开关和插件开关。
- 2026-09-12：账号槽位激活改为内部函数；高级功能提供并发沙箱 prepare/remove、凭据启停和受限公网 HTTPS GET。
- 2026-09-12：`cargo test --test plugin-manager` 通过（5 项）；协议和宿主边界 Node 测试通过。
