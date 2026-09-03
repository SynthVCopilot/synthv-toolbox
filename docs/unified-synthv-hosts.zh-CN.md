# 统一 SynthV 宿主接口

SynthV Toolbox 将官方 Synthesizer V Studio Pro、Synthesizer V Flat 和官方 Synthesizer V Studio 2 Pro 收敛为同一套内置 Agent 工具。Agent 不需要判断底层使用脚本 Bridge 还是本机 MCP，也不会看到宿主的原始工具列表。

## 标准工具

| 工具 | 用途 |
| --- | --- |
| `synthv_hosts` | 列出所有已安装或正在运行的宿主实例及 PID |
| `synthv_connect` | 连接指定 `hostId` |
| `synthv_disconnect` | 断开指定宿主，不修改工程 |
| `synthv_capabilities` | 返回宿主真实支持的标准读取和写入操作 |
| `synthv_read` | 读取工程、时间轴、播放、轨道、Part、音符、声音或歌手信息 |
| `synthv_write` | 执行标准工程写入 |
| `synthv_export` | 导出宿主中立的 JSON 工程快照 |

所有索引在标准接口中都从零开始，音符和时间轴位置使用 SynthV 原生 blick；只有 `transport.seek` 使用秒。标准结果统一使用 `Part`、`partIndex`、`parts`、`measureMarks` 和 `playheadSeconds`。

## 自动连接

Agent 先调用 `synthv_hosts`。只有一个已连接宿主时，后续读写可省略 `hostId`；存在多个连接时必须明确选择。

- 官方 SV1 和 SV2：Toolbox 聚焦对应 PID，默认发送 F13 启动或重连 Bridge；断开时发送 F14。原始快捷键和 Bridge 工具不会进入 Agent 工具表。
- Flat：Toolbox 只连接 Flat 声明的 `127.0.0.1` 本机 MCP 端点，不加载 Lua Bridge，也不发送 F13/F14。
- 官方 SV1 首次安装兼容扩展后需要宿主完成脚本重扫。之后连接和断开均由 Agent 自动执行。

## 真实能力差异

`synthv_capabilities` 中的 `readOperations` 和 `writeOperations` 是权威清单。调用缺失操作会在进入宿主前返回标准“不支持”错误。

- Flat 可以枚举已在 Flat 中注册的歌手并按精确 `databaseName` 分配，但当前没有安全的播放头定位操作，因此不能执行定点音频片段捕获。
- 官方 SV1 可以读写基础轨道、Part 和音符，也可控制并定位播放；不提供 SV2 的 Retake、computed pitch 或歌手身份选择。
- 官方 SV2 提供完整的 Guard/Context 写入、Voice 参数、Retake 和 computed pitch；官方脚本 API 不提供歌手数据库枚举或身份分配。

这些差异只通过能力数据和标准错误体现，不会泄露 HTTP、stdio、Lua、IPC 或宿主私有工具名。

## 常用流程

1. 调用 `synthv_hosts`，选择一个 `running: true` 的 `hostId`。
2. 调用 `synthv_connect`。
3. 调用 `synthv_capabilities`，依据操作清单规划工作。
4. 使用 `synthv_read` 获取当前数据。官方 SV2 写入前按返回要求使用 `writeIntent: true` 获取 `contextId`。
5. 使用 `synthv_write` 写入；每次写入只使用标准操作名和零基索引。
6. 需要可移植记录时调用 `synthv_export`。快照写入 Toolbox 的受管 `synthv-snapshots` 目录。
7. 完成后调用 `synthv_disconnect`。

连接失败时先重新调用 `synthv_hosts`：进程退出、PID 变化或宿主扩展未就绪都会反映在标准状态中。不要直接调用或缓存底层宿主工具。
