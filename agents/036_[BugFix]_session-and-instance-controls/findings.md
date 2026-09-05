# 调研记录

- [安装程序被列为实例] -> 枚举以宽松字符串匹配筛选，而 `is_sv2_executable_path` 只用于标记 -> 发现与控制必须只接受严格的可执行文件身份。
- [PID 复用风险] -> 仅凭 PID 定位进程 -> 控制请求必须同时比对当前进程的启动时间身份令牌。
- [本地 Rust 测试构建] -> 运行 `cargo test --lib synthv_control::tests` -> build script 因仓库缺失 `components/synthv-agent-bridge/node_modules` 停止，代码尚未进入编译；格式检查与 Node 契约测试通过。
