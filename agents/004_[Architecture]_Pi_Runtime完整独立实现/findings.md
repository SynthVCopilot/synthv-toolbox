# 技术调研

- 当前 Runtime 启动仍通过系统 Node 查找逻辑，安装包尚未携带 Node 可执行文件。
- ModelAuthGateway 只完成接口骨架，未注入运行时，Pi 会话仍使用 SDK 默认模型访问路径。
- 桌面 Copilot 仍调用 Rust 会话命令，尚未切换到 Agent Runtime session RPC。
- 插件目录已有发现和加载，尚缺安装、启停、卸载及管理界面。
