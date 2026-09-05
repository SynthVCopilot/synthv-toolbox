use std::collections::BTreeMap;
use std::fs::{self, Metadata, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
};

const MAX_VOICES: usize = 256;
const MAX_METADATA_BYTES: usize = 16 * 1024;
const MAX_IMAGE_BYTES: usize = 512 * 1024;
const MAX_CATALOG_IMAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2CachedVoice {
    pub id: String,
    pub name: String,
    pub vendor: Option<String>,
    pub image_data_url: Option<String>,
}

#[derive(Deserialize)]
struct VoiceMetadata {
    name: String,
    vendor: Option<String>,
}

pub fn read_catalog(roots: &[PathBuf]) -> Vec<Sv2CachedVoice> {
    let directories = roots
        .iter()
        .filter(|root| safe_directory(root) && safe_directory(&root.join("databases")))
        .map(|root| root.join("databases/meta"))
        .filter(|directory| safe_directory(directory))
        .collect::<Vec<_>>();
    let mut voices = BTreeMap::new();
    for directory in &directories {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        let mut files = entries
            .take(MAX_VOICES * 4)
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>();
        files.sort();
        for path in files {
            let Some(id) = path
                .file_stem()
                .and_then(|name| name.to_str())
                .and_then(|name| uuid::Uuid::parse_str(name).ok())
                .map(|id| id.to_string())
            else {
                continue;
            };
            if voices.contains_key(&id) || voices.len() >= MAX_VOICES {
                continue;
            }
            let Some(metadata) = read_bounded_file(&path, MAX_METADATA_BYTES)
                .and_then(|bytes| serde_json::from_slice::<VoiceMetadata>(&bytes).ok())
            else {
                continue;
            };
            let Some(name) = normalize_text(metadata.name) else {
                continue;
            };
            voices.insert(
                id.clone(),
                Sv2CachedVoice {
                    id,
                    name,
                    vendor: metadata.vendor.and_then(normalize_text),
                    image_data_url: None,
                },
            );
        }
    }
    let mut voices = voices.into_values().collect::<Vec<_>>();
    voices.sort_by_cached_key(|voice| (voice.name.to_lowercase(), voice.id.clone()));
    let mut image_bytes = 0;
    for voice in &mut voices {
        for directory in &directories {
            let Some(bytes) = read_bounded_file(
                &directory.join(format!("{}.png", voice.id)),
                MAX_IMAGE_BYTES,
            ) else {
                continue;
            };
            if !bounded_png(&bytes) || image_bytes + bytes.len() > MAX_CATALOG_IMAGE_BYTES {
                continue;
            }
            image_bytes += bytes.len();
            voice.image_data_url =
                Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)));
            break;
        }
    }
    voices
}

fn normalize_text(value: String) -> Option<String> {
    if value.chars().any(char::is_control) {
        return None;
    }
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty() && value.chars().count() <= 160).then_some(value)
}

fn redirected(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn safe_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir() && !redirected(&metadata))
}

fn read_bounded_file(path: &Path, maximum: usize) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || redirected(&metadata) || metadata.len() > maximum as u64 {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file() || redirected(&opened) || opened.len() > maximum as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= maximum).then_some(bytes)
}

fn bounded_png(bytes: &[u8]) -> bool {
    if bytes.len() < 33 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return false;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    (1..=2048).contains(&width) && (1..=2048).contains(&height)
}

#[cfg(test)]
#[path = "../../../../test/sv2_voice_catalog_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../../test/sv2_catalog_diagnostic.rs"]
mod diagnostic;
