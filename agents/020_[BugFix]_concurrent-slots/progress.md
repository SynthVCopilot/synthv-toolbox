# 操作记录

- 2026-09-05：读取 agent-mode、agents/project.md、agents/tasks.md，检查 git status、worktree、remote。
- 定位 sv2_profiles.rs、sv2_concurrent.rs、sv2_account_probe.rs、svp_launch_router.rs 和前端账号页面。
- 按存储/并发、授权探测、前端实例跟踪分工；主 agent 负责路由与集成验证。
- 2026-09-05：改为每次并发启动生成唯一 Sandboxie box；box overlay 内 canonical SV2 数据路径为受管 junction，目标是账号 slot 权威根；配置 OpenFilePath 以使该目标直接读写。
- 2026-09-05：Windows 主账号改为 canonical junction 切换，slot 永久位于 vault/slots；移除运行路径上的共享声库合并。
- 2026-09-05：将普通/并发 session guard 合并到 slot 数据根；已有同账号并发实例时不重复创建 guard 快照。
- 2026-09-05：SafeSettings 同步加入 settings/settings.xml；新增根目录 contract test。
