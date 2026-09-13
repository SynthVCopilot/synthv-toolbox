# 进度

- 已建立独立集成、Shell、Runtime 和更新工作树。
- 已确认现有 renderer API 是迁移边界。
- Electron 最小端到端 Shell、Node 服务迁移和自动更新链路正在并行实施。
- 已接入同进程 PI Runtime、model-auth 凭据服务、SynthV 服务、创作数据服务和 loopback HTTP MCP 服务。
- 已将插件与 MCP 的 internal/advanced 调用接到统一宿主能力路由，并保留全局与单插件双层授权。
- 已完成一键检查、自动下载、下载完成后自动安装重启的 Electron 更新链路。
- 已将运行组件从 `src-tauri/components` 移到应用级 `components`，Electron 打包不再引用 Rust 组件路径。
- 已删除 Rust crate、Cargo/Tauri 构建链与对应旧测试；renderer 不再导入 Tauri API。
- Electron host 与 renderer 可独立编译，PI Runtime 与 model-auth 在 Electron 进程内工作，不再分发或弹出额外 Node 进程。
- 已补齐 FFmpeg 媒体探测、音频准备、响度分析/归一化、产物保存，以及 CVRS、pi-audio、人声分离组件执行入口。
- 已接入 Sandboxie 账号目录映射、配置校验和并发启动，并使用同进程 Bridge 文件 IPC。
- Electron Builder 已生成 Windows NSIS 安装包和 blockmap；`latest.yml` 的文件名、大小与 SHA-512 已核对一致。
- Electron renderer、host、164 条命令覆盖、插件/MCP 权限、更新、音频、MIDI、自启动、Bridge 与 Sandboxie 合同测试全部通过。
