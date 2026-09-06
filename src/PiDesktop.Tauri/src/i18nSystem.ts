import { addMessages } from "./i18n";

addMessages("zh-CN", { system: {
  ffmpegLocalDirectory: "本地目录", ffmpegChooseDirectory: "选择包含 FFmpeg 的目录", chooseDirectory: "选择目录", savePath: "保存路径", clearSelection: "清除选择", manualDownload: "手动下载", ffmpegSource: "FFmpeg 来源", ffmpegSourceHelp: "选择包含 ffmpeg 和 ffprobe 的目录；清除后自动检测受管版本、内置版本或系统 PATH。",
  recovery: "设置恢复保护模式", recoveryTitle: "配置需要修复，原文件尚未被覆盖",
  recoveryDescription: "工具箱检测到设置文件无法安全读取，因此已停用所有设置写入。OAuth 凭据和账号映射不会被默认配置替换。",
  configFile: "配置文件", recoveryHelp: "请修复 JSON 与 schemaVersion，或从备份恢复此文件，然后重新启动 Synthesizer V Toolbox。",
  terminateTitle: "终止这个实例？", terminateWarning: "未保存的工程修改会丢失。请确认已保存；其他实例会继续运行。", terminate: "终止实例", cancel: "取消",
  cleanup: "清理残留", deleteComponent: "删除组件", componentManagement: "本地组件管理", cleanupTitle: "清理“{name}”？", deleteTitle: "删除“{name}”？",
  componentRemoval: "此操作会删除 Synthesizer V Toolbox 管理的本地运行环境与对应配置。依赖此组件的工作流在重新安装前将不可用。",
  componentPreserved: "用户工程、输入素材以及已导出的输出文件不会被删除；之后仍可从组件中心重新安装。",
  modeChanged: "已切换到{mode}。", agentModeChanged: "Agent 已切换到 {mode} 模式。", updateFound: "发现新版本 v{version}。", latest: "当前已是最新稳定版。", newer: "当前应用版本高于最新稳定版。", scanComplete: "探测完成。",
  componentQueued: "组件已加入下载队列。", componentCancelled: "排队中的组件任务已取消。", componentRetried: "组件任务已重新加入队列。",
  startupFailed: "无法启动 Synthesizer V Toolbox", startupHelp: "请确认应用由 Tauri 运行，而不是直接打开前端页面。", testConnection: "测试连接", deleteConnection: "删除连接"
} });

addMessages("en", { system: {
  ffmpegLocalDirectory: "Local directory", ffmpegChooseDirectory: "Choose a directory containing FFmpeg", chooseDirectory: "Choose directory", savePath: "Save path", clearSelection: "Clear selection", manualDownload: "Manual download", ffmpegSource: "FFmpeg source", ffmpegSourceHelp: "Choose a directory containing ffmpeg and ffprobe. Clearing it restores detection of managed, bundled, or system PATH versions.",
  recovery: "Settings recovery protection", recoveryTitle: "Settings need repair; the original file has been preserved",
  recoveryDescription: "The toolbox could not safely read its settings and has disabled settings writes. Default settings will not replace OAuth credentials or account mappings.",
  configFile: "Configuration file", recoveryHelp: "Repair the JSON and schemaVersion, or restore this file from a backup, then restart Synthesizer V Toolbox.",
  terminateTitle: "Terminate this instance?", terminateWarning: "Unsaved project changes will be lost. Save your work before continuing; other instances will keep running.", terminate: "Terminate instance", cancel: "Cancel",
  cleanup: "Clean up files", deleteComponent: "Delete component", componentManagement: "Local components", cleanupTitle: "Clean up “{name}”?", deleteTitle: "Delete “{name}”?",
  componentRemoval: "This removes the local runtime and configuration managed by Synthesizer V Toolbox. Workflows that depend on this component will be unavailable until it is reinstalled.",
  componentPreserved: "Your projects, input media, and exported files will be kept. You can reinstall the component from Components later.",
  modeChanged: "Switched to {mode}.", agentModeChanged: "Agent switched to {mode} mode.", updateFound: "Version v{version} is available.", latest: "You are using the latest stable version.", newer: "Your app version is newer than the latest stable release.", scanComplete: "Scan complete.",
  componentQueued: "Component added to the download queue.", componentCancelled: "Queued component task cancelled.", componentRetried: "Component task queued again.",
  startupFailed: "Unable to start Synthesizer V Toolbox", startupHelp: "Run the app through Tauri instead of opening the frontend page directly.", testConnection: "Test connection", deleteConnection: "Delete connection"
} });
