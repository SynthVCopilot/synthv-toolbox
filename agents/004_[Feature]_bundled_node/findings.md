# 发现

- [现状] -> `synthv::find_node` 接受环境变量、常见 macOS 路径和 PATH -> 已部署应用的 Agent Runtime 与 Bridge 都可依赖系统 Node。
- [打包] -> Tauri 已通过 `bundle.resources` 打包 Agent Runtime 和 Bridge -> 可将受控 Node 目录作为同一资源层打包，不需要 sidecar 配置。
- [官方分发] -> Node 22.19.0 的 SHA256 由 nodejs.org 的 `SHASUMS256.txt` 提供 -> 脚本可在下载后确定性验证 Windows、macOS、Linux 归档。
- [macOS] -> 官方提供 x64 和 arm64 Node 而非 universal 二进制 -> universal 目标必须在 macOS runner 通过 `lipo` 合并两个验证过的可执行文件。
