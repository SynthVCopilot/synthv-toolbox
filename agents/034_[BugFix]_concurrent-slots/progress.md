# 操作记录

- 2026-09-05：读取 agent-mode、agents/project.md、agents/tasks.md，检查 git status、worktree、remote。
- 定位 sv2_profiles.rs、sv2_concurrent.rs、sv2_account_probe.rs、svp_launch_router.rs 和前端账号页面。
- 按存储/并发、授权探测、前端实例跟踪分工；主 agent 负责路由与集成验证。
- 创建三个独立 Windows worktree 和集成分支，已启动子 agent；每 15 分钟通过当前任务 heartbeat 检查进度。
- 查询 GitHub main，protected=false，最终验证通过后本地合并并推送 main。
- 工程路由取消本地 running_pids 排除，新增同账号多个 PID 仍可路由、官方占用和等待恢复仍排除的行为测试；将已有路由测试移至 /test。
- 首次 cargo test 编译发现基线 synthv_control.rs 的 windows-sys BOOL/HWND 类型错误，已交给持有该文件的实例 UI agent 一并修复。

- 合并 origin/main df098a3，保留已发布的其他功能；发现任务编号已占用，将本次审计归档重编号为 034。
- 存储子 agent 未能可靠提交完整文件，停止其写入；主 agent 接管存储集成，保留其 worktree，不删除或覆盖。
- 普通与并发共用 slots/<UUID>、同一 session 保护记录；移除跨账号 databases 共享，默认同步设置/脚本/词典/预设。
- 实测 junction::delete 仅移除重解析数据，留下目录阻挡切换；改为校验后删除链接目录，83 项域回归通过。
- 增加旧目录收敛前全量冲突检查，验证重复读取、双源冲突、归档占用、重解析父路径、主槽切换后原实例写入、启动前默认同步更新。
- 用户确认 SV2 支持同账号同环境多进程；移除全局 Applock 推断，同账号普通启动不再阻塞，正在验证同账号 Sandboxie 环境复用。
- 前端构建与全部 contracts 通过；浏览器预览实际检查标题、PID、账号列表，发现并修正预览 PID 碰撞及旧隔离偏好数据。
- 完整桌面测试可编译链接，但本机执行 EXE 被系统拒绝 (os error 5)，没有禁用或绕过安全软件。使用 /test/sv2-regression 直接导入真实账号/存储/路由模块运行测试。
- Sandboxie Classic 5.73.2 实际子进程 smoke 通过：子进程经官方 AppData 路径核对真实槽位后写入 nonce，同账号两个 PID 并存，其他账号隔离；仅操作随机测试目录，未操作真实 SV2 或登录态。

- 最终实现同账号复用同一已验证 sandbox；真实 smoke 断言一个环境目录内至少两个 PID，另账号 nonce 不受影响，结束后只清理准确匹配 fixture 的 sandbox 配置。
- 最终本地验证：87 项真实 Rust 域测试通过（默认并行测试也通过），全部桌面 contracts 通过，前端生产构建通过，桌面全目标 Clippy 通过。保留已证实的完整测试 EXE 在本机被拒绝执行这一限制。
- 按官方 SbieIni 文档核对 FileRootPath 和空 PID，清理此前 15 个仅属于本次随机 smoke fixture 的空闲测试配置；未修改其他 sandbox。
- 提交自检只保留 package.json 原有 chatgpt-copilot-ui 测试路径引用，它不是提交署名或来源标记；无任务编号或模型署名进入代码/提交。
- main 未受保护，按用户 Git 交付规则在本地合并并推送，随后核对远端 Windows/macOS 开发构建。

- 远端 macOS 完整 Rust 测试通过；Clippy 指出两个仅 Windows 分支使用的递归参数，已明确标记平台专用参数并重新提交。
