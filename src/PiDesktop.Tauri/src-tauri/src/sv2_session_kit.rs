//! Offline, explicit-path session inspection and recovery support.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::sv2_account_probe::{
    decrypt_session, encrypt_session, read_machine_key, validate_session_plaintext_for_offline_tool,
};

const MAX_SESSION_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionText {
    plaintext: Zeroizing<String>,
    products: Vec<ProductRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProductRow {
    database_id: String,
    product_id: String,
    name: String,
    vendor: String,
    category: String,
    version: String,
    unknown_fields: Vec<(String, String)>,
}

/// Redacted, local-only metadata exposed to the Toolbox interface.
///
/// This deliberately contains no JWT, device identifier, or user identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SessionCredentialMetadata {
    pub access_token_length: usize,
    pub refresh_token_length: usize,
    pub access_expiry: String,
    pub written_at: String,
    pub device_identifier_length: usize,
    pub user_identifier_length: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SessionCachedField {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SessionCachedProduct {
    pub fields: Vec<Sv2SessionCachedField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SessionInspection {
    pub path: String,
    pub sha256: String,
    pub encrypted_bytes: usize,
    pub plaintext_lines: usize,
    pub credentials: Sv2SessionCredentialMetadata,
    pub cached_products: Vec<Sv2SessionCachedProduct>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SessionReplacementPreview {
    pub source: Sv2SessionInspection,
    pub destination: Sv2SessionInspection,
}

impl SessionText {
    fn parse(plaintext: Zeroizing<Vec<u8>>) -> Result<Self, String> {
        let text = String::from_utf8(plaintext.to_vec())
            .map_err(|_| "session plaintext is not UTF-8".to_string())?;
        if text.is_empty() || text.len() > MAX_SESSION_BYTES || text.contains('\r') {
            return Err("session plaintext has an unsafe size or line ending".to_string());
        }
        validate_session_plaintext_for_offline_tool(text.as_bytes()).map_err(|_| {
            "session plaintext does not match the supported offline format".to_string()
        })?;
        let lines = text.split('\n').collect::<Vec<_>>();
        let product_start = match lines.get(5) {
            Some(line) if line.starts_with("K1=") => 5,
            Some(_) => 6,
            None => 5,
        };
        let products = lines
            .iter()
            .skip(product_start)
            .filter_map(|line| ProductRow::parse(line))
            .collect();
        Ok(Self {
            plaintext: Zeroizing::new(text),
            products,
        })
    }

    fn credential_metadata(&self) -> String {
        let lines = self.plaintext.split('\n').collect::<Vec<_>>();
        format!(
            "access_jwt=redacted(len={})\nrefresh_jwt=redacted(len={})\naccess_expiry={}\nwritten={}\ndevice=redacted(len={})\nuser_id={}",
            lines[0].len(),
            lines[1].len(),
            lines[2],
            lines[3],
            lines[4].len(),
            if lines.get(5).is_some_and(|line| line.starts_with("K1=")) { "absent".to_string() } else { lines.get(5).map(|value| format!("redacted(len={})", value.len())).unwrap_or_else(|| "absent".to_string()) },
        )
    }

    fn redacted_credential_metadata(&self) -> Sv2SessionCredentialMetadata {
        let lines = self.plaintext.split('\n').collect::<Vec<_>>();
        let user_identifier = lines
            .get(5)
            .filter(|line| !line.starts_with("K1="))
            .map(|line| line.len());
        Sv2SessionCredentialMetadata {
            access_token_length: lines[0].len(),
            refresh_token_length: lines[1].len(),
            access_expiry: lines[2].to_string(),
            written_at: lines[3].to_string(),
            device_identifier_length: lines[4].len(),
            user_identifier_length: user_identifier,
        }
    }

    fn cached_products(&self) -> Vec<Sv2SessionCachedProduct> {
        self.products
            .iter()
            .map(|product| {
                let mut fields = vec![
                    ("K1", product.database_id.as_str()),
                    ("K2", product.product_id.as_str()),
                    ("K3", product.name.as_str()),
                    ("K4", product.vendor.as_str()),
                    ("K5", product.category.as_str()),
                    ("K6", product.version.as_str()),
                ]
                .into_iter()
                .map(|(key, value)| Sv2SessionCachedField {
                    key: key.to_string(),
                    value: value.to_string(),
                })
                .collect::<Vec<_>>();
                fields.extend(product.unknown_fields.iter().map(|(key, value)| {
                    Sv2SessionCachedField {
                        key: key.clone(),
                        value: value.clone(),
                    }
                }));
                Sv2SessionCachedProduct { fields }
            })
            .collect()
    }

    fn summary(&self) -> String {
        let mut output = self.credential_metadata();
        output.push_str(&format!(
            "\nlicense_status=unverified\ncached_products_unverified={} (local metadata; not license proof)",
            self.products.len()
        ));
        for product in &self.products {
            output.push_str(&format!(
                "\nproduct database_id={} product_id={} name={} vendor={} category={} version={} unknown_fields={}",
                product.database_id, product.product_id, product.name, product.vendor, product.category,
                product.version, product.unknown_fields.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join(" ")
            ));
        }
        output
    }

    fn header(&self, index: usize) -> &str {
        self.plaintext.split('\n').nth(index).unwrap_or("")
    }
}

impl ProductRow {
    fn parse(line: &str) -> Option<Self> {
        let fields = line
            .split(';')
            .map(|field| field.split_once('='))
            .collect::<Option<Vec<_>>>()?;
        let value = |key| {
            fields
                .iter()
                .find(|(candidate, _)| *candidate == key)
                .map(|(_, value)| (*value).to_string())
        };
        let (
            Some(database_id),
            Some(product_id),
            Some(name),
            Some(vendor),
            Some(category),
            Some(version),
        ) = (
            value("K1"),
            value("K2"),
            value("K3"),
            value("K4"),
            value("K5"),
            value("K6"),
        )
        else {
            return None;
        };
        Some(Self {
            database_id,
            product_id,
            name,
            vendor,
            category,
            version,
            unknown_fields: fields
                .into_iter()
                .filter(|(key, _)| !matches!(*key, "K1" | "K2" | "K3" | "K4" | "K5" | "K6"))
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        })
    }
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn verify_hash(bytes: &[u8], expected: &str, label: &str) -> Result<(), String> {
    if hash(bytes) == expected {
        Ok(())
    } else {
        Err(format!("{label} hash guard did not match"))
    }
}

fn read_ciphertext(path: &Path) -> Result<Zeroizing<Vec<u8>>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if bytes.is_empty() || bytes.len() > MAX_SESSION_BYTES || !bytes.len().is_multiple_of(8) {
        return Err("encrypted session has an invalid size".to_string());
    }
    Ok(Zeroizing::new(bytes))
}

fn decode_path(path: &Path) -> Result<SessionText, String> {
    let ciphertext = read_ciphertext(path)?;
    decode_bytes(ciphertext)
}

fn inspect_path(path: &Path) -> Result<Sv2SessionInspection, String> {
    let bytes = read_ciphertext(path)?;
    let session = decode_bytes(bytes.clone())?;
    Ok(Sv2SessionInspection {
        path: path.to_string_lossy().into_owned(),
        sha256: hash(&bytes),
        encrypted_bytes: bytes.len(),
        plaintext_lines: session.plaintext.lines().count(),
        credentials: session.redacted_credential_metadata(),
        cached_products: session.cached_products(),
    })
}

pub fn preview_replacement(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<Sv2SessionReplacementPreview, String> {
    let source = source.as_ref();
    let destination = destination.as_ref();
    if fs::canonicalize(source).ok() == fs::canonicalize(destination).ok() {
        return Err("source and destination session files must be different".to_string());
    }
    Ok(Sv2SessionReplacementPreview {
        source: inspect_path(source)?,
        destination: inspect_path(destination)?,
    })
}

fn decode_bytes(ciphertext: Zeroizing<Vec<u8>>) -> Result<SessionText, String> {
    let key = read_machine_key().map_err(|_| "native machine key is unavailable".to_string())?;
    let plaintext = decrypt_session(ciphertext, &key)
        .map_err(|_| "unable to decrypt session for this machine".to_string())?;
    SessionText::parse(plaintext)
}

fn encode_text(plaintext_path: &Path) -> Result<Zeroizing<Vec<u8>>, String> {
    let plaintext = fs::read(plaintext_path)
        .map_err(|error| format!("cannot read {}: {error}", plaintext_path.display()))?;
    let session = SessionText::parse(Zeroizing::new(plaintext))?;
    let key = read_machine_key().map_err(|_| "native machine key is unavailable".to_string())?;
    encrypt_session(session.plaintext.as_bytes(), &key)
        .map_err(|_| "cannot encrypt session plaintext".to_string())
}

fn require_new_path(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(format!(
            "refusing to overwrite existing file: {}",
            path.display()
        ));
    }
    path.parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| format!("output parent does not exist: {}", path.display()))?;
    Ok(())
}

fn restrict_permissions(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let sid = crate::sv2_account_probe::current_user_sid()
            .map_err(|_| "cannot determine process user SID for output ACL".to_string())?;
        let grant = format!("*{sid}:(R,W)");
        let output = Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(grant)
            .output()
            .map_err(|error| format!("cannot set output ACL: {error}"))?;
        if !output.status.success() {
            return Err("cannot set output ACL".to_string());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("cannot set output permissions: {error}"))?;
    }
    Ok(())
}

fn write_new_restricted(path: &Path, bytes: &[u8]) -> Result<(), String> {
    require_new_path(path)?;
    let mut created = false;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|error| format!("cannot create {}: {error}", path.display()))?;
        created = true;
        restrict_permissions(path)?;
        file.write_all(bytes)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync {}: {error}", path.display()))?;
        drop(file);
        Ok(())
    })();
    if result.is_err() && created {
        let _ = fs::remove_file(path);
    }
    result
}

fn process_conflict(_exempt_pid: Option<u32>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .output()
            .map_err(|error| format!("cannot inspect running processes: {error}"))?;
        if !output.status.success() {
            return Err("cannot inspect running processes".to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            let columns = line
                .split(",\"")
                .map(|part| part.trim_matches('"'))
                .collect::<Vec<_>>();
            let image = columns.first().copied().unwrap_or("").to_ascii_lowercase();
            let pid = columns.get(1).and_then(|value| value.parse::<u32>().ok());
            matches!(image.as_str(), "synthv-studio.exe" | "synthv-toolbox.exe")
                && pid != _exempt_pid
        }))
    }
    #[cfg(not(windows))]
    {
        Err("process discovery is unavailable on this platform; apply is disabled".to_string())
    }
}

fn backup_name(destination: &Path) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "destination has no parent".to_string())?;
    let stem = destination
        .file_name()
        .ok_or_else(|| "destination has no file name".to_string())?
        .to_string_lossy();
    Ok(parent.join(format!(
        "{stem}.session-kit-backup-{}.bin",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    )))
}

fn create_verified_backup(
    destination: &Path,
    bytes: &[u8],
    expected_hash: &str,
) -> Result<PathBuf, String> {
    let backup = backup_name(destination)?;
    write_new_restricted(&backup, bytes)?;
    if hash(&fs::read(&backup).map_err(|error| error.to_string())?) != expected_hash {
        return Err("backup verification failed; destination was not changed".to_string());
    }
    Ok(backup)
}

fn replace_with_recovery(
    destination: &Path,
    source: &[u8],
    original: &[u8],
    source_hash: &str,
    destination_hash: &str,
) -> Result<(), String> {
    verify_hash(original, destination_hash, "recovery image")?;
    let temporary = destination.with_extension(format!("session-kit-{}.tmp", std::process::id()));
    write_new_restricted(&temporary, source)?;
    fs::rename(&temporary, destination)
        .map_err(|error| format!("atomic replace failed; destination preserved: {error}"))?;
    if read_ciphertext(destination)
        .map(|bytes| hash(&bytes) == source_hash)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let restore =
        destination.with_extension(format!("session-kit-restore-{}.tmp", std::process::id()));
    write_new_restricted(&restore, original)?;
    fs::rename(&restore, destination).map_err(|error| {
        format!("replacement verification failed and backup restoration failed: {error}")
    })?;
    if read_ciphertext(destination)
        .map(|bytes| hash(&bytes) == destination_hash)
        .unwrap_or(false)
    {
        Err("replacement verification failed; verified backup was restored".to_string())
    } else {
        Err(
            "replacement verification failed and backup restoration verification failed"
                .to_string(),
        )
    }
}

fn apply_verified_with_process_exception(
    source: &Path,
    destination: &Path,
    source_hash: &str,
    destination_hash: &str,
    exempt_pid: Option<u32>,
) -> Result<PathBuf, String> {
    let source_bytes = read_ciphertext(source)?;
    verify_hash(&source_bytes, source_hash, "source")?;
    decode_bytes(source_bytes.clone())?;
    if process_conflict(exempt_pid)? {
        return Err("SV2 or Toolbox appears to be running; close it before apply".to_string());
    }
    let destination_bytes = read_ciphertext(destination)?;
    verify_hash(&destination_bytes, destination_hash, "destination")?;
    decode_bytes(destination_bytes.clone())?;
    let backup = create_verified_backup(destination, &destination_bytes, destination_hash)?;
    if hash(&read_ciphertext(destination)?) != destination_hash {
        return Err("destination changed after preview; refusing replace".to_string());
    }
    replace_with_recovery(
        destination,
        &source_bytes,
        &destination_bytes,
        source_hash,
        destination_hash,
    )?;
    Ok(backup)
}

fn apply_verified(
    source: &Path,
    destination: &Path,
    source_hash: &str,
    destination_hash: &str,
) -> Result<PathBuf, String> {
    apply_verified_with_process_exception(source, destination, source_hash, destination_hash, None)
}

pub fn validate_replacement_request(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    source_hash: &str,
    destination_hash: &str,
) -> Result<(), String> {
    let source = source.as_ref();
    let destination = destination.as_ref();
    if fs::canonicalize(source).ok() == fs::canonicalize(destination).ok() {
        return Err("source and destination session files must be different".to_string());
    }
    let source_bytes = read_ciphertext(source)?;
    verify_hash(&source_bytes, source_hash, "source")?;
    decode_bytes(source_bytes)?;
    let destination_bytes = read_ciphertext(destination)?;
    verify_hash(&destination_bytes, destination_hash, "destination")?;
    decode_bytes(destination_bytes)?;
    Ok(())
}

fn wait_for_process_exit(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        for _ in 0..150 {
            let output = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output()
                .map_err(|error| format!("cannot inspect Toolbox handoff process: {error}"))?;
            if !output.status.success() {
                return Err("cannot inspect Toolbox handoff process".to_string());
            }
            let list = String::from_utf8_lossy(&output.stdout);
            if !list.lines().any(|line| {
                line.split(",\"")
                    .nth(1)
                    .map(|value| value.trim_matches('"').trim() == pid.to_string())
                    .unwrap_or(false)
            }) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Err("Toolbox did not exit in time; session was not changed".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("session replacement handoff is only available on Windows".to_string())
    }
}

pub fn run_handoff<I>(args: I) -> Result<(), String>
where
    I: IntoIterator<Item = OsString>,
{
    let args = args.into_iter().skip(1).collect::<Vec<_>>();
    let mut parent_pid = None;
    let mut source = None;
    let mut destination = None;
    let mut source_hash = None;
    let mut destination_hash = None;
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_str();
        let next = args.get(index + 1).map(OsString::as_os_str);
        match value {
            Some("--session-kit-handoff") => index += 1,
            Some("--parent-pid") if parent_pid.is_none() => {
                parent_pid = next
                    .and_then(|candidate| candidate.to_str())
                    .and_then(|candidate| candidate.parse::<u32>().ok());
                index += 2;
            }
            Some("--source") if source.is_none() => {
                source = next.map(PathBuf::from);
                index += 2;
            }
            Some("--destination") if destination.is_none() => {
                destination = next.map(PathBuf::from);
                index += 2;
            }
            Some("--source-sha256") if source_hash.is_none() => {
                source_hash = next.map(|candidate| candidate.to_string_lossy().into_owned());
                index += 2;
            }
            Some("--destination-sha256") if destination_hash.is_none() => {
                destination_hash = next.map(|candidate| candidate.to_string_lossy().into_owned());
                index += 2;
            }
            _ => return Err("invalid session replacement handoff request".to_string()),
        }
    }
    let parent_pid = parent_pid.ok_or_else(|| "missing Toolbox handoff process".to_string())?;
    let source = source.ok_or_else(|| "missing session source".to_string())?;
    let destination = destination.ok_or_else(|| "missing session destination".to_string())?;
    let source_hash = source_hash.ok_or_else(|| "missing source hash guard".to_string())?;
    let destination_hash =
        destination_hash.ok_or_else(|| "missing destination hash guard".to_string())?;
    wait_for_process_exit(parent_pid)?;
    let backup = apply_verified_with_process_exception(
        &source,
        &destination,
        &source_hash,
        &destination_hash,
        Some(std::process::id()),
    )?;
    println!(
        "applied verified encrypted session; backup={}",
        backup.display()
    );
    Ok(())
}

fn usage() -> &'static str {
    "Usage:\n  sv2-session-kit inspect <encrypted-session>\n  sv2-session-kit compare <left> <right>\n  sv2-session-kit export <encrypted-session> <new-plaintext-output>\n  sv2-session-kit encode <plaintext-session> <new-encrypted-output>\n  sv2-session-kit apply <encrypted-source> <destination> --source-sha256 <hash> --destination-sha256 <hash> [--commit]\n\nAll commands are offline. Inspect and compare redact credentials. Export writes plaintext only to an explicit new local file. Apply previews unless --commit is supplied."
}

pub fn run<I>(args: I) -> Result<(), String>
where
    I: IntoIterator<Item = OsString>,
{
    let args = args.into_iter().skip(1).collect::<Vec<_>>();
    let command = args.first().and_then(|value| value.to_str()).unwrap_or("");
    match command {
        "--help" | "-h" => println!("{}", usage()),
        "inspect" if args.len() == 2 => {
            let bytes = read_ciphertext(Path::new(&args[1]))?;
            let session = decode_bytes(bytes.clone())?;
            println!(
                "sha256={}\nencrypted_bytes={}\nplaintext_lines={}\n{}",
                hash(&bytes),
                bytes.len(),
                session.plaintext.lines().count(),
                session.summary()
            );
        }
        "compare" if args.len() == 3 => {
            let left_bytes = read_ciphertext(Path::new(&args[1]))?;
            let right_bytes = read_ciphertext(Path::new(&args[2]))?;
            let left_hash = hash(&left_bytes);
            let right_hash = hash(&right_bytes);
            let left = decode_bytes(left_bytes)?;
            let right = decode_bytes(right_bytes)?;
            println!(
                "left_sha256={}\nright_sha256={}\naccess_changed={}\nrefresh_changed={}\ndevice_changed={}\nuser_id_field_changed={}\nproducts_added={}\nproducts_removed={}",
                left_hash,
                right_hash,
                left.header(0) != right.header(0), left.header(1) != right.header(1),
                left.header(4) != right.header(4), left.header(5) != right.header(5),
                right.products.iter().filter(|product| !left.products.contains(product)).count(),
                left.products.iter().filter(|product| !right.products.contains(product)).count()
            );
        }
        "export" if args.len() == 3 => {
            let session = decode_path(Path::new(&args[1]))?;
            write_new_restricted(Path::new(&args[2]), session.plaintext.as_bytes())?;
            println!("exported plaintext to {}", Path::new(&args[2]).display());
        }
        "encode" if args.len() == 3 => {
            let encrypted = encode_text(Path::new(&args[1]))?;
            write_new_restricted(Path::new(&args[2]), &encrypted)?;
            println!(
                "encoded encrypted session to {}",
                Path::new(&args[2]).display()
            );
        }
        "apply" => {
            if args.len() < 7 {
                return Err(usage().to_string());
            }
            let source = Path::new(&args[1]);
            let destination = Path::new(&args[2]);
            let mut source_hash = None;
            let mut destination_hash = None;
            let mut commit = false;
            let mut index = 3;
            while index < args.len() {
                match args[index].to_str() {
                    Some("--commit") if !commit => {
                        commit = true;
                        index += 1;
                    }
                    Some("--source-sha256") if source_hash.is_none() && index + 1 < args.len() => {
                        source_hash = Some(args[index + 1].to_string_lossy().into_owned());
                        index += 2;
                    }
                    Some("--destination-sha256")
                        if destination_hash.is_none() && index + 1 < args.len() =>
                    {
                        destination_hash = Some(args[index + 1].to_string_lossy().into_owned());
                        index += 2;
                    }
                    _ => return Err("unknown, duplicate, or incomplete apply flag".to_string()),
                }
            }
            let source_hash =
                source_hash.ok_or_else(|| "--source-sha256 is required".to_string())?;
            let destination_hash =
                destination_hash.ok_or_else(|| "--destination-sha256 is required".to_string())?;
            if !commit {
                let source_bytes = read_ciphertext(source)?;
                let destination_bytes = read_ciphertext(destination)?;
                if hash(&source_bytes) != source_hash
                    || hash(&destination_bytes) != destination_hash
                {
                    return Err("supplied hash guard does not match preview input".to_string());
                }
                let left = decode_bytes(source_bytes)?;
                let right = decode_bytes(destination_bytes)?;
                println!("preview only\nsource_sha256={}\ndestination_sha256={}\naccess_changed={}\nrefresh_changed={}\nproducts_added={}\nproducts_removed={}\nrun again with --commit", source_hash, destination_hash, left.header(0) != right.header(0), left.header(1) != right.header(1), left.products.iter().filter(|item| !right.products.contains(item)).count(), right.products.iter().filter(|item| !left.products.contains(item)).count());
            } else {
                let backup = apply_verified(source, destination, &source_hash, &destination_hash)?;
                println!(
                    "applied verified encrypted session; backup={}",
                    backup.display()
                );
            }
        }
        _ => return Err(usage().to_string()),
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../../../test/sv2_session_kit.rs"]
mod tests;
