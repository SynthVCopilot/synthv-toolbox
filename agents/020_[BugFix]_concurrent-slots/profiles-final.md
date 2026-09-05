# Profiles 收敛计划

- [x] 审核 Windows 与 macOS 槽位切换、恢复、guard 和同步入口。
- [x] 将 Windows canonical 固定为受管 junction，slot 根作为唯一权威路径。
- [x] 用 journal 和回滚保护 Windows 导入、切换及 legacy 数据收敛。
- [x] 让新槽位从主槽位同步默认设置和脚本。
- [x] 迁移 profiles/guard 单测至根目录，并覆盖每槽位单一 guard 文件。
- [x] 运行格式化、构建和测试编译验证。

Windows 的恢复只会核对或重建指向固定 slot 根的 junction；不会再把 slot 根改名回 canonical。Guard 以 `slot.json` 和 `slot.session` 保存每个槽位的一份状态。`cargo test --lib --no-run` 已通过；现有 concurrent 文件有未使用代码警告。
