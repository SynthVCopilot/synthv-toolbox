use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::synthv::quiet_command;
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_OPEN_REPARSE_POINT,
};

const MANIFEST_NAME: &str = "sv2-data-backup-manifest.json";
const COPY_BUFFER_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sv2DataBackup {
    pub backup_root: PathBuf,
    pub canonical_source_root: PathBuf,
    pub file_count: usize,
    pub session_path: Option<PathBuf>,
    pub session_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Manifest {
    format_version: u8,
    created_at_utc: String,
    canonical_source_root: String,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ManifestFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeEntry {
    relative: PathBuf,
    kind: EntryKind,
    stamp: EntryStamp,
    sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EntryStamp {
    bytes: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(windows)]
    identity: (u32, u64),
}

/// Copies a complete, stable SV2 data root to a new directory outside that root.
///
/// `source_in_use` must come from the caller's process guard. The function refuses
/// an active source because a complete backup cannot be proven stable in that state.
pub fn create_verified_sv2_data_backup(
    source_root: impl AsRef<Path>,
    backup_parent: impl AsRef<Path>,
    source_in_use: bool,
) -> Result<Sv2DataBackup, String> {
    if source_in_use {
        return Err("SV2 data is in use; refusing to create a mixed backup".to_string());
    }

    let source_root = source_root.as_ref();
    let backup_parent = backup_parent.as_ref();
    let canonical_source_root = canonical_data_root(source_root)?;
    let canonical_backup_parent = canonical_backup_parent(backup_parent, &canonical_source_root)?;
    let backup_root = canonical_backup_parent.join(format!("sv2-data-backup-{}", Uuid::new_v4()));

    fs::create_dir(&backup_root)
        .map_err(|error| format!("cannot create backup directory: {error}"))?;
    (|| {
        restrict_output_permissions(&backup_root)?;
        let copied = copy_tree(&canonical_source_root, &backup_root)?;
        let verified = inspect_tree(&canonical_source_root)?;
        if copied != verified {
            return Err("SV2 data changed while backing up; backup was rejected".to_string());
        }
        let manifest = manifest(&canonical_source_root, &copied)?;
        write_manifest(&backup_root, &manifest)?;
        let session = copied
            .iter()
            .find(|entry| entry.relative == Path::new("license").join("session"));
        Ok(Sv2DataBackup {
            backup_root: backup_root.clone(),
            canonical_source_root,
            file_count: manifest.files.len(),
            session_path: session.map(|entry| entry.relative.clone()),
            session_sha256: session.and_then(|entry| entry.sha256.clone()),
        })
    })()
}

fn canonical_data_root(source_root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(source_root)
        .map_err(|error| format!("cannot inspect SV2 data root: {error}"))?;
    if !is_reparse_point(&metadata) && !metadata.is_dir() {
        return Err("SV2 data root is not a directory".to_string());
    }
    let canonical = fs::canonicalize(source_root)
        .map_err(|error| format!("cannot canonicalize SV2 data root: {error}"))?;
    let canonical_metadata = fs::symlink_metadata(&canonical)
        .map_err(|error| format!("cannot inspect canonical SV2 data root: {error}"))?;
    if is_reparse_point(&canonical_metadata) || !canonical_metadata.is_dir() {
        return Err("canonical SV2 data root is unsafe".to_string());
    }
    Ok(canonical)
}

fn canonical_backup_parent(backup_parent: &Path, source_root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(backup_parent)
        .map_err(|error| format!("cannot inspect backup parent: {error}"))?;
    if is_reparse_point(&metadata) || !metadata.is_dir() {
        return Err("backup parent must be a normal directory".to_string());
    }
    let canonical = fs::canonicalize(backup_parent)
        .map_err(|error| format!("cannot canonicalize backup parent: {error}"))?;
    if canonical.starts_with(source_root) {
        return Err("backup parent must be outside the SV2 data root".to_string());
    }
    Ok(canonical)
}

fn copy_tree(source_root: &Path, backup_root: &Path) -> Result<Vec<TreeEntry>, String> {
    let mut entries = Vec::new();
    copy_directory(source_root, source_root, backup_root, &mut entries)?;
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(entries)
}

fn copy_directory(
    source_root: &Path,
    directory: &Path,
    backup_root: &Path,
    entries: &mut Vec<TreeEntry>,
) -> Result<(), String> {
    let relative = directory
        .strip_prefix(source_root)
        .map_err(|_| "SV2 data traversal escaped its root".to_string())?;
    let metadata = safe_metadata(directory)?;
    if !metadata.is_dir() {
        return Err("SV2 data directory changed during traversal".to_string());
    }
    entries.push(TreeEntry {
        relative: relative.to_path_buf(),
        kind: EntryKind::Directory,
        stamp: directory_stamp(&metadata),
        sha256: None,
    });
    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("cannot read SV2 data directory: {error}"))?
        .map(|entry| entry.map_err(|error| format!("cannot read SV2 data entry: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let child_metadata = safe_metadata(&path)?;
        if child_metadata.is_dir() {
            let destination = backup_root.join(path.strip_prefix(source_root).unwrap());
            fs::create_dir(&destination)
                .map_err(|error| format!("cannot create backup directory: {error}"))?;
            restrict_output_permissions(&destination)?;
            copy_directory(source_root, &path, backup_root, entries)?;
        } else if child_metadata.is_file() {
            let relative = path.strip_prefix(source_root).unwrap().to_path_buf();
            let destination = backup_root.join(&relative);
            let (stamp, sha256) = copy_stable_file(&path, &destination, &child_metadata)?;
            entries.push(TreeEntry {
                relative,
                kind: EntryKind::File,
                stamp,
                sha256: Some(sha256),
            });
        } else {
            return Err(format!(
                "SV2 data contains a non-regular entry: {}",
                path.display()
            ));
        }
    }
    let after = safe_metadata(directory)?;
    if directory_stamp(&metadata) != directory_stamp(&after) {
        return Err("SV2 data directory changed during traversal".to_string());
    }
    Ok(())
}

fn inspect_tree(source_root: &Path) -> Result<Vec<TreeEntry>, String> {
    let mut entries = Vec::new();
    inspect_directory(source_root, source_root, &mut entries)?;
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(entries)
}

fn inspect_directory(
    source_root: &Path,
    directory: &Path,
    entries: &mut Vec<TreeEntry>,
) -> Result<(), String> {
    let relative = directory
        .strip_prefix(source_root)
        .map_err(|_| "SV2 data traversal escaped its root".to_string())?;
    let metadata = safe_metadata(directory)?;
    if !metadata.is_dir() {
        return Err("SV2 data directory changed during verification".to_string());
    }
    entries.push(TreeEntry {
        relative: relative.to_path_buf(),
        kind: EntryKind::Directory,
        stamp: directory_stamp(&metadata),
        sha256: None,
    });
    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("cannot verify SV2 data directory: {error}"))?
        .map(|entry| entry.map_err(|error| format!("cannot verify SV2 data entry: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let child_metadata = safe_metadata(&path)?;
        if child_metadata.is_dir() {
            inspect_directory(source_root, &path, entries)?;
        } else if child_metadata.is_file() {
            let (stamp, sha256) = hash_stable_file(&path, &child_metadata)?;
            entries.push(TreeEntry {
                relative: path.strip_prefix(source_root).unwrap().to_path_buf(),
                kind: EntryKind::File,
                stamp,
                sha256: Some(sha256),
            });
        } else {
            return Err(format!(
                "SV2 data contains a non-regular entry: {}",
                path.display()
            ));
        }
    }
    let after = safe_metadata(directory)?;
    if directory_stamp(&metadata) != directory_stamp(&after) {
        return Err("SV2 data directory changed during verification".to_string());
    }
    Ok(())
}

fn copy_stable_file(
    path: &Path,
    destination: &Path,
    expected: &fs::Metadata,
) -> Result<(EntryStamp, String), String> {
    let mut output = new_output_file(destination)?;
    let (stamp, sha256) = read_stable_file(path, expected, |chunk| output.write_all(chunk))?;
    output
        .sync_all()
        .map_err(|error| format!("cannot sync backup file: {error}"))?;
    drop(output);
    let copied = sha256_file(destination)?;
    if copied != sha256 {
        return Err("backup file verification failed".to_string());
    }
    Ok((stamp, sha256))
}

fn hash_stable_file(path: &Path, expected: &fs::Metadata) -> Result<(EntryStamp, String), String> {
    read_stable_file(path, expected, |_| Ok(()))
}

fn read_stable_file(
    path: &Path,
    expected: &fs::Metadata,
    mut consume: impl FnMut(&[u8]) -> std::io::Result<()>,
) -> Result<(EntryStamp, String), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .share_mode(0);
    let mut file = options
        .open(path)
        .map_err(|error| format!("cannot open SV2 data file: {error}"))?;
    let before = file
        .metadata()
        .map_err(|error| format!("cannot inspect SV2 data file: {error}"))?;
    let stamp = file_stamp(&file, &before)?;
    if is_reparse_point(&before)
        || !before.is_file()
        || directory_stamp(&before) != directory_stamp(expected)
    {
        return Err("SV2 data file changed before backup".to_string());
    }
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read SV2 data file: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        consume(&buffer[..read]).map_err(|error| format!("cannot write backup file: {error}"))?;
        bytes += read as u64;
    }
    let after = file
        .metadata()
        .map_err(|error| format!("cannot inspect SV2 data file: {error}"))?;
    let path_after = safe_metadata(path)?;
    if bytes != before.len()
        || stamp != file_stamp(&file, &after)?
        || directory_stamp(&after) != directory_stamp(&path_after)
    {
        return Err("SV2 data file changed while being read".to_string());
    }
    Ok((stamp, hex::encode(digest.finalize())))
}

fn manifest(source_root: &Path, entries: &[TreeEntry]) -> Result<Manifest, String> {
    let mut files = Vec::new();
    for entry in entries.iter().filter(|entry| entry.kind == EntryKind::File) {
        files.push(ManifestFile {
            path: path_text(&entry.relative)?,
            bytes: entry.stamp.bytes,
            sha256: entry
                .sha256
                .clone()
                .ok_or_else(|| "file hash missing from backup".to_string())?,
        });
    }
    Ok(Manifest {
        format_version: 1,
        created_at_utc: Utc::now().to_rfc3339(),
        canonical_source_root: source_root.to_string_lossy().into_owned(),
        files,
    })
}

fn write_manifest(backup_root: &Path, manifest: &Manifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("cannot encode backup manifest: {error}"))?;
    let path = backup_root.join(MANIFEST_NAME);
    let mut output = new_output_file(&path)?;
    output
        .write_all(&bytes)
        .map_err(|error| format!("cannot write backup manifest: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("cannot sync backup manifest: {error}"))?;
    drop(output);
    if fs::read(&path).map_err(|error| format!("cannot verify backup manifest: {error}"))? != bytes
    {
        return Err("backup manifest verification failed".to_string());
    }
    Ok(())
}

fn safe_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect SV2 data entry: {error}"))?;
    if is_reparse_point(&metadata) {
        return Err(format!(
            "SV2 data contains an unexpected reparse point: {}",
            path.display()
        ));
    }
    Ok(metadata)
}

fn directory_stamp(metadata: &fs::Metadata) -> EntryStamp {
    EntryStamp {
        bytes: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(windows)]
        identity: (0, 0),
    }
}

fn file_stamp(_file: &File, metadata: &fs::Metadata) -> Result<EntryStamp, String> {
    Ok(EntryStamp {
        bytes: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(windows)]
        identity: file_identity(_file)?,
    })
}

fn new_output_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("cannot create backup file: {error}"))?;
    restrict_output_permissions(path)?;
    Ok(file)
}

fn restrict_output_permissions(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let sid = crate::sv2_account_probe::current_user_sid()
            .map_err(|_| "cannot determine current user for backup permissions".to_string())?;
        let grant = if path.is_dir() {
            format!("*{sid}:(OI)(CI)(F)")
        } else {
            format!("*{sid}:(R,W)")
        };
        let output = quiet_command("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(grant)
            .output()
            .map_err(|error| format!("cannot set backup permissions: {error}"))?;
        if !output.status.success() {
            return Err("cannot set backup permissions".to_string());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if path.is_dir() { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("cannot set backup permissions: {error}"))?;
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("cannot verify backup file: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot verify backup file: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|value| value.replace('\\', "/"))
        .ok_or_else(|| "SV2 data path is not valid Unicode".to_string())
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || metadata.file_type().is_symlink()
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<(u32, u64), String> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) } == 0 {
        return Err("cannot inspect SV2 data file identity".to_string());
    }
    Ok((
        information.dwVolumeSerialNumber,
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    ))
}
