import type { IconName } from "./icons";

export interface FeatureCatalogItem {
  id: string;
  title: string;
  description: string;
  icon: IconName;
  accent: string;
  base: string[];
  ai: string[];
  requirements: string[];
  componentIds?: string[];
  requiresConnectedBridge?: boolean;
  windowsOnly?: boolean;
}

export const featureCatalog: FeatureCatalogItem[] = [
  { id: "game-midi", title: "演唱音频 → MIDI", description: "对齐演唱与伴奏音频，提取可编辑的单音旋律、节奏与力度，导出标准 MIDI。", icon: "audio", accent: "violet", base: ["音高与节奏提取", "确定性量化", "标准 MIDI 导出"], ai: ["偏差自动纠正", "低置信片段复核", "量化参数建议"], requirements: ["FFmpeg", "pi-audio"], componentIds: ["ffmpeg", "pi-audio"] },
  { id: "audio-insight", title: "音频结构分析", description: "提取速度、拍点、调性、能量和频谱趋势，为编曲、调声与复检建立可追溯依据。", icon: "waveform", accent: "blue", base: ["BPM / 拍点 / 调性", "能量与频谱曲线", "结构化分析报告"], ai: ["段落与风格归纳", "异常片段解释", "制作方向建议"], requirements: ["FFmpeg", "pi-audio"], componentIds: ["ffmpeg", "pi-audio"] },
  { id: "project-tools", title: "SynthV 工程工具", description: "只读探测工程结构，生成参考轨或无参安全副本，并导出普通 LRC 与逐字 LRC。", icon: "file", accent: "emerald", base: ["工程结构探测", "安全副本生成", "双格式歌词导出"], ai: ["工程风险说明", "变更方案草拟", "批量结果复核"], requirements: ["CVRS"], componentIds: ["cvrs"] },
  { id: "bridge-tools", title: "SynthV Bridge", description: "在明确的工具权限内连接 Synthesizer V Studio，读取状态、执行编辑并验证结果。", icon: "bridge", accent: "orange", base: ["安装与连接诊断", "实时状态读取", "受控工程操作"], ai: ["Copilot 工具调用", "多步骤任务编排", "操作后自检"], requirements: ["Node.js", "SynthV Bridge"] },
  { id: "audio-to-project", title: "音频到工程", description: "从时间轴一致的演唱版与伴奏版提取单音旋律，保留 MIDI 检查点，并可安全导入当前 SynthV 工程。", icon: "pipeline", accent: "violet", base: ["配对音频差分", "受管理 MIDI 检查点", "Bridge 单音导入"], ai: ["候选参数寻优", "低置信音符纠正", "导入结果复核"], requirements: ["FFmpeg", "pi-audio", "Bridge（可选）"], componentIds: ["ffmpeg", "pi-audio"] },
  { id: "project-doctor", title: "工程医生", description: "离线扫描工程版本、音符、歌词、引用与参数曲线，生成只读且可定位的问题报告。", icon: "doctor", accent: "emerald", base: ["结构完整性检查", "音符与引用诊断", "确定性风险分级"], ai: ["问题影响解释", "修复优先级建议", "保守变更方案"], requirements: ["本地 .svp"] },
  { id: "checkpoints", title: "历史与检查点", description: "记录每次工作流的参数和结果，并为关键 .svp 建立哈希检查点，只恢复为新的安全副本。", icon: "history", accent: "blue", base: ["工作流追溯", "工程哈希检查点", "不覆盖恢复副本"], ai: ["变化语义归纳", "异常回归定位", "恢复点建议"], requirements: ["本地存储"] },
  { id: "batch-recipes", title: "批处理配方", description: "将工程体检、发音检查、渲染复检、结构探测与无参导出应用到一组文件。", icon: "recipe", accent: "orange", base: ["内置安全配方", "最多 100 项串行执行", "单项失败隔离"], ai: ["失败原因归类", "批次结果总结", "参数优化建议"], requirements: ["对应本地组件"] },
  { id: "selective-sync", title: "账号资源同步", description: "在账号槽位间选择性同步词典、脚本、预设和安全设置，登录态与声库数据库始终排除。", icon: "sync", accent: "violet", base: ["白名单类别", "SHA-256 差异预览", "冲突与过期清单保护"], ai: ["冲突影响解释", "同步范围建议", "同步后复核"], requirements: ["Windows", "至少两个槽位"], windowsOnly: true },
  { id: "retake-compare", title: "Retake A/B 工作台", description: "读取单个音符的 Retake 候选，生成音高、时值或音色变化，并在新鲜度校验通过后切换或清理。", icon: "compare", accent: "blue", base: ["候选读取", "三维 Retake 生成", "安全切换与删除"], ai: ["候选差异总结", "听感目标建议", "保留方案解释"], requirements: ["SynthV Bridge"], requiresConnectedBridge: true },
  { id: "lyric-studio", title: "作词与押韵", description: "按汉字或拼音韵母检索中文同韵字，编排主歌、副歌与桥段结构，并在 Copilot 模式下根据意象生成原创候选句。", icon: "lyrics", accent: "violet", base: ["中文韵脚全字检索", "歌曲段落结构", "A/B/C 押韵格式"], ai: ["意象与主题候选", "多版本歌词草案", "真实句尾押韵复核"], requirements: ["内置中文拼音字典"] },
  { id: "pronunciation-doctor", title: "发音诊断", description: "检查工程或粘贴歌词中的空音节、多音节拥挤、混合文字与极短音符风险。", icon: "pronunciation", accent: "emerald", base: ["歌词结构检查", "短音符发音风险", "确定性问题定位"], ai: ["发音问题解释", "音素修正建议", "跨语言复核"], requirements: ["本地 .svp 或歌词"] },
  { id: "render-review", title: "渲染复检", description: "渲染后检查削波、静音和响度突变，并按预期时长、BPM 与音高事件集中确认交付风险。", icon: "shield", accent: "orange", base: ["削波与静音检测", "响度连续性检查", "交付清单"], ai: ["可疑片段归因", "风险等级说明", "复检结论摘要"], requirements: ["FFmpeg", "pi-audio"], componentIds: ["ffmpeg", "pi-audio"] },
];
