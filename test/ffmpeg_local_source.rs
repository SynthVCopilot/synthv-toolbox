use std::fs;
use std::path::PathBuf;

use crate::components::{find_ffmpeg_pair, validate_ffmpeg_directory};
use crate::config::ToolboxSettings;

fn temporary_root(name: &str) -> PathBuf {
    fs::canonicalize(std::env::temp_dir())
        .expect("system temporary directory must exist")
        .join(format!("synthv-toolbox-{name}-{}", uuid::Uuid::new_v4()))
}

fn executable_names() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("ffmpeg.exe", "ffprobe.exe")
    } else {
        ("ffmpeg", "ffprobe")
    }
}

#[test]
fn ffmpeg_selection_is_persisted_with_settings() {
    let mut settings = ToolboxSettings::default();
    settings.ffmpeg_directory = Some("C:/tools/ffmpeg/bin".to_string());

    let value = serde_json::to_value(&settings).unwrap();
    assert_eq!(value["ffmpegDirectory"], "C:/tools/ffmpeg/bin");
    let restored: ToolboxSettings = serde_json::from_value(value).unwrap();
    assert_eq!(
        restored.ffmpeg_directory.as_deref(),
        Some("C:/tools/ffmpeg/bin")
    );
}

#[test]
fn ffmpeg_pair_accepts_an_extracted_root_or_its_bin_directory() {
    let root = temporary_root("pair");
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let (ffmpeg, ffprobe) = executable_names();
    fs::write(bin.join(ffmpeg), b"test").unwrap();
    fs::write(bin.join(ffprobe), b"test").unwrap();

    assert!(find_ffmpeg_pair(&root).is_some());
    assert!(find_ffmpeg_pair(&bin).is_some());

    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn ffmpeg_pair_rejects_a_linked_directory() {
    use std::os::unix::fs::symlink;

    let root = temporary_root("linked-pair");
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let (ffmpeg, ffprobe) = executable_names();
    fs::write(bin.join(ffmpeg), b"test").unwrap();
    fs::write(bin.join(ffprobe), b"test").unwrap();
    let linked_root = temporary_root("linked-pair-alias");
    symlink(&root, &linked_root).unwrap();

    assert!(find_ffmpeg_pair(&linked_root).is_none());

    fs::remove_file(linked_root).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn ffmpeg_selection_rejects_a_directory_without_both_binaries() {
    let root = temporary_root("missing");
    fs::create_dir_all(&root).unwrap();
    let (ffmpeg, _) = executable_names();
    fs::write(root.join(ffmpeg), b"test").unwrap();

    assert!(validate_ffmpeg_directory(&root.to_string_lossy())
        .await
        .is_err());

    fs::remove_dir_all(root).unwrap();
}
