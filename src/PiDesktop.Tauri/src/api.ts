import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AppMode,
  BatchWorkflowResult,
  BootstrapState,
  ChatMessage,
  ChineseRhymeLookup,
  ComponentDownload,
  CreativeHistoryEntry,
  ConversationSnapshot,
  ConversationSummary,
  McpServerConfig,
  LyricCandidateRequest,
  LyricCandidateSet,
  LyricSectionRequest,
  OperationResult,
  ProjectCheckpoint,
  Sv2AccountPrecheck,
  Sv2AccountUsageSnapshot,
  Sv2IsolationPreference,
  Sv2ProfilesState,
  Sv2SyncCategory,
  Sv2SyncCategoryId,
  Sv2SyncManifest,
  Sv2SyncResult,
  SvpLaunchMode,
  SvpRoutePlan,
  SynthVInstallation,
  WorkflowRecipe,
  WorkflowResult,
  RhymeMatchMode,
} from "./types";

const preview = import.meta.env.DEV && !isTauri();
let previewMode: AppMode = "toolbox";
let previewOnboarding = false;
let previewConcurrentDisclaimerAccepted = false;
let previewSmartSvpLaunchEnabled = false;
let previewDownloads: ComponentDownload[] = [];
let previewProfiles: Sv2ProfilesState = {
  supported: true,
  canonicalPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
  vaultPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots",
  activeSlotId: "11111111-1111-4111-8111-111111111111",
  canonicalRootExists: true,
  canImportCurrent: false,
  recoveryRequired: false,
  recoveryDetail: "",
  blockers: [
    { pid: 45036, name: "Microsoft Edge WebView2", reason: "正在使用当前 SV2 槽位文件" },
    { pid: 20348, name: "synthv-studio.exe", reason: "SV2 standalone 正在运行" },
  ],
  concurrentProvider: {
    available: true,
    name: "Sandboxie Classic",
    edition: "Classic",
    version: "5.73.2",
    installPath: "C:\\Program Files\\Sandboxie",
    detail: "隔离核心已就绪，可以为不同账号槽位运行相互独立的 SV2 实例。",
  },
  concurrentDefaults: {
    appSettings: true,
    voiceLibraries: false,
  },
  slots: [{
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "主账号",
    identity: {
      status: "sessionPresent",
      username: null,
      email: null,
      detail: "检测到 session 文件。独立工具箱没有已验证的 token broker，不能据此确认登录状态或账号身份。",
      checkedAtUtc: new Date().toISOString(),
    },
    color: "#6D5CE7",
    createdAtUtc: new Date().toISOString(),
    lastActivatedAtUtc: new Date().toISOString(),
    isActive: true,
    sessionFilePresent: true,
    dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
    sessionProtection: {
      status: "recoveryPending",
      snapshotAvailable: true,
      lastDetectedAtUtc: new Date().toISOString(),
      detail: "检测到受保护启动后的本地 session 文件消失。不会覆盖后来生成的新文件；下次由工具箱启动此槽位前将尝试原样恢复。",
    },
    concurrentSessionProtection: {
      status: "ready",
      snapshotAvailable: false,
      detail: "session 文件存在；工具箱启动 SV2 时会先建立不透明保护快照。",
    },
    voiceInventory: {
      authorizationStatus: "unknown",
      authorizedVoices: [],
      detail: "独立工具箱没有已验证的 Dreamtonics token broker，无法确认此账号的产品或声库授权。",
    },
    concurrent: {
      ready: true,
      dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\concurrent\\11111111-1111-4111-8111-111111111111\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
      runningPids: [],
      detail: "隔离副本已准备；本地变化不会自动覆盖普通槽位。",
      content: {
        appSettings: "global",
        voiceLibraries: "off",
        effectiveAppSettings: true,
        effectiveVoiceLibraries: false,
      },
    },
  }, {
    id: "22222222-2222-4222-8222-222222222222",
    displayName: "备用账号",
    identity: {
      status: "sessionAbsent",
      username: null,
      email: null,
      detail: "未检测到 session 文件；这只描述本地文件状态，不判断账号是否已登录。",
      checkedAtUtc: new Date().toISOString(),
    },
    color: "#3478C9",
    createdAtUtc: new Date().toISOString(),
    isActive: false,
    sessionFilePresent: false,
    dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\slots\\22222222-2222-4222-8222-222222222222",
    sessionProtection: {
      status: "sessionAbsent",
      snapshotAvailable: false,
      detail: "当前没有 session 文件；文件出现后，后续工具箱启动会自动建立保护快照。",
    },
    concurrentSessionProtection: {
      status: "sessionAbsent",
      snapshotAvailable: false,
      detail: "当前没有 session 文件；文件出现后，后续工具箱启动会自动建立保护快照。",
    },
    voiceInventory: {
      authorizationStatus: "unknown",
      authorizedVoices: [],
      detail: "独立工具箱没有已验证的 Dreamtonics token broker，无法确认此账号的产品或声库授权。",
    },
    concurrent: {
      ready: false,
      dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\concurrent\\22222222-2222-4222-8222-222222222222\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
      runningPids: [],
      detail: "尚未准备隔离副本。",
      content: {
        appSettings: "on",
        voiceLibraries: "global",
        effectiveAppSettings: true,
        effectiveVoiceLibraries: false,
      },
    },
  }],
};

const previewState = (): BootstrapState => ({
  onboardingCompleted: previewOnboarding,
  mode: previewMode,
  platform: "preview",
  appVersion: "0.1.1",
  configPath: "~/.SynthVcopilot/config.json",
  model: previewMode === "ai" ? { baseUrl: "https://api.anthropic.com", model: "", tokenConfigured: false } : undefined,
  scriptsPath: "/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts",
  bridgeBundled: true,
  bridgeConnected: false,
  installations: [{
    displayName: "Synthesizer V Studio 2",
    scriptsPath: "/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts",
    source: "macOS 用户脚本目录",
  }],
  components: [
    { id: "ffmpeg", displayName: "FFmpeg", description: "音视频转码与抽取；所有音频流程的基础。", audience: "AI 与人工", installed: true, downloaded: false, installable: true, status: "已就绪" },
    { id: "pi-audio", displayName: "pi-audio 音频探针", description: "特征指纹、BPM、乐器与风格倾向。", audience: "AI 与人工", installed: false, downloaded: false, installable: true, status: "可通过 aria2 下载" },
    { id: "cvrs", displayName: "CVRS 工程工具", description: "工程探测、安全副本、无参导出与 LRC。", audience: "AI 与人工", installed: true, downloaded: false, installable: true, status: "已就绪" },
    { id: "sandboxie", displayName: "Sandboxie Plus 1.18.2", description: "SynthV Toolbox 并发隔离提供方；下载官方安装包后由用户交互安装。", audience: "Windows 并发隔离", installed: false, downloaded: false, installable: true, status: "可通过 aria2 下载官方 x64 安装包" },
  ],
  downloads: previewDownloads,
  mcpServers: previewMode === "ai" ? [{ id: "demo", name: "Demo tools", command: "node", args: ["server.mjs"], enabled: true }] : [],
  concurrentDisclaimerAccepted: previewConcurrentDisclaimerAccepted,
  smartSvpLaunchEnabled: previewSmartSvpLaunchEnabled,
  svpAssociation: {
    supported: true,
    registered: previewSmartSvpLaunchEnabled,
    isDefault: false,
    detail: previewSmartSvpLaunchEnabled
      ? "已注册为 .svp 可选打开方式；请在 Windows 默认应用中选择 SynthV Toolbox。"
      : "智能启动默认关闭，不会改变当前 .svp 打开方式。",
  },
});

function previewAccountPrecheck(): Sv2AccountPrecheck {
  const slot = previewProfiles.slots.find((item) => item.isActive);
  const recoveryPending = slot?.sessionProtection.status === "recoveryPending"
    || slot?.concurrentSessionProtection.status === "recoveryPending";
  return {
    supported: true,
    checkedAtUtc: new Date().toISOString(),
    slotId: slot?.id,
    displayName: slot?.displayName ?? "",
    localUse: previewProfiles.blockers.length > 0 || Boolean(slot?.concurrent.runningPids.length),
    localProcesses: previewProfiles.blockers,
    concurrentPids: slot?.concurrent.runningPids ?? [],
    remoteUse: "unknown",
    sessionFilePresent: Boolean(slot?.sessionFilePresent),
    recoveryPending,
    summary: recoveryPending ? "本机未发现占用进程；本地 session 待恢复。" : "本机未发现当前槽位正在使用。",
    detail: "独立工具箱没有已验证的 Dreamtonics token broker，远端占用状态始终未知。",
  };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!preview) return invoke<T>(command, args);
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (command === "complete_onboarding" || command === "set_mode") {
    previewMode = args?.mode as AppMode;
    previewOnboarding = true;
  }
  if (command === "set_svp_launch_routing") {
    previewSmartSvpLaunchEnabled = Boolean(args?.enabled);
    return previewState() as T;
  }
  if (command === "open_svp_default_apps_settings") {
    return { succeeded: true, summary: "已打开 Windows 默认应用设置。", detail: "请为 .svp 选择 SynthV Toolbox。" } as T;
  }
  if (command === "bootstrap" || command === "complete_onboarding" || command === "set_mode" || command.endsWith("settings") || command.endsWith("server") || command === "save_scripts_path" || command === "delete_mcp_server") {
    return previewState() as T;
  }
  if (command === "scan_synthv") return previewState().installations as T;
  if (command === "sv2_profile_state") return previewProfiles as T;
  if (command === "sv2_account_usage_snapshot") {
    return { profiles: previewProfiles, precheck: previewAccountPrecheck() } as Sv2AccountUsageSnapshot as T;
  }
  if (command === "sv2_account_precheck") {
    return previewAccountPrecheck() as T;
  }
  if (command === "import_current_sv2_profile" || command === "create_sv2_profile") {
    const id = crypto.randomUUID();
    previewProfiles.slots.push({
      id,
      displayName: String(args?.displayName ?? "新账号"),
      identity: {
        status: "sessionAbsent",
        username: null,
        email: null,
        detail: "未检测到 session 文件；这只描述本地文件状态，不判断账号是否已登录。",
        checkedAtUtc: new Date().toISOString(),
      },
      color: "#3478C9",
      createdAtUtc: new Date().toISOString(),
      isActive: false,
      sessionFilePresent: false,
      dataPath: `${previewProfiles.vaultPath}\\slots\\${id}`,
      sessionProtection: {
        status: "sessionAbsent",
        snapshotAvailable: false,
        detail: "当前没有 session 文件；文件出现后，后续工具箱启动会自动建立保护快照。",
      },
      concurrentSessionProtection: {
        status: "sessionAbsent",
        snapshotAvailable: false,
        detail: "当前没有 session 文件；文件出现后，后续工具箱启动会自动建立保护快照。",
      },
      voiceInventory: {
        authorizationStatus: "unknown",
        authorizedVoices: [],
        detail: "独立工具箱没有已验证的 Dreamtonics token broker，无法确认此账号的产品或声库授权。",
      },
      concurrent: {
        ready: false,
        dataPath: `${previewProfiles.vaultPath}\\concurrent\\${id}\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2`,
        runningPids: [],
        detail: "尚未准备隔离副本。",
        content: {
          appSettings: "global",
          voiceLibraries: "global",
          effectiveAppSettings: previewProfiles.concurrentDefaults.appSettings,
          effectiveVoiceLibraries: previewProfiles.concurrentDefaults.voiceLibraries,
        },
      },
    });
    previewProfiles.canImportCurrent = false;
    return previewProfiles as T;
  }
  if (command === "rename_sv2_profile") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) slot.displayName = String(args?.displayName ?? slot.displayName);
    return previewProfiles as T;
  }
  if (command === "update_sv2_concurrent_defaults") {
    previewProfiles.concurrentDefaults = {
      appSettings: Boolean(args?.appSettings),
      voiceLibraries: Boolean(args?.voiceLibraries),
    };
    previewProfiles.slots.forEach((slot) => {
      slot.concurrent.content.effectiveAppSettings = slot.concurrent.content.appSettings === "global"
        ? previewProfiles.concurrentDefaults.appSettings
        : slot.concurrent.content.appSettings === "on";
      slot.concurrent.content.effectiveVoiceLibraries = slot.concurrent.content.voiceLibraries === "global"
        ? previewProfiles.concurrentDefaults.voiceLibraries
        : slot.concurrent.content.voiceLibraries === "on";
    });
    return previewProfiles as T;
  }
  if (command === "update_sv2_concurrent_content") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) {
      slot.concurrent.content.appSettings = args?.appSettings as Sv2IsolationPreference;
      slot.concurrent.content.voiceLibraries = args?.voiceLibraries as Sv2IsolationPreference;
      slot.concurrent.content.effectiveAppSettings = slot.concurrent.content.appSettings === "global"
        ? previewProfiles.concurrentDefaults.appSettings
        : slot.concurrent.content.appSettings === "on";
      slot.concurrent.content.effectiveVoiceLibraries = slot.concurrent.content.voiceLibraries === "global"
        ? previewProfiles.concurrentDefaults.voiceLibraries
        : slot.concurrent.content.voiceLibraries === "on";
    }
    return previewProfiles as T;
  }
  if (command === "activate_sv2_profile" || command === "force_activate_sv2_profile") {
    previewProfiles.activeSlotId = String(args?.slotId ?? "");
    previewProfiles.slots.forEach((slot) => { slot.isActive = slot.id === previewProfiles.activeSlotId; });
    if (command === "force_activate_sv2_profile") previewProfiles.blockers = [];
    return previewProfiles as T;
  }
  if (command === "launch_sv2_profile" || command === "force_launch_sv2_profile") {
    previewProfiles.activeSlotId = String(args?.slotId ?? "");
    previewProfiles.slots.forEach((slot) => { slot.isActive = slot.id === previewProfiles.activeSlotId; });
    if (command === "force_launch_sv2_profile") previewProfiles.blockers = [];
    return {
      succeeded: true,
      summary: command === "force_launch_sv2_profile" ? "已结束占用进程、切换槽位并启动 SV2。" : "已切换槽位并启动 SV2。",
      detail: "预览模式",
    } as T;
  }
  if (command === "prepare_sv2_concurrent_profile") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) {
      slot.concurrent.ready = true;
      slot.concurrent.detail = "隔离副本已准备；本地变化不会自动覆盖普通槽位。";
    }
    return previewProfiles as T;
  }
  if (command === "accept_sv2_concurrent_disclaimer") {
    previewConcurrentDisclaimerAccepted = true;
    return previewState() as T;
  }
  if (command === "preview_svp_route") {
    const projectPath = String(args?.projectPath ?? "C:\\Projects\\demo.svp");
    return {
      projectPath,
      requiredVoices: [
        { name: "Mai 2", version: 104, backendType: "sv2" },
        { name: "SOLARIA", version: 101, backendType: "sv2" },
      ],
      candidates: previewProfiles.slots.map((slot, index) => ({
        slotId: slot.id,
        displayName: slot.displayName,
        idle: index > 0,
        launchMode: index > 0 ? "concurrent" as const : undefined,
        matchedVoices: slot.voiceInventory.authorizedVoices.filter((voice) => ["Mai 2", "SOLARIA"].includes(voice)),
        missingOrUnknownVoices: slot.voiceInventory.authorizedVoices.length ? [] : ["Mai 2", "SOLARIA"],
        exactAuthorizationMatch: slot.voiceInventory.authorizedVoices.length === 2,
        reason: index > 0 ? "账号授权未验证，需要人工确认。" : "本机检测到槽位占用，且账号授权未验证。",
      })),
      selectedSlotId: previewProfiles.slots[1]?.id,
      selectedLaunchMode: "concurrent",
      requiresConfirmation: true,
      summary: "需要确认用于打开工程的账号。",
      detail: "工程声库与账号授权没有完整的权威匹配结果；最终授权由 SV2 官方验证。",
    } as SvpRoutePlan as T;
  }
  if (command === "launch_svp_route") {
    return { succeeded: true, summary: "已按所选账号打开 .svp 工程。", detail: "预览模式" } as T;
  }
  if (command === "queue_component_install") {
    const componentId = String(args?.id ?? "");
    const componentName = previewState().components.find((item) => item.id === componentId)?.displayName ?? componentId;
    if (!previewDownloads.some((item) => item.componentId === componentId)) {
      previewDownloads.push({
        id: crypto.randomUUID(),
        componentId,
        displayName: componentName,
        status: "downloading",
        progress: 38,
        detail: "aria2 正在下载固定版本组件。",
        updatedAt: new Date().toISOString(),
      });
    }
    return previewDownloads as T;
  }
  if (command === "component_downloads") return previewDownloads as T;
  if (command === "open_downloaded_component") return { succeeded: true, summary: "已打开 Sandboxie 安装包位置。", detail: "预览模式" } as T;
  if (command === "list_workflow_recipes") return [
    { id: "project-doctor", title: "工程医生", description: "只读检查工程风险。", kind: "project-doctor", inputKind: "svp", supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} },
    { id: "pronunciation-check", title: "发音诊断", description: "检查歌词和音素风险。", kind: "pronunciation-check", inputKind: "svpOrText", supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} },
    { id: "render-quality-check", title: "渲染复检", description: "检查渲染交付风险。", kind: "render-quality-check", inputKind: "audio", supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} },
    { id: "lyric-template", title: "作词与押韵", description: "中文韵脚与歌曲结构模板。", kind: "lyric-template", inputKind: "lyrics", supportsBatch: false, requiresBridge: false, requiresAi: false, defaultParameters: { language: "zh-CN", rhymeMode: "family" } },
  ] as T;
  if (command === "list_creative_history" || command === "list_project_checkpoints") return [] as T;
  if (command === "create_project_checkpoint") return {
    id: crypto.randomUUID(), label: String(args?.label ?? "检查点"), sourcePath: String(args?.projectPath ?? ""),
    snapshotPath: "~/.SynthVcopilot/project-checkpoints/preview/project.svp", sourceSha256: "preview", sourceSize: 0, createdAtUtc: new Date().toISOString(),
  } as T;
  if (command === "restore_project_checkpoint") return { succeeded: true, summary: "检查点已恢复为新副本。", detail: "预览模式" } as T;
  if (command === "export_workflow_report") return {
    succeeded: true,
    summary: "工作流报告已导出。",
    detail: `预览路径：workflow-reports/preview-report.${args?.format === "json" ? "json" : "md"}`,
  } as T;
  if (command === "lookup_chinese_rhyme") {
    const query = String(args?.query ?? "ang");
    const characters = "昂盎邦帮膀榜傍磅蚌仓苍沧舱藏昌长常场厂唱倡畅肠偿尝当党档荡芳房防仿访放冈刚岗钢纲港杠光广逛杭航行巷慌黄皇凰恍晃荒江姜将浆疆讲奖匠康扛抗亢廊狼朗浪凉梁良两亮茫忙盲氓囊娘酿旁胖庞腔墙强抢枪襄湘乡香箱祥详响想向央扬杨洋阳仰养样张章彰樟涨掌仗丈帐障妆庄桩装壮状王望忘网往";
    return {
      language: "zh-CN",
      query,
      queryPinyin: /[\u3400-\u9fff]/u.test(query) ? ["guang"] : [],
      matchMode: (args?.matchMode as RhymeMatchMode | undefined) ?? "family",
      rhymeKeys: ["ang"],
      total: [...characters].length,
      characters: [...characters].map((character) => ({ character, pinyin: ["…ang"] })),
      coverageNote: "预览模式展示常用字子集；桌面后端会扫描内置拼音字典收录的全部 CJK 字符。",
    } as T;
  }
  if (command === "build_lyric_template") {
    const sections = (args?.sections as LyricSectionRequest[] | undefined) ?? [];
    const rhymeTargets = (args?.rhymeTargets as Record<string, string> | undefined) ?? {};
    const title = String(args?.title || "未命名歌曲");
    const built = sections.map((section) => ({
      ...section,
      lines: Array.from({ length: section.lineCount }, (_, index) => {
        const scheme = section.rhymeScheme || "-";
        const marker = scheme[index % scheme.length]?.toUpperCase() ?? "-";
        return { lineNumber: index + 1, rhymeLabel: marker === "-" ? null : marker, targetRhyme: rhymeTargets[marker] || null, placeholder: `${section.label} 第 ${index + 1} 句${marker === "-" ? "" : ` · ${marker} 韵`}` };
      }),
    }));
    const totalLines = sections.reduce((sum, section) => sum + section.lineCount, 0);
    return { kind: "lyric-template", summary: `已建立《${title}》的歌词结构：${sections.length} 个段落，共 ${totalLines} 行。`, data: { language: "zh-CN", title, totalLines, rhymeTargets, sections: built } } as T;
  }
  if (command === "generate_lyric_candidates") return {
    language: "zh-CN",
    brief: String((args?.request as LyricCandidateRequest | undefined)?.brief ?? ""),
    imagery: String((args?.request as LyricCandidateRequest | undefined)?.imagery ?? ""),
    sectionLabel: String((args?.request as LyricCandidateRequest | undefined)?.sectionLabel ?? "副歌"),
    targetRhyme: "ang",
    candidates: [
      { text: "旧月台还留着未熄的光", rhymeFoot: "光", rhymeMatched: true, note: "用月台承接离别，句尾落在 ang 韵。" },
      { text: "风把那封信吹回我身旁", rhymeFoot: "旁", rhymeMatched: true, note: "让旧信成为回望的动作线索。" },
      { text: "我把没说完的话装进行囊", rhymeFoot: "囊", rhymeMatched: true, note: "收束情绪，同时保留继续发展的空间。" },
      { text: "车窗外的故乡越来越长", rhymeFoot: "长", rhymeMatched: true, note: "用移动镜头扩大空间感。" },
    ],
  } as T;
  if (command === "sv2_sync_categories") return [
    { id: "userDictionaries", label: "用户词典", description: "仅同步用户词典文件；不包含账号或登录数据。", relativeRoots: ["dicts"] },
    { id: "scripts", label: "脚本", description: "同步用户安装或编写的脚本。", relativeRoots: ["scripts"] },
    { id: "presets", label: "预设", description: "同步用户预设子目录。", relativeRoots: ["presets"] },
    { id: "safeSettings", label: "安全设置", description: "仅同步明确允许的非账号设置子目录。", relativeRoots: ["settings/shortcuts", "settings/theme", "settings/ui"] },
  ] as T;
  if (command === "preview_sv2_selective_sync") return {
    version: 1, overwrite: Boolean(args?.overwrite), rootScope: "preview-root-scope", token: "preview-token",
    entries: [{ category: "userDictionaries", relativePath: "dicts/user.json", action: "copy", sourceSize: 128, sourceSha256: "preview" }],
  } as T;
  if (command === "execute_sv2_selective_sync") return { copied: 1, updated: 0, skipped: 0, conflicts: 0 } as T;
  if (command === "run_batch_workflow") return {
    recipeId: String(args?.recipeId ?? "project-doctor"), completed: (args?.inputPaths as unknown[] | undefined)?.length ?? 0, failed: 0,
    items: ((args?.inputPaths as string[] | undefined) ?? []).map((inputPath) => ({ inputPath, status: "completed", result: { kind: String(args?.recipeId ?? "batch"), summary: "预览批处理完成。", data: { preview: true } } })),
  } as T;
  if (command === "run_project_doctor" || command === "run_pronunciation_diagnostics") return {
    kind: command === "run_project_doctor" ? "project-doctor" : "pronunciation-check",
    summary: "预览诊断发现 1 个错误和 1 个警告。",
    data: {
      kind: command === "run_project_doctor" ? "project-doctor" : "pronunciation-check",
      ok: false,
      summary: "预览诊断发现 1 个错误和 1 个警告。",
      inspectedItems: 24,
      issues: [
        { code: "NOTE_TIMING_INVALID", severity: "error", message: "音符起点或时值无效。", location: "tracks[0].mainGroup.notes[3]", suggestion: "检查该音符的起止位置。" },
        { code: "LYRIC_EMPTY", severity: "warning", message: "音符歌词为空。", location: "tracks[0].mainGroup.notes[7]", suggestion: "补充歌词或确认这是有意的静音音符。" },
      ],
    },
  } as T;
  if (command === "run_render_review") return {
    kind: "render-quality-check",
    summary: "渲染复检通过，未发现交付阻断项。",
    data: {
      probe: { duration_sec: 183.2, bpm: 128, key_guess: "C#", peak_dbfs: -1.1, rms_dbfs: -14.8, clipped_sample_ratio: 0, silent_frame_ratio: 0.02 },
      report: { kind: "render-quality-check", ok: true, summary: "渲染复检通过。", inspectedItems: 8, issues: [] },
    },
  } as T;
  if (command === "list_conversations") return [] as T;
  if (command === "new_conversation") return { id: "preview", title: "新对话", messages: [] } as T;
  if (command === "open_conversation") return { id: "preview", title: "预览对话", messages: [] } as T;
  if (command === "send_message") return [{ role: "assistant", content: "这是本地视觉预览回复。" }] as T;
  if (command.startsWith("run_") || ["add_project_reference", "export_project_without_parameters", "export_project_lyrics"].includes(command)) return {
    kind: command.replace(/^run_/, "").replaceAll("_", "-"),
    summary: "预览工作流已完成。",
    outputPath: command === "run_game_to_midi"
      ? "~/.SynthVcopilot/output/game-vocal.mid"
      : command === "export_project_without_parameters"
        ? `~/.SynthVcopilot/output/${String(args?.outputName ?? "project_no_params.svp")}`
        : command === "export_project_lyrics"
          ? `~/.SynthVcopilot/output/${String(args?.outputName ?? "project.lrc")}`
          : undefined,
    data: { preview: true, command, parameters: args ?? {} },
  } as T;
  if (command === "review_workflow") return "结论：结果结构完整。\n风险：预览模式未执行真实组件。\n建议参数：发布构建中按实际素材复核。" as T;
  return { succeeded: true, summary: "预览操作已完成。", detail: "" } as T;
}

export const api = {
  bootstrap: () => call<BootstrapState>("bootstrap"),
  completeOnboarding: (mode: AppMode) => call<BootstrapState>("complete_onboarding", { mode }),
  setMode: (mode: AppMode) => call<BootstrapState>("set_mode", { mode }),
  saveModel: (baseUrl: string, model: string, token?: string) =>
    call<BootstrapState>("save_model_settings", { baseUrl, model, token: token || null }),
  scanSynthV: () => call<SynthVInstallation[]>("scan_synthv"),
  sv2ProfileState: () => call<Sv2ProfilesState>("sv2_profile_state"),
  sv2AccountPrecheck: () => call<Sv2AccountPrecheck>("sv2_account_precheck"),
  sv2AccountUsageSnapshot: () => call<Sv2AccountUsageSnapshot>("sv2_account_usage_snapshot"),
  sv2SyncCategories: () => call<Sv2SyncCategory[]>("sv2_sync_categories"),
  previewSv2SelectiveSync: (sourceSlotId: string, targetSlotId: string, categories: Sv2SyncCategoryId[], overwrite: boolean) =>
    call<Sv2SyncManifest>("preview_sv2_selective_sync", { sourceSlotId, targetSlotId, categories, overwrite }),
  executeSv2SelectiveSync: (sourceSlotId: string, targetSlotId: string, categories: Sv2SyncCategoryId[], approved: Sv2SyncManifest) =>
    call<Sv2SyncResult>("execute_sv2_selective_sync", { sourceSlotId, targetSlotId, categories, approved, token: approved.token }),
  importCurrentSv2Profile: (displayName: string) =>
    call<Sv2ProfilesState>("import_current_sv2_profile", { displayName }),
  createSv2Profile: (displayName: string) =>
    call<Sv2ProfilesState>("create_sv2_profile", { displayName }),
  renameSv2Profile: (slotId: string, displayName: string) =>
    call<Sv2ProfilesState>("rename_sv2_profile", { slotId, displayName }),
  updateSv2ConcurrentDefaults: (appSettings: boolean, voiceLibraries: boolean) =>
    call<Sv2ProfilesState>("update_sv2_concurrent_defaults", { appSettings, voiceLibraries }),
  updateSv2ConcurrentContent: (slotId: string, appSettings: Sv2IsolationPreference, voiceLibraries: Sv2IsolationPreference) =>
    call<Sv2ProfilesState>("update_sv2_concurrent_content", { slotId, appSettings, voiceLibraries }),
  activateSv2Profile: (slotId: string) =>
    call<Sv2ProfilesState>("activate_sv2_profile", { slotId }),
  forceActivateSv2Profile: (slotId: string) =>
    call<Sv2ProfilesState>("force_activate_sv2_profile", { slotId }),
  launchSv2Profile: (slotId: string, projectPath?: string) =>
    call<OperationResult>("launch_sv2_profile", { slotId, projectPath: projectPath || null }),
  forceLaunchSv2Profile: (slotId: string, projectPath?: string) =>
    call<OperationResult>("force_launch_sv2_profile", { slotId, projectPath: projectPath || null }),
  openSv2ProfileFolder: (slotId: string) =>
    call<OperationResult>("open_sv2_profile_folder", { slotId }),
  prepareSv2ConcurrentProfile: (slotId: string) =>
    call<Sv2ProfilesState>("prepare_sv2_concurrent_profile", { slotId }),
  launchSv2ConcurrentProfile: (slotId: string, projectPath?: string) =>
    call<OperationResult>("launch_sv2_concurrent_profile", { slotId, projectPath: projectPath || null }),
  previewSvpRoute: (projectPath: string) =>
    call<SvpRoutePlan>("preview_svp_route", { projectPath }),
  launchSvpRoute: (slotId: string, projectPath: string, mode: SvpLaunchMode) =>
    call<OperationResult>("launch_svp_route", { slotId, projectPath, mode }),
  setSvpLaunchRouting: (enabled: boolean) =>
    call<BootstrapState>("set_svp_launch_routing", { enabled }),
  openSvpDefaultAppsSettings: () =>
    call<OperationResult>("open_svp_default_apps_settings"),
  acceptSv2ConcurrentDisclaimer: () =>
    call<BootstrapState>("accept_sv2_concurrent_disclaimer"),
  openSv2ConcurrentFolder: (slotId: string) =>
    call<OperationResult>("open_sv2_concurrent_folder", { slotId }),
  saveScriptsPath: (scriptsPath: string) => call<BootstrapState>("save_scripts_path", { scriptsPath }),
  installBridge: (scriptsPath: string) => call<OperationResult>("install_bridge", { scriptsPath }),
  diagnoseBridge: (scriptsPath: string) => call<OperationResult>("diagnose_bridge", { scriptsPath }),
  connectBridge: () => call<OperationResult>("connect_bridge"),
  componentDownloads: () => call<ComponentDownload[]>("component_downloads"),
  queueComponentInstall: (id: string) => call<ComponentDownload[]>("queue_component_install", { id }),
  openDownloadedComponent: (id: string) => call<OperationResult>("open_downloaded_component", { id }),
  listWorkflowRecipes: () => call<WorkflowRecipe[]>("list_workflow_recipes"),
  listCreativeHistory: (limit = 50) => call<CreativeHistoryEntry[]>("list_creative_history", { limit }),
  createProjectCheckpoint: (projectPath: string, label: string) =>
    call<ProjectCheckpoint>("create_project_checkpoint", { projectPath, label }),
  listProjectCheckpoints: (limit = 50) => call<ProjectCheckpoint[]>("list_project_checkpoints", { limit }),
  restoreProjectCheckpoint: (id: string, outputName: string) =>
    call<OperationResult>("restore_project_checkpoint", { id, outputName }),
  exportWorkflowReport: (kind: string, summary: string, data: Record<string, unknown>, format: "markdown" | "json") =>
    call<OperationResult>("export_workflow_report", { kind, summary, data, format }),
  lookupChineseRhyme: (query: string, matchMode: RhymeMatchMode) =>
    call<ChineseRhymeLookup>("lookup_chinese_rhyme", { query, matchMode }),
  buildLyricTemplate: (language: "zh-CN", title: string, sections: LyricSectionRequest[], rhymeTargets: Record<string, string>) =>
    call<WorkflowResult>("build_lyric_template", { language, title, sections, rhymeTargets }),
  generateLyricCandidates: (request: LyricCandidateRequest) =>
    call<LyricCandidateSet>("generate_lyric_candidates", { request }),
  runProjectDoctor: (projectPath: string) =>
    call<WorkflowResult>("run_project_doctor", { projectPath }),
  runPronunciationDiagnostics: (projectPath?: string, lyrics?: string) =>
    call<WorkflowResult>("run_pronunciation_diagnostics", { projectPath: projectPath || null, lyrics: lyrics || null }),
  runRenderReview: (audioPath: string, expectedDurationSec?: number, expectedBpm?: number, requireNotes = false, advanced = false) =>
    call<WorkflowResult>("run_render_review", { audioPath, expectedDurationSec: expectedDurationSec ?? null, expectedBpm: expectedBpm ?? null, requireNotes, advanced }),
  runAudioToProject: (vocalPath: string, instrumentalPath: string, outputName: string, tolerance: number, advanced: boolean, importToSynthv: boolean, rightsConfirmed: boolean, trackIndex: number, groupName: string) =>
    call<WorkflowResult>("run_audio_to_project", { vocalPath, instrumentalPath, outputName, tolerance, advanced, importToSynthv, rightsConfirmed, trackIndex, groupName }),
  runRetakeWorkbench: (trackIndex: number, groupIndex: number, noteIndex: number, operation: string, takeId: number | undefined, newDuration: boolean, newPitch: boolean, newTimbre: boolean, activate: boolean) =>
    call<WorkflowResult>("run_retake_workbench", { trackIndex, groupIndex, noteIndex, operation, takeId: takeId ?? null, newDuration, newPitch, newTimbre, activate }),
  runBatchWorkflow: (recipeId: string, inputPaths: string[], options: Record<string, unknown>) =>
    call<BatchWorkflowResult>("run_batch_workflow", { recipeId, inputPaths, options }),
  runAudioProbe: (audioPath: string, advanced: boolean) =>
    call<WorkflowResult>("run_audio_probe", { audioPath, advanced }),
  runGameToMidi: (vocalPath: string, instrumentalPath: string, outputName: string, tolerance: number, advanced: boolean) =>
    call<WorkflowResult>("run_game_to_midi", { vocalPath, instrumentalPath, outputName, tolerance, advanced }),
  runProjectProbe: (projectPath: string) =>
    call<WorkflowResult>("run_project_probe", { projectPath }),
  addProjectReference: (projectPath: string, audioPath: string, trackName: string, beginSeconds: number, outputName: string) =>
    call<WorkflowResult>("add_project_reference", { projectPath, audioPath, trackName, beginSeconds, outputName }),
  exportProjectWithoutParameters: (projectPath: string, outputName: string) =>
    call<WorkflowResult>("export_project_without_parameters", { projectPath, outputName }),
  exportProjectLyrics: (projectPath: string, trackIndex: number, lineGapSeconds: number, outputName: string, wordOutputName: string) =>
    call<WorkflowResult>("export_project_lyrics", { projectPath, trackIndex, lineGapSeconds, outputName, wordOutputName }),
  reviewWorkflow: (kind: string, data: Record<string, unknown>) =>
    call<string>("review_workflow", { kind, data }),
  listConversations: () => call<ConversationSummary[]>("list_conversations"),
  newConversation: () => call<ConversationSnapshot>("new_conversation"),
  openConversation: (id: string) => call<ConversationSnapshot>("open_conversation", { id }),
  sendMessage: (input: string) => call<ChatMessage[]>("send_message", { input }),
  saveMcpServer: (server: McpServerConfig) => call<BootstrapState>("save_mcp_server", { server }),
  deleteMcpServer: (id: string) => call<BootstrapState>("delete_mcp_server", { id }),
  testMcpServer: (id: string) => call<OperationResult>("test_mcp_server", { id }),
};
