# 调研与发现

- Flat 连接已优先使用原生 HTTP MCP，失败时回退至 SV1 兼容 Bridge，并通过 Node 安装器的 `--target` 参数写入 Anthronics 脚本目录。
- 当前脚本安装成功反而返回错误，要求用户手动重扫后再次连接；这与“自动安装并连接”的目标冲突。
- 当前标准 `synthv_connect` 只接受运行中 `hostId`，不能为已安装但未运行的 Flat 传入工程路径启动参数。
- macOS Flat 可直接以 `.svp` 绝对路径作为进程参数启动；输入必须先验证为现有普通 `.svp` 文件，避免把任意参数透传给宿主。
- 工程启动参数进一步限定为绝对路径并在传入宿主前规范化；子进程标准输入输出关闭，避免继承 Toolbox 的 HTTP/GUI 进程句柄。
- macOS 临时目录规范化会把 `/var` 解析为 `/private/var`；单测应比较规范化结果而不是输入字符串。
- 安装态实测发现 Flat 的数据库和原生 MCP 状态位于 Anthronics，但其 `Scripts → Open Scripts Folder` 实际使用 Dreamtonics；脚本目录必须按真实宿主目录优先并保留两种变体候选。
- 直接启动包内 Studio 可执行文件会绕过 Flat 外层启动器，导致原生 MCP 状态仍指向旧 PID；参数启动必须调用 Flat `.app/Contents/MacOS` 外层可执行文件。
- 新装脚本不会自动出现在菜单中；macOS 回退现在直接调用 `Scripts → Rescan` 和脚本菜单项，避免把无实际绑定的 F5/F13 当成成功。
- 外层启动器实测会先创建 Studio 进程，再稍后写入匹配新 PID 的 MCP Ready 状态；进程发现后需给原生端点 5 秒宽限期，不能在数百毫秒窗口内误入脚本回退。
- 全量契约发现旧 Actions 测试把 macOS Flat 单测函数名固定为 Anthronics 路径假设；已更新为验证新的真实脚本目录语义。
- `synthv_connect` 现仅在未运行的稳定 `flat` 宿主记录上启动 Flat。它接受的唯一额外参数是 `projectPath`，且只接受非链接、存在的普通 `.svp` 文件；启动由 `Command` 与独立参数完成。
- 兼容脚本安装器成功后不再返回要求重试的错误：连接器会发送 F5、短暂等待、发送 F13，并在同次调用内有界轮询标准状态。
- 当前真实 Flat 正在运行并打开用户工程，未为了覆盖“未运行”分支强制终止；安装路径和进程发现已由运行环境确认，路径校验和回退链路由 Rust 单测与根契约覆盖。
- release 构建完成前端生产编译，但执行环境在 Rust release 链接阶段终止，未生成新的安装包；`cargo check` 和相关单测均已通过。
