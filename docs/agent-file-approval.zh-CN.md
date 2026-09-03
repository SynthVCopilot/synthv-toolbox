# Agent 文件访问审批

内置 Agent 的 `agent_file_list` 只返回路径、类型、大小和 `decision`，从不读取内容。

`.svp`、`.svprj`、MIDI、常见音频、曲谱和歌词格式直接返回 `pass`。普通 `.txt`、`.json`、`.xml` 只有在受管创作目录且用途明确时才通过；其他普通文件在 Edit 模式产生 `human-approval-required` 和独立 `requestId`。Solo 模式直接通过普通文件。

批准/拒绝只能由 Copilot UI 的 Tauri command 改变服务端状态。授权绑定当前对话、规范化精确路径和文件大小/修改时间；新对话、替换后的同名文件和被拒绝文件都不能复用旧授权。

仅允许当前用户 HOME 下的非敏感路径。设备、URL、NUL、UNC、ADS、符号链接/reparse，以及 SSH、GnuPG、Keychains 和浏览器资料目录均被拒绝。
