# 调查记录

- [macOS 合同测试读取不到进程] -> 检查 runner 与 `listProcesses()` -> 测试只为 `powershell.exe` 返回数据；macOS 实际调用 `ps -axo`，因此结果为空并在读取 `processId` 时失败。
- [本机首次验证选择了 macOS 预期值] -> 检查条件表达式 -> 局部进程变量遮蔽了全局 `process`，已改为明确的 `synthvProcess` 名称。
- [第三轮 Action 两个平台在后续合同中找不到 command-registry.js] -> 对比干净 checkout 与本地增量目录 -> 工作流在生成 `dist/electron` 前运行依赖编译产物的合同测试，已调整执行顺序。
