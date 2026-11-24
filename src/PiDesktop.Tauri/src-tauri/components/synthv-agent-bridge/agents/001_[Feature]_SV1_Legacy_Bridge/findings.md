# 调研记录

- [SV1 版本门槛] -> `SV.hostVersionNumber` 以主、次、修订版的两位十六进制编码 -> 1.11.2 为 `0x010B02`，即 `68354`。
- [API 边界] -> SV1 有项目、轨道、Group、Note 与 PlaybackControl 基础 API -> 不使用 SV2 Retake、computed 或 singer identity API。
- [隔离] -> 现有运行时公开面固定为六个、协议边界为 1-based -> 新实现位于 `legacy-sv1/`，使用独立命名空间与 zero-based 外部索引。
- [Lua 静态检查] -> 当前 worktree 未安装 `luac5.4` -> TypeScript 编译和 mock IPC 契约已可运行，真实 SV1 Lua 加载仍需在 1.11.2 内验证。
- [审查复核] -> 官方文档确认 `SV:getArrangement():getSelection()`、TimeAxis 的 `getAllTempoMarks/getAllMeasureMarks`、Playback seek 和 `NoteGroupReference:setTimeOffset` -> 可在 SV1 基线中使用；SV2-only `setTimeRange` 继续禁用。
- [Mock host] -> Homebrew 安装 Lua 后，独立 mock 实际加载并执行 SV1 Lua executor -> 覆盖 IPC 请求、零基索引、Undo、最后轨道拒绝、重排索引和每秒 heartbeat。
