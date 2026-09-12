//! Offline, explicit-path session inspection and recovery support.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

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
            .map(|field| field.split_once('=').map(|(key, value)| (key, value)))
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
        let user = std::env::var("USERNAME")
            .map_err(|_| "cannot determine current user for output ACL".to_string())?;
        let grant = format!("{user}:(R,W)");
        let status = Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(grant)
            .status()
            .map_err(|error| format!("cannot set output ACL: {error}"))?;
        if !status.success() {
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
        restrict_permissions(path)?;
        file.write_all(bytes)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync {}: {error}", path.display()))?;
        drop(file);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn process_conflict() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .output()
            .map_err(|error| format!("cannot inspect running processes: {error}"))?;
        if !output.status.success() {
            return Err("cannot inspect running processes".to_string());
        }
        let list = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        return Ok(["synthv-studio", "synthv-toolbox"]
            .iter()
            .any(|name| list.contains(name)));
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

fn apply_verified(
    source: &Path,
    destination: &Path,
    source_hash: &str,
    destination_hash: &str,
) -> Result<PathBuf, String> {
    let source_bytes = read_ciphertext(source)?;
    if hash(&source_bytes) != source_hash {
        return Err("source hash guard did not match".to_string());
    }
    decode_bytes(source_bytes.clone())?;
    if process_conflict()? {
        return Err("SV2 or Toolbox appears to be running; close it before apply".to_string());
    }
    let destination_bytes = read_ciphertext(destination)?;
    if hash(&destination_bytes) != destination_hash {
        return Err("destination hash guard did not match".to_string());
    }
    decode_bytes(destination_bytes.clone())?;
    let backup = create_verified_backup(destination, &destination_bytes, destination_hash)?;
    if hash(&read_ciphertext(destination)?) != destination_hash {
        return Err("destination changed after preview; refusing replace".to_string());
    }
    let temporary = destination.with_extension(format!("session-kit-{}.tmp", std::process::id()));
    write_new_restricted(&temporary, &source_bytes)?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "atomic replace failed; destination preserved: {error}"
        ));
    }
    if hash(&read_ciphertext(destination)?) != source_hash {
        let restore =
            destination.with_extension(format!("session-kit-restore-{}.tmp", std::process::id()));
        let backup_bytes = read_ciphertext(&backup)?;
        if hash(&backup_bytes) != destination_hash || decode_bytes(backup_bytes.clone()).is_err() {
            return Err(
                "replacement verification failed and verified backup is no longer intact"
                    .to_string(),
            );
        }
        write_new_restricted(&restore, &backup_bytes)?;
        if let Err(error) = fs::rename(&restore, destination) {
            let _ = fs::remove_file(&restore);
            return Err(format!(
                "replacement verification failed and backup restoration failed: {error}"
            ));
        }
        if hash(&read_ciphertext(destination)?) != destination_hash {
            return Err(
                "replacement verification failed and backup restoration verification failed"
                    .to_string(),
            );
        }
        return Err("replacement verification failed; verified backup was restored".to_string());
    }
    Ok(backup)
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
            let left = decode_path(Path::new(&args[1]))?;
            let right = decode_path(Path::new(&args[2]))?;
            println!(
                "left_sha256={}\nright_sha256={}\naccess_changed={}\nrefresh_changed={}\ndevice_changed={}\nuser_changed={}\nproducts_added={}\nproducts_removed={}",
                hash(&read_ciphertext(Path::new(&args[1]))?),
                hash(&read_ciphertext(Path::new(&args[2]))?),
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
