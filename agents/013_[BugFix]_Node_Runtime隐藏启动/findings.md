# 技术调研

- 桌面主程序已经使用 Windows GUI subsystem，但它启动的控制台子进程仍会自行创建窗口。
- 内置 Node Agent Runtime 由 Rust 的异步进程启动器创建，需要在 Windows 创建进程时设置 `CREATE_NO_WINDOW`。
- 应检查所有以 bundled Node 为程序的常驻和一次性调用入口，避免相同回归从其他功能路径出现。
