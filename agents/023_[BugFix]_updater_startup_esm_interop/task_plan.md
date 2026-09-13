# 自动更新器启动修复计划

- [x] 建立独立 worktree 并确认从 origin/main 创建。
- [x] 定位已安装应用主进程的加载错误与相关实现。
- [x] 将 electron-updater 改为兼容 ESM 主进程的 CommonJS 互操作导入。
- [x] 新增覆盖产物加载路径的合同测试。
- [x] 生成 packaged 产物并验证主进程可加载。
- [x] 由 GitHub Actions 使用 Electron 加载编译后的主进程模块，并让 nightly 发布等待验证成功。
- [x] 复核差异、提交变更。
