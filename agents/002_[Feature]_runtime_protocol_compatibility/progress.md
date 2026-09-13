# 操作记录

- 读取共享 TypeScript 协议源码以及当前 Rust 运行时实现和集成测试。
- 将 Rust 消息类型改为共享 wire schema，添加 `HostHello`、`RuntimeHello` 和数值版本范围校验。
- `start` 在子进程建立后发送 `host.hello`，协商失败会停止子进程。
- 注册 capability handler 后，Runtime 的请求会得到成功或结构化失败响应；通知经 broadcast receiver 对外暴露。
- Node 集成测试覆盖 hello、双向请求响应、通知和不兼容版本拒绝；协议序列化单测通过。
- 再次执行格式化、集成测试和协议单测，全部通过。
