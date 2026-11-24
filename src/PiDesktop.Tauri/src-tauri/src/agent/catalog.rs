use serde::{Deserialize, Serialize};

/// 可安装/可调用的组件类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComponentKind {
    /// ffmpeg：音视频转码/抽取，所有音频前处理的基础。
    Ffmpeg,
    /// 本地 whisper：离线语音识别，把人声转成带时间戳的词。
    WhisperLocal,
    /// Game 音高识别模型：从演唱/Game 音频提取音高轮廓。
    GamePitchModel,
    /// Transformer 人声分离：从混音里分出人声/伴奏 stem（Demucs 类）。
    VocalSeparation,
    /// 乐器识别：识别混音/stem 里出现了哪些乐器。
    InstrumentRecognition,
    /// 曲风/歌曲风格识别。
    GenreStyleRecognition,
    /// 拍数/速度检测（BPM、beat、downbeat）。
    TempoBeatDetection,
    /// Sound→(含词)MIDI：音频(+词时间轴)转成带音节歌词的 MIDI；也支持直接导入。
    SoundToMidi,
    /// pi-audio 音频探针：特征指纹 + PANNs 判别(乐器/genre倾向/有词无词) + 配对差分。
    AudioProbe,
    /// CVRS 工程工具：.svp 探测、安全副本、无参导出与 LRC。
    Cvrs,
    /// 受管 yt-dlp：显式 URL 的元数据读取与媒体导入。
    MediaFetcher,
}

/// 谁能用这个组件：AI agent、人工（桌面 UI 直接点），或两者。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Audience {
    Ai,
    Human,
    Both,
}

/// 一个组件的静态描述。URL/哈希留空由清单/设置填充。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentSpec {
    pub id: String,
    pub kind: ComponentKind,
    pub display_name: String,
    pub description: String,
    pub version: String,
    /// 面向对象：game/音高等分析模型对 AI 与人工都开放（Both）。
    pub audience: Audience,
    #[serde(default)]
    pub download_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_relative_path: Option<String>,
}

/// 组件安装状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComponentState {
    NotInstalled,
    Downloading,
    Installing,
    Ready,
    Failed,
}

/// Sound→MIDI 请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundToMidiRequest {
    pub audio_path: String,
    pub output_midi_path: String,
    #[serde(default = "default_true")]
    pub include_lyrics: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyrics_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

fn default_true() -> bool {
    true
}

/// 一次音频分析的聚合结果（乐器 / 曲风 / 速度拍点）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioAnalysis {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub beats_seconds: Vec<f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instruments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
}

/// 内置组件目录。桌面「组件」页面与 AI 工具列表都从这里读。
pub fn default_catalog() -> Vec<ComponentSpec> {
    fn spec(
        id: &str,
        kind: ComponentKind,
        name: &str,
        desc: &str,
        audience: Audience,
    ) -> ComponentSpec {
        ComponentSpec {
            id: id.to_string(),
            kind,
            display_name: name.to_string(),
            description: desc.to_string(),
            version: "latest".to_string(),
            audience,
            download_url: String::new(),
            sha256: None,
            executable_relative_path: None,
        }
    }
    vec![
        spec("ffmpeg", ComponentKind::Ffmpeg, "FFmpeg",
             "音视频转码与抽取；分离/识别/Sound→MIDI 的前处理基础。", Audience::Both),
        spec("whisper-local", ComponentKind::WhisperLocal, "Whisper（本地）",
             "离线语音识别，把人声转成带时间戳的词，喂给 Sound→MIDI 的词轨。", Audience::Both),
        spec("game-pitch", ComponentKind::GamePitchModel, "Game 音高识别模型",
             "从演唱或 Game 音频提取音高轮廓；AI 与人工均可调用。", Audience::Both),
        spec("vocal-separation", ComponentKind::VocalSeparation, "人声分离（Transformer）",
             "从混音分出人声/伴奏 stem（Demucs 类 transformer 模型）。", Audience::Both),
        spec("instrument-id", ComponentKind::InstrumentRecognition, "乐器识别",
             "识别混音/stem 里的乐器构成。", Audience::Both),
        spec("genre-id", ComponentKind::GenreStyleRecognition, "曲风识别",
             "识别歌曲风格/流派，辅助选唱法与编曲判断。", Audience::Both),
        spec("tempo-beat", ComponentKind::TempoBeatDetection, "速度与拍点检测",
             "检测 BPM、beat、downbeat（拍数），供对齐与量化。", Audience::Both),
        spec("sound-to-midi", ComponentKind::SoundToMidi, "Sound→MIDI（含词）",
             "音频(+词时间轴)转带音节歌词 MIDI；也支持直接导入 MIDI/MusicXML。", Audience::Both),
        spec("pi-audio", ComponentKind::AudioProbe, "pi-audio 音频探针",
             "Toolbox 内置 components/pi-audio：probe(特征指纹+PANNs 乐器/genre倾向/有词无词判别) 与 \
              pair-diff(有词/无词配对差分→单音人声轨，可直喂 SV import)。风格命名留给上层 LLM。",
             Audience::Both),
        spec("cvrs", ComponentKind::Cvrs, "CVRS 工程工具",
             "Toolbox 内置 components/cvrs：.svp 文件级工具。支持版本/轨道探测、静音参考轨副本、无参工程副本，\
              以及按选定轨道生成普通 LRC 和逐字 LRC；所有写入均生成副本，不覆盖源工程。",
             Audience::Both),
        spec("media-fetcher", ComponentKind::MediaFetcher, "媒体导入器",
             "固定版本 yt-dlp，用于用户明确提供的 Bilibili/YouTube URL 元数据预览与受管音频导入。",
             Audience::Both),
    ]
}
