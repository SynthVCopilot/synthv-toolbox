# 发现

- [共享协议] -> `packages/runtime-protocol/src/index.ts` -> 所有消息使用 `kind` 和 `protocolVersion`；响应通过 `ok/result/error` 区分，通知使用 `event`。
- [协商] -> Host 和 Runtime 都声明 `VersionRange` -> 交集不存在时必须拒绝启动，当前固定版本为 `1.0`。
- [入站消息] -> 旧 reader 仅匹配响应 -> Runtime 请求和通知会静默被忽略，必须改为分派或显式反馈。
