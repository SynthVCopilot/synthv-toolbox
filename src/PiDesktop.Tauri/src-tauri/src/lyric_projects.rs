use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::lyric_tools::{self, LyricCandidateSet, LyricSectionRequest};

const SCHEMA_VERSION: u32 = 1;
const MAX_PROJECTS: usize = 200;
const MAX_CANDIDATE_SETS: usize = 20;
const MAX_VERSIONS: usize = 30;
const MAX_DRAFT_CHARS: usize = 200_000;
const MAX_PROJECT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricProject {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub draft: String,
    pub rhyme_targets: BTreeMap<String, String>,
    pub sections: Vec<LyricSectionRequest>,
    #[serde(default)]
    pub candidate_history: Vec<LyricCandidateSet>,
    #[serde(default)]
    pub versions: Vec<LyricProjectVersion>,
    pub revision: u32,
    pub created_at_utc: String,
    pub updated_at_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricProjectVersion {
    pub revision: u32,
    pub title: String,
    pub draft: String,
    pub rhyme_targets: BTreeMap<String, String>,
    pub sections: Vec<LyricSectionRequest>,
    pub candidate_history: Vec<LyricCandidateSet>,
    pub saved_at_utc: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricProjectSummary {
    pub id: String,
    pub title: String,
    pub revision: u32,
    pub line_count: usize,
    pub updated_at_utc: String,
}

pub fn create(
    title: String,
    draft: String,
    sections: Vec<LyricSectionRequest>,
    rhyme_targets: BTreeMap<String, String>,
    candidate_history: Vec<LyricCandidateSet>,
) -> Result<LyricProject, String> {
    let (title, draft) = validate_input(&title, draft, &sections, &rhyme_targets)?;
    let now = Utc::now().to_rfc3339();
    let project = LyricProject {
        schema_version: SCHEMA_VERSION,
        id: Uuid::new_v4().to_string(),
        title,
        draft,
        rhyme_targets,
        sections,
        candidate_history: normalize_candidate_history(candidate_history)?,
        versions: Vec::new(),
        revision: 1,
        created_at_utc: now.clone(),
        updated_at_utc: now,
    };
    write_project(&project)?;
    Ok(project)
}

pub fn save(
    id: &str,
    title: String,
    draft: String,
    sections: Vec<LyricSectionRequest>,
    rhyme_targets: BTreeMap<String, String>,
    candidate_history: Vec<LyricCandidateSet>,
) -> Result<LyricProject, String> {
    validate_id(id)?;
    let (title, draft) = validate_input(&title, draft, &sections, &rhyme_targets)?;
    let existing = read_project(id)?;
    let mut versions = existing.versions;
    versions.push(LyricProjectVersion {
        revision: existing.revision,
        title: existing.title,
        draft: existing.draft,
        rhyme_targets: existing.rhyme_targets,
        sections: existing.sections,
        candidate_history: existing.candidate_history,
        saved_at_utc: existing.updated_at_utc,
    });
    if versions.len() > MAX_VERSIONS {
        versions.drain(..versions.len() - MAX_VERSIONS);
    }
    let project = LyricProject {
        schema_version: SCHEMA_VERSION,
        id: existing.id,
        title,
        draft,
        rhyme_targets,
        sections,
        candidate_history: normalize_candidate_history(candidate_history)?,
        versions,
        revision: existing.revision.saturating_add(1),
        created_at_utc: existing.created_at_utc,
        updated_at_utc: Utc::now().to_rfc3339(),
    };
    let mut project = project;
    limit_project_size(&mut project)?;
    write_project(&project)?;
    Ok(project)
}

pub fn restore_version(id: &str, revision: u32) -> Result<LyricProject, String> {
    let existing = read_project(id)?;
    let version = existing
        .versions
        .iter()
        .find(|version| version.revision == revision)
        .cloned()
        .ok_or_else(|| "找不到该歌词版本。".to_string())?;
    save(
        id,
        version.title,
        version.draft,
        version.sections,
        version.rhyme_targets,
        version.candidate_history,
    )
}

pub fn load(id: &str) -> Result<LyricProject, String> {
    validate_id(id)?;
    read_project(id)
}

pub fn export_text(title: String, draft: String) -> Result<String, String> {
    if draft.chars().count() > MAX_DRAFT_CHARS {
        return Err("歌词草稿超过 200000 字符限制。".to_string());
    }
    let title = if title.trim().is_empty() {
        "未命名歌曲".to_string()
    } else {
        title.trim().to_string()
    };
    let directory = crate::agent::output_dir().join("lyrics");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建歌词导出目录：{error}"))?;
    let stem = title
        .chars()
        .filter(|character| {
            character.is_alphanumeric()
                || *character == ' '
                || *character == '-'
                || *character == '_'
        })
        .take(60)
        .collect::<String>();
    let name = if stem.trim().is_empty() {
        "lyrics"
    } else {
        stem.trim()
    };
    let output = directory.join(format!("{}-{}.txt", name, Uuid::new_v4().simple()));
    let content = format!("{title}\n\n{draft}");
    fs::write(&output, content).map_err(|error| format!("无法导出歌词：{error}"))?;
    Ok(output.to_string_lossy().into_owned())
}

pub fn list(limit: usize) -> Result<Vec<LyricProjectSummary>, String> {
    let directory = projects_dir()?;
    let mut items = fs::read_dir(&directory)
        .map_err(|error| format!("无法读取歌词项目：{error}"))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let file_type = entry.file_type().ok()?;
            (file_type.is_file()
                && !file_type.is_symlink()
                && path.extension().and_then(|value| value.to_str()) == Some("json"))
            .then_some(path)
        })
        .filter_map(|path| read_project_file(&path).ok())
        .filter(|project| {
            project.schema_version == SCHEMA_VERSION && validate_id(&project.id).is_ok()
        })
        .map(|project| LyricProjectSummary {
            id: project.id,
            title: project.title,
            revision: project.revision,
            line_count: project
                .draft
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count(),
            updated_at_utc: project.updated_at_utc,
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.updated_at_utc.cmp(&left.updated_at_utc));
    items.truncate(limit.clamp(1, MAX_PROJECTS));
    Ok(items)
}

fn validate_input(
    title: &str,
    draft: String,
    sections: &[LyricSectionRequest],
    rhyme_targets: &BTreeMap<String, String>,
) -> Result<(String, String), String> {
    if draft.chars().count() > MAX_DRAFT_CHARS {
        return Err("歌词草稿超过 200000 字符限制。".to_string());
    }
    let title = title.trim();
    lyric_tools::build_lyric_template("zh-CN", title, sections.to_vec(), rhyme_targets.clone())?;
    Ok((
        if title.is_empty() {
            "未命名歌曲".to_string()
        } else {
            title.to_string()
        },
        draft,
    ))
}

fn normalize_candidate_history(
    mut history: Vec<LyricCandidateSet>,
) -> Result<Vec<LyricCandidateSet>, String> {
    if history.len() > MAX_CANDIDATE_SETS {
        history.drain(..history.len() - MAX_CANDIDATE_SETS);
    }
    for set in &history {
        lyric_tools::validate_candidate_request(&lyric_tools::LyricCandidateRequest {
            language: set.language.clone(),
            brief: set.brief.clone(),
            imagery: set.imagery.clone(),
            section_label: set.section_label.clone(),
            tone: String::new(),
            target_rhyme: set.target_rhyme.clone().unwrap_or_default(),
            candidate_count: set.candidates.len(),
        })?;
        if set.candidates.len() < 2 || set.candidates.len() > 8 {
            return Err("歌词候选记录无效。".to_string());
        }
        if set.candidates.iter().any(|candidate| {
            candidate.text.chars().count() > 160
                || candidate.note.chars().count() > 240
                || candidate
                    .rhyme_foot
                    .as_ref()
                    .is_some_and(|value| value.chars().count() > 24)
        }) {
            return Err("歌词候选记录超出限制。".to_string());
        }
    }
    Ok(history)
}

fn limit_project_size(project: &mut LyricProject) -> Result<(), String> {
    while serde_json::to_vec_pretty(project)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_PROJECT_BYTES as usize
    {
        if project.versions.is_empty() {
            return Err("歌词项目超过 1 MiB 限制。".to_string());
        }
        project.versions.remove(0);
    }
    Ok(())
}

fn read_project(id: &str) -> Result<LyricProject, String> {
    read_project_file(&project_path(id)?)
}

fn read_project_file(path: &Path) -> Result<LyricProject, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "找不到该歌词项目。".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("歌词项目文件无效。".to_string());
    }
    if metadata.len() > MAX_PROJECT_BYTES {
        return Err("歌词项目超过 1 MiB 限制。".to_string());
    }
    let project = serde_json::from_slice::<LyricProject>(
        &fs::read(path).map_err(|error| format!("无法读取歌词项目：{error}"))?,
    )
    .map_err(|_| "歌词项目格式无效。".to_string())?;
    if project.schema_version != SCHEMA_VERSION || validate_id(&project.id).is_err() {
        return Err("歌词项目版本或标识无效。".to_string());
    }
    Ok(project)
}

fn write_project(project: &LyricProject) -> Result<(), String> {
    let path = project_path(&project.id)?;
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("歌词项目目标不是可安全覆盖的普通文件。".to_string());
        }
    }
    let temporary = path.with_file_name(format!(".{}.{}.tmp", project.id, Uuid::new_v4()));
    let serialized = serde_json::to_vec_pretty(project).map_err(|error| error.to_string())?;
    if serialized.len() > MAX_PROJECT_BYTES as usize {
        return Err("歌词项目超过 1 MiB 限制。".to_string());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("无法创建歌词项目暂存文件：{error}"))?;
    if let Err(error) = file.write_all(&serialized).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法写入歌词项目：{error}"));
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法保存歌词项目：{error}"));
    }
    Ok(())
}

fn projects_dir() -> Result<PathBuf, String> {
    let directory = crate::agent::data_root().join("lyric-projects");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(directory),
        Ok(_) => Err("歌词项目目录不是安全的普通目录。".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&directory)
                .map_err(|error| format!("无法创建歌词项目目录：{error}"))?;
            let metadata = fs::symlink_metadata(&directory)
                .map_err(|error| format!("无法验证歌词项目目录：{error}"))?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                Ok(directory)
            } else {
                Err("歌词项目目录不是安全的普通目录。".to_string())
            }
        }
        Err(error) => Err(format!("无法检查歌词项目目录：{error}")),
    }
}

fn project_path(id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(projects_dir()?.join(format!("{id}.json")))
}

fn validate_id(value: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "歌词项目 ID 无效。".to_string())
}
