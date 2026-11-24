use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use quick_xml::events::Event;
use quick_xml::Reader;

const MAX_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn discover_project_paths() -> Vec<String> {
    discover_project_paths_from_settings(crate::sv2_profiles::recent_project_settings_files())
}

pub(crate) fn discover_project_paths_from_settings(
    settings_files: impl IntoIterator<Item = PathBuf>,
) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    for settings_file in settings_files {
        let Ok(bytes) = read_settings_file(&settings_file) else {
            continue;
        };
        let Ok(discovered) = recent_project_paths(&bytes) else {
            continue;
        };
        for path in discovered {
            if seen.insert(dedupe_key(&path)) {
                paths.push(path);
            }
        }
    }
    paths
}

fn read_settings_file(path: &Path) -> Result<Vec<u8>, ()> {
    let file = fs::File::open(path).map_err(|_| ())?;
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(());
    }
    Ok(bytes)
}

fn recent_project_paths(bytes: &[u8]) -> Result<Vec<String>, ()> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut document_depth = 0usize;
    let mut recent_files_depth: Option<usize> = None;
    let mut paths = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                if recent_files_depth == Some(0) && event.name().as_ref() == b"FileItem" {
                    if let Some(path) = project_path_from_item(&event, reader.decoder())? {
                        paths.push(path);
                    }
                }
                if event.name().as_ref() == b"RecentlyOpenedFiles" && recent_files_depth.is_none() {
                    recent_files_depth = Some(0);
                } else if let Some(depth) = recent_files_depth.as_mut() {
                    *depth += 1;
                }
                document_depth += 1;
            }
            Ok(Event::Empty(event)) => {
                if recent_files_depth == Some(0) && event.name().as_ref() == b"FileItem" {
                    if let Some(path) = project_path_from_item(&event, reader.decoder())? {
                        paths.push(path);
                    }
                }
            }
            Ok(Event::End(event)) => {
                if document_depth == 0 {
                    return Err(());
                }
                document_depth -= 1;
                if event.name().as_ref() == b"RecentlyOpenedFiles" && recent_files_depth == Some(0)
                {
                    recent_files_depth = None;
                } else if let Some(depth) = recent_files_depth.as_mut() {
                    *depth = depth.saturating_sub(1);
                }
            }
            Ok(Event::Eof) => return (document_depth == 0).then_some(paths).ok_or(()),
            Err(_) => return Err(()),
            _ => {}
        }
        buffer.clear();
    }
}

fn project_path_from_item(
    event: &quick_xml::events::BytesStart<'_>,
    decoder: quick_xml::Decoder,
) -> Result<Option<String>, ()> {
    let mut value = None;
    for attribute in event.attributes() {
        let attribute = attribute.map_err(|_| ())?;
        if attribute.key.as_ref() == b"path" {
            value = Some(
                attribute
                    .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
                    .map_err(|_| ())?,
            );
        }
    }
    let Some(value) = value else {
        return Ok(None);
    };
    let path = PathBuf::from(value.as_ref());
    Ok((path.is_absolute()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("svp")))
    .then(|| path.to_string_lossy().into_owned()))
}

fn dedupe_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}
