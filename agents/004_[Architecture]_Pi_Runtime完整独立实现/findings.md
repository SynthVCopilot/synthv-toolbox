# 技术调研

- 当前 Runtime 启动仍通过系统 Node 查找逻辑，安装包尚未携带 Node 可执行文件。
- ModelAuthGateway 只完成接口骨架，未注入运行时，Pi 会话仍使用 SDK 默认模型访问路径。
- 桌面 Copilot 仍调用 Rust 会话命令，尚未切换到 Agent Runtime session RPC。
- 插件目录已有发现和加载，尚缺安装、启停、卸载及管理界面。

- 固定 Node 22.19.0 已按平台和架构下载并校验 SHA-256，Rust 启动路径只接受应用资源目录中的可执行文件。
- Copilot、歌词候选与工作流复核均已切换到 Pi Runtime session RPC，Rust 中旧 AgentLoop 请求调用已清零。
- Runtime 使用 model-auth CredentialRouter 选择 API Key 或 OAuth 凭据，再显式注入 Pi ModelRuntime；Anthropic 与 OpenAI Codex 模型已用实际 SDK 校验存在。
- Pi 会话关闭内置文件与命令工具，保留插件工具，使插件能够经权限化宿主能力扩展 Agent。
- 插件管理器支持目录和 ZIP 安装、启停、替换与卸载；ZIP 拒绝路径穿越、符号链接、超量条目和超大解压内容。
- 插件管理页支持选择安装源、查看贡献与权限、启停和卸载，并在变更后同步 GUI 注册表与 Runtime 发现结果。
