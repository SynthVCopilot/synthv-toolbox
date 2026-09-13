# 技术调研

- 用户明确将风险选择交给全局与插件级高级功能授权，因此高级网络能力不再施加 URL、地址、重定向或响应体限制。
- 内部函数仍通过显式 capability/operation 暴露，避免形成任意 Rust 函数调用入口。
- 现有 `restricted_network_get` 在调用三层授权后执行，因此改为通用请求实现不会绕过 manifest、全局或插件独立的 `host.advanced` 授权。
- 文件系统能力沿用同一能力处理器，在分派操作前先要求 `host.advanced`，因此不需要以插件目录作为额外授权边界。
