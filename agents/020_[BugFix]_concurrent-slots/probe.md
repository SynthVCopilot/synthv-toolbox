# 会话探测记录

- 单权威根之前，批处理会要求普通和并发副本都存在；缺少任一副本会写入 slot 级 `SyncFailed`，并以 `Duration::MAX` 缓存。
- 当前 profiles 每 slot 只选择一个 authority。运行中该请求会带 `source_in_use=true`，批处理直接返回 `InUse`，不会读取已有授权缓存；这解释了运行中始终没有授权结果。
- 修复后，运行中不解密、刷新或写回会话；仅按 session 指纹读取尚未过期的本地授权缓存。缓存缺失或已过期仍明确返回 `InUse` 和未知授权。
- 同一 canonical 根的逻辑别名只保留一个批处理 authority，结果会回填到别名缓存，不建立 `SyncFailed` 隔离。
- 验证：根目录 Node 契约测试通过。Rust 构建需要先生成 bridge dist，随后执行 crate 检查。
- 运行中首次探测改为稳定共享读、解密本地会话后只读授权接口；不刷新、写回或 enroll。返回前重新核对指纹，变化即丢弃结果。
