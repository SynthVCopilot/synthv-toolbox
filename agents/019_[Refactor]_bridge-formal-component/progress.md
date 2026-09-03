# 操作记录

- 读取 `agent-mode` 工作流并检查项目审计目录。
- 检查根仓库和 `external/synthv-agent-bridge` 的 Git 状态、子模块引用、Tauri 资源配置及组件包配置。
- 创建本任务的审计目录，并登记进行中的迁移任务。
- 将当前子模块工作树复制到 `src/PiDesktop.Tauri/src-tauri/components/synthv-agent-bridge`，并以 SHA-256 验证 132 个源码文件完整一致。
- 调整 Tauri 打包资源、运行时组件解析、桌面构建前置脚本和两条发布工作流，改用正式组件路径。
- 解除 Git 子模块跟踪，删除 `.gitmodules` 与旧组件目录，并添加组件布局契约测试。
- 运行 Bridge `npm run check`、桌面 `npm run build` 与 `npm run test:contracts`，均成功；`cargo check` 因既有 Windows API 类型错误失败。
- 远程 `main` 在首次推送前推进；变基期间将上游 Bridge 更新与本地修改三方合并，并把新增 `legacy-sv1` 资源纳入 Tauri 打包与组件契约。
