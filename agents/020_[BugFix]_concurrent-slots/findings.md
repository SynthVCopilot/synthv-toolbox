# 调研结果

- [同账号只能启动一次] -> 检查并发服务和路由 -> 两层均硬性拒绝已有 running_pids，隔离箱名称也固定为账号槽，需要独立实例隔离。
- [数据不一致] -> 检查并发准备与共享配置 -> 当前复制槽位到 sandbox，设置独立、声库共享，违背本次需求。
- 初始 main 为 674d048，工作区干净；另有既存 account-auto worktree，本次不修改。
- 当前是 Windows，worktree 默认目录按用户主目录映射为 C:/Users/User/.codex/worktrees/pi-desktop。
