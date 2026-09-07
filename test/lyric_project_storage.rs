#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;

mod agent {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    pub fn data_root() -> PathBuf {
        static ROOT: OnceLock<PathBuf> = OnceLock::new();
        ROOT.get_or_init(|| {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test/.tmp")
                .join(format!("lyric-storage-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            path.canonicalize().unwrap()
        })
        .clone()
    }

    pub fn output_dir() -> PathBuf {
        data_root().join("output")
    }
}

mod workflows {
    #[derive(Debug)]
    pub struct WorkflowResult {
        pub kind: String,
        pub summary: String,
        pub output_path: Option<String>,
        pub data: serde_json::Value,
    }
}

#[path = "../src/PiDesktop.Tauri/src-tauri/src/lyric_projects.rs"]
mod lyric_projects;
#[path = "../src/PiDesktop.Tauri/src-tauri/src/lyric_tools.rs"]
mod lyric_tools;

fn sections() -> Vec<lyric_tools::LyricSectionRequest> {
    vec![lyric_tools::LyricSectionRequest {
        id: "chorus".into(),
        kind: "chorus".into(),
        label: "副歌".into(),
        line_count: 4,
        rhyme_scheme: "AAAA".into(),
    }]
}

fn candidates() -> Vec<lyric_tools::LyricCandidateSet> {
    vec![lyric_tools::LyricCandidateSet {
        language: "zh-CN".into(),
        brief: "晨光".into(),
        imagery: String::new(),
        section_label: "副歌".into(),
        target_rhyme: None,
        candidates: ["晨光照向远方", "风吹过旧街巷"]
            .iter()
            .map(|text| lyric_tools::LyricCandidate {
                text: (*text).into(),
                rhyme_foot: None,
                rhyme_matched: None,
                note: String::new(),
            })
            .collect(),
    }]
}

#[test]
fn storage_preserves_candidates_and_restores_as_a_new_revision() {
    let initial = lyric_projects::create(
        "晨光".into(),
        "第一稿".into(),
        sections(),
        BTreeMap::new(),
        candidates(),
    )
    .unwrap();
    let changed = lyric_projects::save(
        &initial.id,
        "晨光".into(),
        "第二稿".into(),
        sections(),
        BTreeMap::new(),
        candidates(),
    )
    .unwrap();
    let loaded = lyric_projects::load(&initial.id).unwrap();
    assert_eq!(loaded.draft, "第二稿");
    assert_eq!(
        loaded.candidate_history[0].candidates[0].text,
        "晨光照向远方"
    );
    assert_eq!(loaded.versions[0].draft, "第一稿");
    let restored = lyric_projects::restore_version(&initial.id, initial.revision).unwrap();
    assert_eq!(restored.draft, "第一稿");
    assert_eq!(restored.revision, changed.revision + 1);
    assert!(restored
        .versions
        .iter()
        .any(|version| version.draft == "第二稿"));
    assert!(lyric_projects::list(200)
        .unwrap()
        .iter()
        .any(|entry| entry.id == initial.id));
}

#[test]
fn storage_never_writes_a_project_that_exceeds_its_reader_limit() {
    let initial = lyric_projects::create(
        "边界".into(),
        "a".repeat(100_000),
        sections(),
        BTreeMap::new(),
        vec![],
    )
    .unwrap();
    for count in 1..16 {
        let draft = format!("{}{}", "a".repeat(100_000), count);
        lyric_projects::save(
            &initial.id,
            "边界".into(),
            draft.clone(),
            sections(),
            BTreeMap::new(),
            candidates(),
        )
        .unwrap();
        let path = agent::data_root()
            .join("lyric-projects")
            .join(format!("{}.json", initial.id));
        assert!(fs::metadata(path).unwrap().len() <= 1024 * 1024);
        assert_eq!(lyric_projects::load(&initial.id).unwrap().draft, draft);
    }
}

#[test]
fn storage_rejects_oversized_candidate_context_before_creating_a_file() {
    for oversized_rhyme in [false, true] {
        let mut history = candidates();
        if oversized_rhyme {
            history[0].candidates[0].rhyme_foot = Some("x".repeat(25));
        } else {
            history[0].brief = "x".repeat(1024 * 1024);
        }
        assert!(lyric_projects::create(
            "oversize".into(),
            "draft".into(),
            sections(),
            BTreeMap::new(),
            history
        )
        .is_err());
    }
}
#[test]
fn exports_write_distinct_utf8_files_and_ids_cannot_escape_storage() {
    let first = lyric_projects::export_text("晨光".into(), "第一行\n第二行".into()).unwrap();
    let second = lyric_projects::export_text("晨光".into(), "另一版".into()).unwrap();
    assert_ne!(first, second);
    assert_eq!(fs::read_to_string(first).unwrap(), "晨光\n\n第一行\n第二行");
    assert_eq!(fs::read_to_string(second).unwrap(), "晨光\n\n另一版");
    assert!(lyric_projects::load("../outside").is_err());
    assert!(lyric_projects::restore_version("../outside", 1).is_err());
}
