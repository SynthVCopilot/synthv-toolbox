import { addMessages } from "./i18n";

addMessages("zh-CN", { home: {
  aiWorkspace: "AI 工作区", localWorkspace: "本地工具工作区", aiTitle: "把重复操作交给 Copilot，创作判断留给你。", localTitle: "所有核心工具，集中在一个安静的工作区。",
  aiDescription: "从音频分析到 SynthV 工程操作，AI 只通过你启用的能力和 MCP 工具工作。", localDescription: "无需模型配置即可进行确定性的音频、MIDI、工程和 Bridge 操作。",
  openCopilot: "打开 Copilot", openImport: "打开导入与转换", checkBridge: "检查 Bridge", mode: "运行模式", ai: "AI 增强", toolbox: "纯工具箱", runtimeOff: "模型运行时已停用",
  components: "本地组件", available: "已检测为可用", discovered: "已发现", notDiscovered: "未发现", manualScripts: "可手动选择 scripts 目录", toolConnections: "工具连接", online: "在线", offline: "离线", enabledMcp: "{count} 个 MCP 已启用", independentBridge: "Bridge 可独立使用", quickStart: "快速开始", quickDescription: "继续最近的工作，或打开常用能力。",
  windowsOnly: "仅限 Windows", unavailable: "当前平台不可用", enableAi: "切换至 AI 模式", requiresAi: "需要 AI 模式", install: "安装组件", missing: "缺少 {count} 个组件", connect: "连接 Bridge", bridgeRequired: "需要连接 SynthV Bridge", ready: "已就绪", openTool: "打开工具", unavailableTool: "当前工具不可用", resolveDependencies: "请处理依赖后再开始。", noTools: "当前分类没有可用工具。", groupTools: "{group}中的工具"
} });

addMessages("en", { home: {
  aiWorkspace: "AI workspace", localWorkspace: "Local utility workspace", aiTitle: "Let Copilot handle repetition while you make the creative decisions.", localTitle: "All your core tools in one quiet workspace.",
  aiDescription: "From audio analysis to SynthV editing, AI works only through the capabilities and MCP tools you enable.", localDescription: "Use deterministic audio, MIDI, project, and Bridge tools without configuring a model.",
  openCopilot: "Open Copilot", openImport: "Open Import & Convert", checkBridge: "Check Bridge", mode: "Runtime mode", ai: "AI enhanced", toolbox: "Toolbox only", runtimeOff: "Model runtime disabled",
  components: "Local components", available: "Detected as available", discovered: "Found", notDiscovered: "Not found", manualScripts: "Select a scripts directory manually", toolConnections: "Tool connections", online: "Online", offline: "Offline", enabledMcp: "{count} MCP servers enabled", independentBridge: "Bridge works independently", quickStart: "Quick start", quickDescription: "Continue your work or open a frequently used tool.",
  windowsOnly: "Windows only", unavailable: "Unavailable on this platform", enableAi: "Switch to AI mode", requiresAi: "AI mode required", install: "Install components", missing: "Missing {count} components", connect: "Connect Bridge", bridgeRequired: "Connect SynthV Bridge to continue", ready: "Ready", openTool: "Open tool", unavailableTool: "This tool is unavailable", resolveDependencies: "Resolve its dependencies before starting.", noTools: "No tools are available in this category.", groupTools: "Tools in {group}"
} });

addMessages("zh-CN", { onboardingDetails: { deterministic: "确定性基础处理", noAi: "不显示 AI 与外部 MCP 工具", runtimeOff: "不启动模型运行时", correction: "自动纠正与置信度复核", parameters: "高级参数微调建议", externalMcp: "外部 MCP 工具接入", navigation: "主导航", home: "返回概览" } });
addMessages("en", { onboardingDetails: { deterministic: "Deterministic core processing", noAi: "No AI or external MCP tools", runtimeOff: "No model runtime", correction: "Assisted corrections and confidence review", parameters: "Advanced parameter suggestions", externalMcp: "External MCP tools", navigation: "Main navigation", home: "Back to overview" } });
