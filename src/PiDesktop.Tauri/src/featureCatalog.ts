import { addMessages, t } from "./i18n";
import { englishFeatureMessages, englishGroupMessages } from "./featureMessages";
import type { IconName } from "./icons";

export interface FeatureCatalogItem {
  id: string;
  title: string;
  description: string;
  icon: IconName;
  accent: string;
  homePriority?: number;
  base: string[];
  ai: string[];
  requirements: string[];
  componentIds?: string[];
  requiresConnectedBridge?: boolean;
  windowsOnly?: boolean;
}

export interface ToolGroup {
  id: "import" | "convert" | "analysis" | "quality";
  title: string;
  description: string;
  icon: IconName;
  accent: string;
  featureIds: string[];
}

const featureDefinitions: FeatureCatalogItem[] = [
  { id: "cover", title: "一键 Cover", description: "从 BV 或 YouTube 来源完成 Cover，并导入当前 SynthV 工程。", icon: "sparkles", accent: "violet", homePriority: 1, base: ["来源音频处理", "旋律 MIDI 与歌词", "导入当前工程"], ai: ["快捷指令编排", "指定声库授权提示", "失败阶段解释与重试"], requirements: ["媒体导入器", "人声伴奏分离", "pi-audio", "SynthV Bridge"], componentIds: ["media-fetcher", "vocal-separation", "pi-audio", "ffmpeg"], requiresConnectedBridge: false },
  { id: "tuning-learning", title: "分声库调声学习", description: "从参考人声提取演唱特征，为每个声库独立学习并应用有边界的调声参数。", icon: "waveform", accent: "emerald", homePriority: 2, base: ["离线演唱特征", "分声库档案", "A/B 反馈更新"], ai: ["自动参数建议", "Bridge 安全应用", "Solo 迭代基础"], requirements: ["pi-audio", "SynthV Bridge（应用时）"], componentIds: ["pi-audio"] },
  { id: "media-import", title: "BV / YouTube 音频导入", description: "预览明确提供的 Bilibili 或 YouTube 来源，并在权利确认后下载为受管理 WAV。", icon: "download", accent: "blue", homePriority: 2, base: ["BV / URL 元数据预览", "受管 WAV 与 SHA-256", "来源与权利确认记录"], ai: ["后续自动分离与 Cover 编排", "来源结构说明", "失败原因归类"], requirements: ["media-fetcher", "FFmpeg", "Node.js 22+"], componentIds: ["media-fetcher", "ffmpeg"] },
  { id: "source-separation", title: "人声 / 伴奏分离", description: "将混合音频分离为人声和伴奏，便于后续编辑。", icon: "audio", accent: "violet", homePriority: 3, base: ["人声与伴奏双轨", "稳定的输出文件", "可用于后续处理"], ai: ["自动接入 Cover 工作流", "分离结果复检", "模型运行失败解释"], requirements: ["人声伴奏分离组件", "FFmpeg"], componentIds: ["vocal-separation", "ffmpeg"] },
  { id: "score-to-synthv", title: "曲谱导入 SynthV", description: "把本地 MIDI 或 MusicXML 曲谱安全转换为当前 SynthV 工程中的单声部音符组。", icon: "file", accent: "emerald", homePriority: 1, base: ["MIDI / MusicXML 读取", "单声部音符转换", "导入前文件指纹校验"], ai: ["声部选择建议", "导入结果复核", "后续调声规划"], requirements: ["SynthV Bridge"], requiresConnectedBridge: true },
  { id: "audio-to-project", title: "演唱音频 → MIDI / SynthV", description: "从演唱音频提取单音旋律、歌词与音素；伴奏可选，可只导出 MIDI，也可继续导入当前 SynthV 工程。", icon: "pipeline", accent: "violet", homePriority: 4, base: ["可选伴奏辅助分离", "旋律、歌词与音素 MIDI 标记", "可选 Bridge 导入"], ai: ["候选参数寻优", "低置信音符纠正", "导入结果复核"], requirements: ["FFmpeg", "pi-audio", "Bridge（可选）"], componentIds: ["ffmpeg", "pi-audio"] },
  { id: "audio-preparation", title: "音频准备", description: "将本地音频转换为适合 SynthV 使用的格式，并在需要时检查或调整响度。", icon: "audio", accent: "violet", base: ["音频信息检查", "格式转换", "响度调整"], ai: ["参数建议", "结果复核", "交付风险提示"], requirements: ["FFmpeg"], componentIds: ["ffmpeg"] },
  { id: "audio-insight", title: "音频结构分析", description: "提取速度、拍点、调性、能量和频谱趋势，为编曲、调声与复检建立可追溯依据。", icon: "waveform", accent: "blue", homePriority: 3, base: ["BPM / 拍点 / 调性", "能量与频谱曲线", "结构化分析报告"], ai: ["段落与风格归纳", "异常片段解释", "制作方向建议"], requirements: ["FFmpeg", "pi-audio"], componentIds: ["ffmpeg", "pi-audio"] },
  { id: "project-tools", title: "SV 工程文件", description: "只读探测已保存的 .svp，生成参考轨或无参安全副本，并导出普通 LRC 与逐字 LRC。", icon: "file", accent: "blue", base: ["工程结构探测", "安全副本生成", "LRC / 逐字 LRC"], ai: ["工程风险说明", "变更方案草拟", "批量结果复核"], requirements: ["CVRS"], componentIds: ["cvrs"] },
  { id: "ab-audition", title: "片段 A/B 检查", description: "定位并捕获 SynthV 的短试听片段，自动消除回环延迟后比较修改前后差异，避免重复完整渲染。", icon: "compare", accent: "violet", base: ["进程级音频捕获", "播放头恢复与中断校验", "快速 A/B 对齐比较"], ai: ["局部修改复检", "差异指标解释", "连续候选筛选"], requirements: ["Windows 10 20348+", "SynthV Bridge"], requiresConnectedBridge: true, windowsOnly: true },
  { id: "retake-compare", title: "Retake 工作台", description: "读取单个音符的 Retake 候选，生成音高、时值或音色变化，并在新鲜度校验通过后切换或清理。", icon: "compare", accent: "blue", base: ["候选读取", "三维 Retake 生成", "安全切换与删除"], ai: ["候选差异总结", "听感目标建议", "保留方案解释"], requirements: ["SynthV Bridge"], requiresConnectedBridge: true },
  { id: "project-doctor", title: "工程诊断", description: "离线扫描工程版本、音符、歌词、引用与参数曲线，生成只读且可定位的问题报告。", icon: "doctor", accent: "emerald", base: ["结构完整性检查", "音符与引用诊断", "确定性风险分级"], ai: ["问题影响解释", "修复优先级建议", "保守变更方案"], requirements: ["本地 .svp"] },
  { id: "pronunciation-doctor", title: "发音诊断", description: "检查工程或粘贴歌词中的空音节、多音节拥挤、混合文字与极短音符风险。", icon: "pronunciation", accent: "emerald", base: ["歌词结构检查", "短音符发音风险", "确定性问题定位"], ai: ["发音问题解释", "音素修正建议", "跨语言复核"], requirements: ["本地 .svp 或歌词"] },
  { id: "render-review", title: "渲染复检", description: "渲染后检查削波、静音和响度突变，并按预期时长、BPM 与音高事件集中确认交付风险。", icon: "shield", accent: "orange", base: ["削波与静音检测", "响度连续性检查", "交付清单"], ai: ["可疑片段归因", "风险等级说明", "复检结论摘要"], requirements: ["FFmpeg", "pi-audio"], componentIds: ["ffmpeg", "pi-audio"] },
  { id: "batch-recipes", title: "批处理", description: "将工程体检、发音检查、渲染复检、结构探测与无参导出应用到一组文件。", icon: "recipe", accent: "orange", base: ["内置安全配方", "最多 100 项串行执行", "单项失败隔离"], ai: ["失败原因归类", "批次结果总结", "参数优化建议"], requirements: ["对应本地组件"] },
  { id: "selective-sync", title: "账号资源同步", description: "在账号槽位间选择性同步词典、脚本、预设和安全设置，登录态与声库数据库始终排除。", icon: "sync", accent: "violet", base: ["白名单类别", "SHA-256 差异预览", "冲突与过期清单保护"], ai: ["冲突影响解释", "同步范围建议", "同步后复核"], requirements: ["Windows", "至少两个槽位"], windowsOnly: true },
];

const groupDefinitions: ToolGroup[] = [
  {
    id: "import",
    title: "导入",
    description: "从一个来源开始完成 Cover 工作流。",
    icon: "import",
    accent: "violet",
    featureIds: ["cover"],
  },
  {
    id: "convert",
    title: "转换",
    description: "处理音频、提取旋律，或准备可继续编辑的素材。",
    icon: "pipeline",
    accent: "violet",
    featureIds: ["source-separation", "audio-to-project", "audio-preparation"],
  },
  {
    id: "analysis",
    title: "分析",
    description: "了解人声表现与音频结构，为下一步创作提供依据。",
    icon: "waveform",
    accent: "blue",
    featureIds: ["tuning-learning", "audio-insight"],
  },
  {
    id: "quality",
    title: "质检",
    description: "检查工程、发音和渲染结果，定位需要处理的问题。",
    icon: "doctor",
    accent: "emerald",
    featureIds: ["project-doctor", "pronunciation-doctor", "render-review"],
  },
];

addMessages("zh-CN", {
  features: Object.fromEntries(featureDefinitions.map(({ id, title, description, base, ai, requirements }) => [id, { title, description, base, ai, requirements }])),
  groups: Object.fromEntries(groupDefinitions.map(({ id, title, description }) => [id, { title, description }])),
});
addMessages("en", { features: englishFeatureMessages, groups: englishGroupMessages });

export const featureCatalog: FeatureCatalogItem[] = featureDefinitions.map((feature) => ({
  ...feature,
  get title() { return t(`features.${feature.id}.title`); },
  get description() { return t(`features.${feature.id}.description`); },
  get base() { return feature.base.map((_, index) => t(`features.${feature.id}.base.${index}`)); },
  get ai() { return feature.ai.map((_, index) => t(`features.${feature.id}.ai.${index}`)); },
  get requirements() { return feature.requirements.map((_, index) => t(`features.${feature.id}.requirements.${index}`)); },
}));

export const guiFeatureIds = new Set(groupDefinitions.flatMap((group) => group.featureIds));
export const guiFeatureCatalog = featureCatalog.filter((feature) => guiFeatureIds.has(feature.id));

export const toolGroups: ToolGroup[] = groupDefinitions.map((group) => ({
  ...group,
  get title() { return t(`groups.${group.id}.title`); },
  get description() { return t(`groups.${group.id}.description`); },
}));
