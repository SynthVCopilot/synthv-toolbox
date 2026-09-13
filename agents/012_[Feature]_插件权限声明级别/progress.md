# 进度记录

- 2026-09-12：建立插件权限声明三态任务，确定 manifest 映射格式与 required 启用语义。
- 2026-09-12：Runtime protocol、Agent Runtime 与 Plugin SDK 已改用权限级别映射；Node 只加载 Rust 宿主传入的可运行插件白名单。
- 2026-09-12：插件管理界面显示每项权限级别，none 不可授权，required 缺少全局或插件级授权时禁用插件启用入口。
