# 进度

- 已建立独立集成、Shell、Runtime 和更新工作树。
- 已确认现有 renderer API 是迁移边界。
- Electron 最小端到端 Shell、Node 服务迁移和自动更新链路正在并行实施。
- 已接入同进程 PI Runtime、model-auth 凭据服务、SynthV 服务、创作数据服务和 loopback HTTP MCP 服务。
- 已将插件与 MCP 的 internal/advanced 调用接到统一宿主能力路由，并保留全局与单插件双层授权。
- 已完成一键检查、自动下载、下载完成后自动安装重启的 Electron 更新链路。
- 已将运行组件从 `src-tauri/components` 移到应用级 `components`，Electron 打包不再引用 Rust 组件路径。
- Electron 构建和迁移服务行为测试通过；仍需补齐剩余 SynthV/组件命令并删除 Rust crate。
