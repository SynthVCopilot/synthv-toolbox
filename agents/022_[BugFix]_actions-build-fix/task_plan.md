# 022 Actions构建修复

- [x] 检查指定 worktree、分支、项目索引与现有审计记录
- [x] 复现并定位 Bridge 构建脚本在生产依赖裁剪后的失败路径
- [x] 设计并实现 dist 有效时跳过、dist 缺失时恢复开发依赖的构建逻辑
- [x] 定位并修复 downloads.rs 的 clippy `Option::map` unit closure
- [x] 重构 workflows.rs 的过多参数函数为清晰请求结构
- [x] 在根 `/test` 增加或更新 Node 契约测试
- [x] 运行相关 Node 契约、cargo fmt、cargo test 与 cargo clippy
- [x] 检查 diff 范围与提交内容，提交到 `codex/actions-build-fix`
