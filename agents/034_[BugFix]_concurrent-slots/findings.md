# 调研结果

- [同账号只能启动一次] -> 检查并发服务和路由 -> 两层均硬性拒绝已有 running_pids，隔离箱名称也固定为账号槽，需要独立实例隔离。
- [数据不一致] -> 检查并发准备与共享配置 -> 当前复制槽位到 sandbox，设置独立、声库共享，违背本次需求。
- 初始 main 为 674d048，工作区干净；另有既存 account-auto worktree，本次不修改。
- 当前是 Windows，worktree 默认目录按用户主目录映射为 C:/Users/User/.codex/worktrees/pi-desktop。
- [会话同步永久失败] -> probe agent 检查多根批处理 -> 缺失/使用中的第二副本能导致整个账号永久 SyncFailed；将收敛为单权威会话，安全处理真实写入失败。
- [编译失败] -> cargo test --lib svp_launch_router::tests -> 基线 synthv_control.rs 使用旧 windows-sys BOOL 和 HWND 类型，已纳入该文件修复。
- 官方 Sandboxie 文档说明 FileRootPath 只定义 overlay 根，OpenFilePath 只授权直接访问；必须结合实际 canonical 路径映射验证，单独放行 slot 路径不足以重定向 SV2。
- 参考：https://sandboxie-plus.com/sandboxie/sandboxhierarchy/ 与 https://sandboxie-plus.github.io/sandboxie-docs/Content/OpenFilePath.html。
