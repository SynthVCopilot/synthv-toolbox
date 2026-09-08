use std::fs;
use std::path::{Path, PathBuf};

use crate::project_discovery::discover_project_paths_from_settings;

fn temporary_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("svp-discovery-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn settings_file(root: &Path, name: &str, contents: &str) -> PathBuf {
    let path = root.join(name).join("settings/settings.xml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, contents).unwrap();
    path
}

#[test]
fn finds_deduplicated_absolute_svp_paths_and_decodes_entities() {
    let root = temporary_root("paths");
    let first = root.join("canonical/song & one.svp");
    let second = root.join("slot/two.svp");
    let third = root.join("slot/你.svp");
    let canonical = settings_file(
        &root,
        "canonical",
        &format!(
            "<Settings><RecentlyOpenedFiles><FileItem path=\"{}\"/><FileItem path=\"{}\"/></RecentlyOpenedFiles></Settings>",
            first.to_string_lossy().replace('&', "&amp;"),
            root.join("ignore.txt").to_string_lossy()
        ),
    );
    let slot = settings_file(
        &root,
        "slot",
        &format!(
            "<Settings><RecentlyOpenedFiles><FileItem path=\"{}\"/><FileItem path=\"{}\"></FileItem><FileItem path=\"{}\"/></RecentlyOpenedFiles></Settings>",
            first.to_string_lossy().replace('&', "&amp;"),
            second.to_string_lossy(),
            third.to_string_lossy().replace('你', "&#20320;")
        ),
    );

    assert_eq!(
        discover_project_paths_from_settings([canonical, slot]),
        vec![
            first.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
            third.to_string_lossy().into_owned()
        ]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ignores_missing_malformed_oversized_non_absolute_and_unclosed_entries() {
    let root = temporary_root("invalid");
    let malformed = settings_file(&root, "malformed", "<RecentlyOpenedFiles><FileItem");
    let relative = settings_file(
        &root,
        "relative",
        "<RecentlyOpenedFiles><FileItem path=\"song.svp\"/></RecentlyOpenedFiles>",
    );
    let unclosed = settings_file(
        &root,
        "unclosed",
        &format!(
            "<Settings><RecentlyOpenedFiles><FileItem path=\"{}\"/>",
            root.join("discard.svp").to_string_lossy()
        ),
    );
    let oversized = settings_file(&root, "oversized", &"x".repeat(4 * 1024 * 1024 + 1));

    assert!(discover_project_paths_from_settings([
        root.join("missing/settings.xml"),
        malformed,
        relative,
        unclosed,
        oversized,
    ])
    .is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ignores_file_items_outside_recent_projects_and_refreshes_after_a_rewrite() {
    let root = temporary_root("refresh");
    let settings = settings_file(
        &root,
        "settings",
        &format!(
            "<Settings><Other><FileItem path=\"{}\"/></Other><RecentlyOpenedFiles><FileItem path=\"{}\"/></RecentlyOpenedFiles></Settings>",
            root.join("outside.svp").to_string_lossy(),
            root.join("first.svp").to_string_lossy()
        ),
    );
    assert_eq!(
        discover_project_paths_from_settings([settings.clone()]),
        vec![root.join("first.svp").to_string_lossy().into_owned()]
    );
    fs::write(
        &settings,
        format!(
            "<Settings><RecentlyOpenedFiles><FileItem path=\"{}\"/></RecentlyOpenedFiles></Settings>",
            root.join("second.svp").to_string_lossy()
        ),
    )
    .unwrap();
    assert_eq!(
        discover_project_paths_from_settings([settings]),
        vec![root.join("second.svp").to_string_lossy().into_owned()]
    );
    let _ = fs::remove_dir_all(root);
}
