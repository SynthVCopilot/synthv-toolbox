import { addMessages } from "./i18n";

addMessages("zh-CN", { copilot: {
  "noProvider": "尚未选择提供商",
  "chooseModel": "选择模型",
  "noConnection": "未配置连接",
  "connectionCounts": "{oauth} 个 OAuth · {keys} 个 API Key",
  "messageCount": "{count} 条消息",
  "newChat": "新对话",
  "enabledToolsOnly": "Copilot 只会调用已启用的能力",
  "toolbar": "对话工具栏",
  "chooseProviderModel": "选择供应商和模型；当前为 {provider} {model}",
  "workMode": "Agent 工作模式",
  "emptyTitle": "今天想完成什么？",
  "emptyDescription": "可以从分析音频、检查工程或连接 SynthV 开始。",
  "audioPrompt": "分析这段音频的 BPM、调性和能量变化",
  "audioAction": "分析音频特征",
  "projectPrompt": "检查当前 SynthV 工程并总结轨道结构",
  "projectAction": "检查 SynthV 工程",
  "planPrompt": "帮我规划从演唱音频到 MIDI 或 SynthV 工程的工作流",
  "planAction": "规划音频到 SynthV",
  "you": "你"
} });

addMessages("en", { copilot: {
  "noProvider": "No provider selected",
  "chooseModel": "Choose a model",
  "noConnection": "No connection configured",
  "connectionCounts": "{oauth} OAuth · {keys} API keys",
  "messageCount": "{count} messages",
  "newChat": "New conversation",
  "enabledToolsOnly": "Copilot only uses enabled tools",
  "toolbar": "Conversation toolbar",
  "chooseProviderModel": "Choose provider and model; currently {provider} {model}",
  "workMode": "Agent work mode",
  "emptyTitle": "What would you like to do today?",
  "emptyDescription": "Start by analyzing audio, inspecting a project, or connecting SynthV.",
  "audioPrompt": "Analyze the BPM, key, and energy changes in this audio",
  "audioAction": "Analyze audio features",
  "projectPrompt": "Inspect the current SynthV project and summarize its track structure",
  "projectAction": "Inspect SynthV project",
  "planPrompt": "Help me plan a workflow from vocal audio to MIDI or a SynthV project",
  "planAction": "Plan audio to SynthV",
  "you": "You"
} });
