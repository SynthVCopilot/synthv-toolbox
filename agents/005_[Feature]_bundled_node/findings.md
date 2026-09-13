# 发现

- 原 Node 解析接受环境变量、常见路径和 PATH，部署应用可能依赖系统 Node。
- Tauri 已通过 resources 打包 Runtime 和 Bridge，可将受控 Node 目录放入同一资源层。
- Node 22.19.0 官方归档的 SHA256 可用于确定性验证 Windows、macOS 和 Linux 产物。
- macOS universal 需要在 macOS runner 合并已验证的 x64 与 arm64 可执行文件。
