use std::collections::{BTreeMap, BTreeSet};

use pinyin::ToPinyinMulti;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::workflows::WorkflowResult;

const MAX_QUERY_CHARS: usize = 24;
const MAX_SECTIONS: usize = 40;
const MAX_TOTAL_LINES: usize = 256;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RhymeMatchMode {
    Family,
    Exact,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhymeCharacter {
    pub character: String,
    pub pinyin: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChineseRhymeLookup {
    pub language: &'static str,
    pub query: String,
    pub query_pinyin: Vec<String>,
    pub match_mode: &'static str,
    pub rhyme_keys: Vec<String>,
    pub total: usize,
    pub characters: Vec<RhymeCharacter>,
    pub coverage_note: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricSectionRequest {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub line_count: usize,
    #[serde(default)]
    pub rhyme_scheme: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLineSlot {
    pub line_number: usize,
    pub rhyme_label: Option<String>,
    pub target_rhyme: Option<String>,
    pub placeholder: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricTemplateSection {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub line_count: usize,
    pub rhyme_scheme: String,
    pub lines: Vec<LyricLineSlot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricTemplate {
    pub language: &'static str,
    pub title: String,
    pub total_lines: usize,
    pub rhyme_targets: BTreeMap<String, String>,
    pub sections: Vec<LyricTemplateSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricCandidateRequest {
    pub language: String,
    pub brief: String,
    #[serde(default)]
    pub imagery: String,
    #[serde(default)]
    pub section_label: String,
    #[serde(default)]
    pub tone: String,
    #[serde(default)]
    pub target_rhyme: String,
    pub candidate_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricCandidate {
    pub text: String,
    pub rhyme_foot: Option<String>,
    pub rhyme_matched: Option<bool>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricCandidateSet {
    pub language: &'static str,
    pub brief: String,
    pub imagery: String,
    pub section_label: String,
    pub target_rhyme: Option<String>,
    pub candidates: Vec<LyricCandidate>,
}

#[derive(Debug, Deserialize)]
struct RawLyricCandidateSet {
    candidates: Vec<RawLyricCandidate>,
}

#[derive(Debug, Deserialize)]
struct RawLyricCandidate {
    text: String,
    #[serde(default)]
    note: String,
}

pub fn lookup_chinese_rhyme(
    query: &str,
    match_mode: RhymeMatchMode,
) -> Result<ChineseRhymeLookup, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
        return Err("请输入一个汉字、词尾或不超过 24 个字符的拼音韵母。".to_string());
    }
    let (query_pinyin, exact_finals) = resolve_query(query)?;
    let target_keys = exact_finals
        .iter()
        .map(|final_name| match match_mode {
            RhymeMatchMode::Family => rhyme_family(final_name).to_string(),
            RhymeMatchMode::Exact => final_name.clone(),
        })
        .collect::<BTreeSet<_>>();
    if target_keys.is_empty() {
        return Err("没有识别出可查询的中文韵脚。".to_string());
    }

    let mut characters = Vec::new();
    for (start, end) in cjk_ranges() {
        for codepoint in start..=end {
            let Some(character) = char::from_u32(codepoint) else {
                continue;
            };
            let Some(readings) = character.to_pinyin_multi() else {
                continue;
            };
            let matching = readings
                .into_iter()
                .filter_map(|reading| {
                    let plain = reading.plain().to_string();
                    let final_name = syllable_final(&plain)?;
                    let key = match match_mode {
                        RhymeMatchMode::Family => rhyme_family(&final_name),
                        RhymeMatchMode::Exact => final_name.as_str(),
                    };
                    target_keys.contains(key).then_some(plain)
                })
                .collect::<BTreeSet<_>>();
            if !matching.is_empty() {
                characters.push(RhymeCharacter {
                    character: character.to_string(),
                    pinyin: matching.into_iter().collect(),
                });
            }
        }
    }

    Ok(ChineseRhymeLookup {
        language: "zh-CN",
        query: query.to_string(),
        query_pinyin,
        match_mode: match match_mode {
            RhymeMatchMode::Family => "family",
            RhymeMatchMode::Exact => "exact",
        },
        rhyme_keys: target_keys.into_iter().collect(),
        total: characters.len(),
        characters,
        coverage_note:
            "结果包含内置 pinyin-data 字典收录的全部 CJK 字符；多音字只要任一读音命中就会列出。",
    })
}

pub fn build_lyric_template(
    language: &str,
    title: &str,
    sections: Vec<LyricSectionRequest>,
    rhyme_targets: BTreeMap<String, String>,
) -> Result<WorkflowResult, String> {
    if language != "zh-CN" {
        return Err("当前版本只开放简体中文作词模式。".to_string());
    }
    if sections.is_empty() || sections.len() > MAX_SECTIONS {
        return Err("歌曲结构需要 1 到 40 个段落。".to_string());
    }
    let title = title.trim();
    if title.chars().count() > 120 {
        return Err("歌曲标题不能超过 120 个字符。".to_string());
    }
    let normalized_targets = normalize_rhyme_targets(rhyme_targets)?;
    let mut total_lines = 0usize;
    let mut built_sections = Vec::with_capacity(sections.len());
    for section in sections {
        validate_section_id(&section.id)?;
        validate_section_kind(&section.kind)?;
        let label = section.label.trim();
        if label.is_empty() || label.chars().count() > 60 {
            return Err("段落名称不能为空且不能超过 60 个字符。".to_string());
        }
        if !(1..=32).contains(&section.line_count) {
            return Err("每个段落需要 1 到 32 行。".to_string());
        }
        total_lines += section.line_count;
        if total_lines > MAX_TOTAL_LINES {
            return Err("整首歌曲不能超过 256 行。".to_string());
        }
        let scheme = normalize_scheme(&section.rhyme_scheme)?;
        let scheme_chars = scheme.chars().collect::<Vec<_>>();
        let lines = (0..section.line_count)
            .map(|index| {
                let marker = scheme_chars[index % scheme_chars.len()];
                let rhyme_label = (marker != '-').then(|| marker.to_string());
                let target_rhyme = rhyme_label
                    .as_ref()
                    .and_then(|label| normalized_targets.get(label))
                    .cloned();
                let suffix = match (&rhyme_label, &target_rhyme) {
                    (Some(label), Some(target)) => format!(" · {label} 韵 / {target}"),
                    (Some(label), None) => format!(" · {label} 韵"),
                    _ => String::new(),
                };
                LyricLineSlot {
                    line_number: index + 1,
                    rhyme_label,
                    target_rhyme,
                    placeholder: format!("{} 第 {} 句{}", label, index + 1, suffix),
                }
            })
            .collect();
        built_sections.push(LyricTemplateSection {
            id: section.id,
            kind: section.kind,
            label: label.to_string(),
            line_count: section.line_count,
            rhyme_scheme: scheme,
            lines,
        });
    }

    let template = LyricTemplate {
        language: "zh-CN",
        title: if title.is_empty() {
            "未命名歌曲".to_string()
        } else {
            title.to_string()
        },
        total_lines,
        rhyme_targets: normalized_targets,
        sections: built_sections,
    };
    let summary = format!(
        "已建立《{}》的歌词结构：{} 个段落，共 {} 行。",
        template.title,
        template.sections.len(),
        template.total_lines
    );
    Ok(WorkflowResult {
        kind: "lyric-template".to_string(),
        summary,
        output_path: None,
        data: json!(template),
    })
}

pub fn validate_candidate_request(request: &LyricCandidateRequest) -> Result<(), String> {
    if request.language != "zh-CN" {
        return Err("当前版本只开放简体中文 Copilot 作词。".to_string());
    }
    if request.brief.trim().is_empty() && request.imagery.trim().is_empty() {
        return Err("请至少填写“想写什么”或一组意象。".to_string());
    }
    for (value, limit, label) in [
        (&request.brief, 2_000usize, "创作意图"),
        (&request.imagery, 1_000usize, "意象"),
        (&request.section_label, 60usize, "段落名称"),
        (&request.tone, 80usize, "语气"),
        (&request.target_rhyme, 24usize, "目标韵脚"),
    ] {
        if value.chars().count() > limit {
            return Err(format!("{label}超过 {limit} 个字符。"));
        }
    }
    if !(2..=8).contains(&request.candidate_count) {
        return Err("每次需要生成 2 到 8 条候选。".to_string());
    }
    if !request.target_rhyme.trim().is_empty() {
        resolve_query(&request.target_rhyme)?;
    }
    Ok(())
}

pub fn candidate_prompt_payload(request: &LyricCandidateRequest) -> serde_json::Value {
    json!({
        "language": request.language,
        "brief": request.brief.trim(),
        "imagery": request.imagery.trim(),
        "sectionLabel": request.section_label.trim(),
        "tone": request.tone.trim(),
        "targetRhyme": request.target_rhyme.trim(),
        "candidateCount": request.candidate_count,
    })
}

pub fn parse_candidate_response(
    request: &LyricCandidateRequest,
    response: &str,
) -> Result<LyricCandidateSet, String> {
    validate_candidate_request(request)?;
    let start = response
        .find('{')
        .ok_or_else(|| "模型没有返回 JSON 候选。".to_string())?;
    let end = response
        .rfind('}')
        .filter(|end| *end >= start)
        .ok_or_else(|| "模型返回的候选 JSON 不完整。".to_string())?;
    let raw: RawLyricCandidateSet = serde_json::from_str(&response[start..=end])
        .map_err(|error| format!("无法解析模型候选：{error}"))?;
    let candidates = raw
        .candidates
        .into_iter()
        .filter_map(|candidate| {
            let text = candidate.text.trim();
            if text.is_empty() {
                return None;
            }
            let text = limit_chars(text, 160);
            let rhyme_foot = text
                .chars()
                .rev()
                .find(|character| character.to_pinyin_multi().is_some())
                .map(|character| character.to_string());
            let rhyme_matched = if request.target_rhyme.trim().is_empty() {
                None
            } else {
                Some(candidate_matches_rhyme(&text, &request.target_rhyme))
            };
            Some(LyricCandidate {
                text,
                rhyme_foot,
                rhyme_matched,
                note: limit_chars(candidate.note.trim(), 240),
            })
        })
        .take(request.candidate_count)
        .collect::<Vec<_>>();
    if candidates.len() < 2 {
        return Err("模型返回的有效候选不足 2 条，请重试。".to_string());
    }
    let target_rhyme = if request.target_rhyme.trim().is_empty() {
        None
    } else {
        let (_, finals) = resolve_query(&request.target_rhyme)?;
        Some(
            finals
                .iter()
                .map(|final_name| rhyme_family(final_name))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(" / "),
        )
    };
    Ok(LyricCandidateSet {
        language: "zh-CN",
        brief: request.brief.trim().to_string(),
        imagery: request.imagery.trim().to_string(),
        section_label: request.section_label.trim().to_string(),
        target_rhyme,
        candidates,
    })
}

fn candidate_matches_rhyme(text: &str, target: &str) -> bool {
    let Ok((_, target_finals)) = resolve_query(target) else {
        return false;
    };
    let target_families = target_finals
        .iter()
        .map(|final_name| rhyme_family(final_name))
        .collect::<BTreeSet<_>>();
    let Some(foot) = text
        .chars()
        .rev()
        .find(|character| character.to_pinyin_multi().is_some())
    else {
        return false;
    };
    foot.to_pinyin_multi().is_some_and(|readings| {
        readings.into_iter().any(|reading| {
            syllable_final(reading.plain())
                .is_some_and(|final_name| target_families.contains(rhyme_family(&final_name)))
        })
    })
}

fn limit_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn resolve_query(query: &str) -> Result<(Vec<String>, BTreeSet<String>), String> {
    let han = query
        .chars()
        .rev()
        .find(|character| character.to_pinyin_multi().is_some());
    if let Some(character) = han {
        let readings = character
            .to_pinyin_multi()
            .into_iter()
            .flatten()
            .map(|reading| reading.plain().to_string())
            .collect::<BTreeSet<_>>();
        let finals = readings
            .iter()
            .filter_map(|reading| syllable_final(reading))
            .collect::<BTreeSet<_>>();
        if finals.is_empty() {
            return Err("无法识别输入字的普通话拼音。".to_string());
        }
        return Ok((readings.into_iter().collect(), finals));
    }

    let normalized = normalize_pinyin_text(query);
    let Some(final_name) = explicit_final(&normalized).or_else(|| syllable_final(&normalized))
    else {
        return Err("请输入汉字，或 a、ai、ang、ian、ong 等拼音韵母。".to_string());
    };
    Ok((Vec::new(), BTreeSet::from([final_name])))
}

fn explicit_final(value: &str) -> Option<String> {
    let normalized = match value {
        "ui" => "uei",
        "iu" => "iou",
        "un" => "uen",
        "ue" | "üe" => "ve",
        "uan" if value.contains('ü') => "van",
        other => other,
    };
    is_supported_final(normalized).then(|| normalized.to_string())
}

fn syllable_final(value: &str) -> Option<String> {
    let syllable = normalize_pinyin_text(value);
    if syllable.is_empty() {
        return None;
    }
    let transformed = if let Some(rest) = syllable.strip_prefix('y') {
        match rest {
            "" | "i" => "i".to_string(),
            "u" => "v".to_string(),
            "ue" => "ve".to_string(),
            "uan" => "van".to_string(),
            "un" => "vn".to_string(),
            value if value.starts_with('i') => value.to_string(),
            value => format!("i{value}"),
        }
    } else if let Some(rest) = syllable.strip_prefix('w') {
        match rest {
            "" | "u" => "u".to_string(),
            value if value.starts_with('u') => value.to_string(),
            value => format!("u{value}"),
        }
    } else {
        let initial = [
            "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x",
            "r", "z", "c", "s",
        ]
        .into_iter()
        .find(|initial| syllable.starts_with(initial))
        .unwrap_or("");
        let mut final_name = syllable[initial.len()..].to_string();
        if matches!(initial, "j" | "q" | "x") && final_name.starts_with('u') {
            final_name.replace_range(..1, "v");
        }
        final_name
    };
    let expanded = match transformed.as_str() {
        "ui" => "uei",
        "iu" => "iou",
        "un" => "uen",
        other => other,
    };
    is_supported_final(expanded).then(|| expanded.to_string())
}

fn rhyme_family(final_name: &str) -> &str {
    match final_name {
        "a" | "ia" | "ua" => "a",
        "o" | "e" | "uo" => "o",
        "ie" | "ve" => "ie",
        "ai" | "uai" => "ai",
        "ei" | "uei" => "ei",
        "ao" | "iao" => "ao",
        "ou" | "iou" => "ou",
        "an" | "ian" | "uan" | "van" => "an",
        "en" | "in" | "uen" | "vn" => "en",
        "ang" | "iang" | "uang" => "ang",
        "eng" | "ing" | "ueng" => "eng",
        "ong" | "iong" => "ong",
        other => other,
    }
}

fn is_supported_final(value: &str) -> bool {
    matches!(
        value,
        "a" | "o"
            | "e"
            | "i"
            | "u"
            | "v"
            | "er"
            | "ai"
            | "ei"
            | "ao"
            | "ou"
            | "an"
            | "en"
            | "ang"
            | "eng"
            | "ong"
            | "ia"
            | "ie"
            | "iao"
            | "iou"
            | "ian"
            | "in"
            | "iang"
            | "ing"
            | "iong"
            | "ua"
            | "uo"
            | "uai"
            | "uei"
            | "uan"
            | "uen"
            | "uang"
            | "ueng"
            | "ve"
            | "van"
            | "vn"
    )
}

fn normalize_pinyin_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter_map(|character| match character {
            'a'..='z' => Some(character),
            'ā' | 'á' | 'ǎ' | 'à' => Some('a'),
            'ō' | 'ó' | 'ǒ' | 'ò' => Some('o'),
            'ē' | 'é' | 'ě' | 'è' | 'ê' => Some('e'),
            'ī' | 'í' | 'ǐ' | 'ì' => Some('i'),
            'ū' | 'ú' | 'ǔ' | 'ù' => Some('u'),
            'ü' | 'ǖ' | 'ǘ' | 'ǚ' | 'ǜ' => Some('v'),
            _ => None,
        })
        .collect()
}

fn normalize_rhyme_targets(
    targets: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut normalized = BTreeMap::new();
    for (label, target) in targets {
        let label = label.trim().to_ascii_uppercase();
        if label.len() != 1 || !label.as_bytes()[0].is_ascii_alphabetic() {
            return Err("韵脚标签必须是单个 A-Z 字母。".to_string());
        }
        if target.trim().is_empty() {
            continue;
        }
        let (_, finals) = resolve_query(&target)?;
        let families = finals
            .iter()
            .map(|final_name| rhyme_family(final_name))
            .collect::<BTreeSet<_>>();
        normalized.insert(label, families.into_iter().collect::<Vec<_>>().join(" / "));
    }
    Ok(normalized)
}

fn normalize_scheme(value: &str) -> Result<String, String> {
    let scheme = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| character.to_ascii_uppercase())
        .collect::<String>();
    let scheme = if scheme.is_empty() {
        "-".to_string()
    } else {
        scheme
    };
    if scheme.chars().count() > 32
        || !scheme
            .chars()
            .all(|character| character.is_ascii_uppercase() || character == '-')
    {
        return Err("押韵格式只接受 A-Z 与 -，且不能超过 32 位。".to_string());
    }
    Ok(scheme)
}

fn validate_section_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("歌曲段落 ID 无效。".to_string());
    }
    Ok(())
}

fn validate_section_kind(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "intro" | "verse" | "preChorus" | "chorus" | "bridge" | "instrumental" | "outro" | "custom"
    ) {
        Ok(())
    } else {
        Err("歌曲段落类型无效。".to_string())
    }
}

fn cjk_ranges() -> [(u32, u32); 5] {
    [
        (0x3400, 0x4DBF),
        (0x4E00, 0x9FFF),
        (0xF900, 0xFAFF),
        (0x20000, 0x2FA1F),
        (0x30000, 0x323AF),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_syllables_into_lyric_rhyme_families() {
        assert_eq!(syllable_final("guang"), Some("uang".to_string()));
        assert_eq!(syllable_final("jiāng"), Some("iang".to_string()));
        assert_eq!(syllable_final("yun"), Some("vn".to_string()));
        assert_eq!(rhyme_family("uang"), "ang");
        assert_eq!(rhyme_family("iang"), "ang");
        assert_eq!(
            resolve_query("guang").unwrap().1,
            BTreeSet::from(["uang".to_string()])
        );
    }

    #[test]
    fn lookup_accepts_a_character_and_returns_all_matching_dictionary_chars() {
        let result = lookup_chinese_rhyme("光", RhymeMatchMode::Family).unwrap();
        assert_eq!(result.rhyme_keys, vec!["ang"]);
        assert!(result.total > 100);
        assert!(result.characters.iter().any(|item| item.character == "光"));
        assert!(result.characters.iter().any(|item| item.character == "江"));
    }

    #[test]
    fn lyric_template_cycles_scheme_and_resolves_targets() {
        let result = build_lyric_template(
            "zh-CN",
            "测试歌",
            vec![LyricSectionRequest {
                id: "verse-1".to_string(),
                kind: "verse".to_string(),
                label: "主歌 1".to_string(),
                line_count: 6,
                rhyme_scheme: "ABAB".to_string(),
            }],
            BTreeMap::from([
                ("A".to_string(), "光".to_string()),
                ("B".to_string(), "ai".to_string()),
            ]),
        )
        .unwrap();
        let labels = result.data["sections"][0]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line["rhymeLabel"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(labels, vec!["A", "B", "A", "B", "A", "B"]);
        assert_eq!(result.data["rhymeTargets"]["A"], "ang");
    }

    #[test]
    fn candidate_parser_checks_the_actual_line_ending() {
        let request = LyricCandidateRequest {
            language: "zh-CN".to_string(),
            brief: "写离开故乡后的回望".to_string(),
            imagery: "月台，旧信".to_string(),
            section_label: "副歌".to_string(),
            tone: "克制".to_string(),
            target_rhyme: "ang".to_string(),
            candidate_count: 3,
        };
        let parsed = parse_candidate_response(
            &request,
            r#"说明文字 {"candidates":[{"text":"旧月台还留着那束光","note":"收束"},{"text":"信纸折回潮湿的行囊","note":"推进"},{"text":"我没有回头看车窗","note":"留白"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.candidates.len(), 3);
        assert!(parsed
            .candidates
            .iter()
            .all(|candidate| candidate.rhyme_matched == Some(true)));
        assert_eq!(parsed.target_rhyme.as_deref(), Some("ang"));
    }
}
