# 任务计划

- [x] 读取共享 runtime-protocol 源码，确认 wire schema 和协商语义。
- [x] 以 `kind`、`protocolVersion`、`ok` 和 `event` 字段重写 Rust 协议结构。
- [x] 在启动后发送 `host.hello` 并校验 Runtime 版本范围。
- [x] 增加入站 capability dispatcher 和通知订阅，确保不丢弃消息。
- [x] 添加双向 Node JSONL 测试、运行验证并提交。
