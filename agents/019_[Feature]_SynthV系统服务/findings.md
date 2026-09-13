# Findings

Windows 进程控制必须先重新枚举并比较 process identity。所有系统调用以固定可执行文件和参数数组发起，避免把用户输入拼入命令文本。
