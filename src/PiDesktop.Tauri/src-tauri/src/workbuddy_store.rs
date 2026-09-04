use zeroize::{Zeroize, Zeroizing};

use crate::agent::WorkBuddyCredential;

const SERVICE: &str = "com.synthvcopilot.toolbox.workbuddy";

pub struct Backup(Option<Zeroizing<Vec<u8>>>);

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|error| format!("系统凭据库不可用：{error}"))
}

pub fn load(id: &str) -> Result<WorkBuddyCredential, String> {
    let bytes = Zeroizing::new(
        entry(id)?
            .get_secret()
            .map_err(|error| format!("无法读取 WorkBuddy 凭据：{error}"))?,
    );
    let mut stored: StoredCredential =
        serde_json::from_slice(&bytes).map_err(|_| "WorkBuddy 凭据格式无效。".to_string())?;
    Ok(WorkBuddyCredential {
        access: String::new(),
        refresh: std::mem::take(&mut stored.refresh),
        expires_at: 0,
        domain: std::mem::take(&mut stored.domain),
        user_id: std::mem::take(&mut stored.user_id),
        enterprise_id: std::mem::take(&mut stored.enterprise_id),
    })
}

pub fn replace(id: &str, credential: &WorkBuddyCredential) -> Result<Backup, String> {
    let backup = Backup(match entry(id)?.get_secret() {
        Ok(value) => Some(Zeroizing::new(value)),
        Err(keyring::Error::NoEntry) => None,
        Err(error) => return Err(format!("无法读取现有 WorkBuddy 凭据：{error}")),
    });
    let bytes = Zeroizing::new(
        serde_json::to_vec(&StoredCredential::from(credential))
            .map_err(|error| format!("无法编码 WorkBuddy 凭据：{error}"))?,
    );
    entry(id)?
        .set_secret(&bytes)
        .map_err(|error| format!("无法写入 WorkBuddy 凭据：{error}"))?;
    Ok(backup)
}

pub fn take(id: &str) -> Result<Backup, String> {
    let backup = Backup(match entry(id)?.get_secret() {
        Ok(value) => Some(Zeroizing::new(value)),
        Err(keyring::Error::NoEntry) => None,
        Err(error) => return Err(format!("无法读取 WorkBuddy 凭据：{error}")),
    });
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(backup),
        Err(error) => Err(format!("无法删除 WorkBuddy 凭据：{error}")),
    }
}

pub fn restore(id: &str, backup: Backup) -> Result<(), String> {
    match backup.0 {
        Some(bytes) => entry(id)?
            .set_secret(&bytes)
            .map_err(|error| format!("无法恢复 WorkBuddy 凭据：{error}")),
        None => match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法清理 WorkBuddy 凭据：{error}")),
        },
    }
}

pub fn configured(id: &str) -> bool {
    entry(id)
        .ok()
        .and_then(|entry| entry.get_secret().ok().map(Zeroizing::new))
        .is_some_and(|bytes| !bytes.is_empty())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredCredential {
    refresh: String,
    domain: Option<String>,
    user_id: Option<String>,
    enterprise_id: Option<String>,
}

impl Drop for StoredCredential {
    fn drop(&mut self) {
        self.refresh.zeroize();
        if let Some(value) = &mut self.domain {
            value.zeroize();
        }
        if let Some(value) = &mut self.user_id {
            value.zeroize();
        }
        if let Some(value) = &mut self.enterprise_id {
            value.zeroize();
        }
    }
}

impl From<&WorkBuddyCredential> for StoredCredential {
    fn from(value: &WorkBuddyCredential) -> Self {
        Self {
            refresh: value.refresh.clone(),
            domain: value.domain.clone(),
            user_id: value.user_id.clone(),
            enterprise_id: value.enterprise_id.clone(),
        }
    }
}
