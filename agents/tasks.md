# Pi Desktop 任务追踪
> 准则版本: v0.2.2

## 任务列表

| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |
| :--: | :------: | :------: | :------: | :--: |
| 001 | [Feature]_agent_runtime_host | 增加 Node Agent Runtime 生命周期和 JSONL RPC 骨架 | 将 AI 运行时从原生宿主构建中分离 | ✅ 已完成 |
| 002 | [Feature]_runtime_protocol_compatibility | 对齐共享协议并处理运行时向宿主发起的能力调用 | 建立可验证的双向运行时边界 | ✅ 已完成 |
| 003 | [Architecture]_Pi_Runtime与扩展架构重构 | 接通 Rust 宿主、Pi 运行时、model-auth、插件后端与 GUI 贡献 | 将频繁变化的 AI 和扩展层移出 Rust 编译边界 | ✅ 已完成 |
| 004 | [Architecture]_Pi_Runtime完整独立实现 | 内置 Node、全面切换模型请求链路并补齐插件安装管理 | 消除系统运行时和旧 Agent 链路依赖 | ✅ 已完成 |
| 005 | [Feature]_bundled_node | 下载、验证、打包并解析应用自带 Node | 消除运行时对系统 Node 的依赖 | ✅ 已完成 |
| 006 | [Security]_插件特权双层授权 | 增加内部函数与高级功能的全局及插件级开关，并在宿主侧强制鉴权 | 允许明确授权低层内部调用和高影响扩展能力 | ✅ 已完成 |
| 007 | [Feature]_独立离线授权 | 直接调用离线授权协议并受保护写入 session | 完整备份后在 Toolbox 中查看和切换当前设备离线授权 | ✅ 已完成 |
| 008 | [BugFix]_dev_runtime_path | 修复 Linux CI 中 Agent Runtime 合同测试的仓库根路径转换 | 让开发构建在准备阶段可靠找到已安装的运行时依赖 | ✅ 已完成 |
| 009 | [BugFix]_workbuddy_store_load | 删除运行时独立后无调用的 WorkBuddy 凭据读取函数 | 消除发布门禁的 dead_code 错误 | ✅ 已完成 |
| 010 | [BugFix]_rust_test_runtime_resources | 为 CI Rust 测试准备受控 Node 与 Agent Runtime 资源 | Tauri 测试构建需要与打包阶段相同的资源输入 | ✅ 已完成 |
| 011 | [Feature]_插件特权能力扩展 | 扩充内部底层单操作，并将高级联网和外部文件系统访问改为完全开放 | 对齐插件授权后的实际能力边界 | ✅ 已完成 |
