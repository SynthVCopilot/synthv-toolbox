# 发现

- Windows 使用 cfg! 分支仍会类型检查 Unix PermissionsExt，必须使用条件编译块。
- macOS Clippy 拒绝多余 Ok/问号、恒等 map_err，以及测试 Default 后逐项赋值。
- Windows 第二轮并非断言失败：测试程序在进入 harness 前以 STATUS_ENTRYPOINT_NOT_FOUND 退出。Tauri 官方问题 13419 说明默认资源只链接 bin，测试缺 Common Controls v6 manifest；当前 tauri-build 源码与现象一致。
- 采用独立 manifest 并通过 build.rs 对所有 MSVC 产物发出链接参数；不启用依赖 Tauri monorepo 相对路径的内部环境标志。
