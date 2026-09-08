use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use aes_gcm::aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const KEY_FILE: &str = "key.bin";
const RECORD_MAGIC: &[u8; 4] = b"STC1";
const NONCE_BYTES: usize = 12;
const KEY_BYTES: usize = 32;
static KEY_CREATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn read(&self, service: &str, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let path = self.record_path(service, id)?;
        let encrypted = match fs::read(&path) {
            Ok(value) => Zeroizing::new(value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("无法读取本地加密凭据：{error}")),
        };
        if encrypted.len() < RECORD_MAGIC.len() + NONCE_BYTES + 16
            || &encrypted[..RECORD_MAGIC.len()] != RECORD_MAGIC
        {
            return Err("本地加密凭据格式无效。".to_string());
        }
        let key = self.load_existing_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "无法初始化本地凭据加密器。".to_string())?;
        let nonce_start = RECORD_MAGIC.len();
        let ciphertext_start = nonce_start + NONCE_BYTES;
        cipher
            .decrypt(
                Nonce::from_slice(&encrypted[nonce_start..ciphertext_start]),
                Payload {
                    msg: &encrypted[ciphertext_start..],
                    aad: &record_aad(service, id),
                },
            )
            .map(Zeroizing::new)
            .map(Some)
            .map_err(|_| "本地加密凭据无法解密。".to_string())
    }

    pub fn write(&self, service: &str, id: &str, value: &[u8]) -> Result<(), String> {
        let path = self.record_path(service, id)?;
        let key = self.load_or_create_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "无法初始化本地凭据加密器。".to_string())?;
        let nonce = random_bytes::<NONCE_BYTES>();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: value,
                    aad: &record_aad(service, id),
                },
            )
            .map_err(|_| "无法加密本地凭据。".to_string())?;
        let mut record = Vec::with_capacity(RECORD_MAGIC.len() + NONCE_BYTES + ciphertext.len());
        record.extend_from_slice(RECORD_MAGIC);
        record.extend_from_slice(&nonce);
        record.extend_from_slice(&ciphertext);
        write_private_atomic(&path, &record)
    }

    pub fn delete(&self, service: &str, id: &str) -> Result<(), String> {
        let path = self.record_path(service, id)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("无法删除本地加密凭据：{error}")),
        }
    }

    fn record_path(&self, service: &str, id: &str) -> Result<PathBuf, String> {
        if service.is_empty() || id.is_empty() {
            return Err("本地凭据标识不能为空。".to_string());
        }
        let mut digest = Sha256::new();
        digest.update(service.as_bytes());
        digest.update([0]);
        digest.update(id.as_bytes());
        let name = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(self.root.join(format!("{name}.bin")))
    }

    fn load_existing_key(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        read_key(&self.root.join(KEY_FILE))
            .map_err(|error| format!("无法读取本地凭据密钥：{error}"))
    }

    fn load_or_create_key(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        ensure_private_directory(&self.root)?;
        let path = self.root.join(KEY_FILE);
        let _guard = KEY_CREATION_LOCK
            .lock()
            .map_err(|_| "本地凭据密钥锁已损坏。".to_string())?;
        match read_key(&path) {
            Ok(key) => Ok(key),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let key = Zeroizing::new(random_bytes::<KEY_BYTES>().to_vec());
                match write_private_new(&path, &key) {
                    Ok(()) => Ok(key),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        read_key(&path).map_err(|error| format!("无法读取本地凭据密钥：{error}"))
                    }
                    Err(error) => Err(format!("无法创建本地凭据密钥：{error}")),
                }
            }
            Err(error) => Err(format!("无法读取本地凭据密钥：{error}")),
        }
    }
}

fn read_key(path: &Path) -> std::io::Result<Zeroizing<Vec<u8>>> {
    let mut key = Zeroizing::new(Vec::with_capacity(KEY_BYTES));
    File::open(path)
        .take((KEY_BYTES + 1) as u64)
        .read_to_end(&mut key)?;
    if key.len() == KEY_BYTES {
        Ok(key)
    } else {
        key.zeroize();
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid credential key length",
        ))
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("无法创建本地凭据目录：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护本地凭据目录：{error}"))?;
    }
    #[cfg(windows)]
    set_windows_owner_only_permissions(path)?;
    Ok(())
}

#[cfg(windows)]
fn set_windows_owner_only_permissions(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR,
    };

    let mut name = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let descriptor = "D:P(A;OICI;FA;;;OW)\0".encode_utf16().collect::<Vec<_>>();
    let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor.as_ptr(),
            1,
            &mut security_descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(format!(
            "无法创建本地凭据目录访问控制：{}",
            std::io::Error::last_os_error()
        ));
    }
    let result = unsafe {
        SetFileSecurityW(
            name.as_mut_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            security_descriptor,
        )
    };
    unsafe {
        LocalFree(security_descriptor);
    }
    if result == 0 {
        return Err(format!(
            "无法限制本地凭据目录访问控制：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn write_private_new(path: &Path, value: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(value)?;
    file.sync_all()
}

fn write_private_atomic(path: &Path, value: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "本地凭据路径没有父目录。".to_string())?;
    ensure_private_directory(parent)?;
    let temporary = parent.join(format!(".credential-{}.tmp", Uuid::new_v4().simple()));
    let result = write_private_new(&temporary, value).and_then(|()| fs::rename(&temporary, path));
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法原子写入本地加密凭据：{error}"));
    }
    Ok(())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn record_aad(service: &str, id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(service.len() + id.len() + 1);
    aad.extend_from_slice(service.as_bytes());
    aad.push(0);
    aad.extend_from_slice(id.as_bytes());
    aad
}
