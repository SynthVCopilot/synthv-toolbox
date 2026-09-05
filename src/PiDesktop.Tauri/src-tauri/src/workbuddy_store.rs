use zeroize::{Zeroize, Zeroizing};

use crate::agent::WorkBuddyCredential;

const ACCESS_SERVICE: &str = "com.synthvcopilot.toolbox.workbuddy.access";
const ROUTING_SERVICE: &str = "com.synthvcopilot.toolbox.workbuddy.routing";

pub struct Backup {
    access: Option<Zeroizing<Vec<u8>>>,
    routing: Option<Zeroizing<Vec<u8>>>,
}

fn entry(service: &str, id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, id).map_err(|error| format!("系统凭据库不可用：{error}"))
}

fn optional_secret(service: &str, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    match entry(service, id)?.get_secret() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取现有 WorkBuddy 凭据：{error}")),
    }
}

fn read_backup(id: &str) -> Result<Backup, String> {
    Ok(Backup {
        access: optional_secret(ACCESS_SERVICE, id)?,
        routing: optional_secret(ROUTING_SERVICE, id)?,
    })
}

fn set_or_delete(
    service: &str,
    id: &str,
    value: Option<&Zeroizing<Vec<u8>>>,
) -> Result<(), String> {
    match value {
        Some(bytes) => entry(service, id)?
            .set_secret(bytes)
            .map_err(|error| format!("无法恢复 WorkBuddy 凭据：{error}")),
        None => match entry(service, id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法清理 WorkBuddy 凭据：{error}")),
        },
    }
}

fn restore_from(id: &str, backup: &Backup) -> Result<(), String> {
    let access_result = set_or_delete(ACCESS_SERVICE, id, backup.access.as_ref());
    let routing_result = set_or_delete(ROUTING_SERVICE, id, backup.routing.as_ref());
    match (access_result, routing_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(access), Err(routing)) => Err(format!("{access}；{routing}")),
    }
}

pub fn load(id: &str) -> Result<WorkBuddyCredential, String> {
    let access_bytes = optional_secret(ACCESS_SERVICE, id)?
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| "系统凭据库中没有此 WorkBuddy access token。".to_string())?;
    let routing_bytes = optional_secret(ROUTING_SERVICE, id)?
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| "系统凭据库中没有此 WorkBuddy refresh token。".to_string())?;
    let access = String::from_utf8_lossy(&access_bytes).into_owned();
    let mut stored: StoredCredential = serde_json::from_slice(&routing_bytes)
        .map_err(|_| "WorkBuddy 凭据格式无效。".to_string())?;
    Ok(WorkBuddyCredential {
        access,
        refresh: std::mem::take(&mut stored.refresh),
        expires_at: stored.expires_at,
        domain: std::mem::take(&mut stored.domain),
        user_id: std::mem::take(&mut stored.user_id),
        enterprise_id: std::mem::take(&mut stored.enterprise_id),
    })
}

pub fn replace(id: &str, credential: &WorkBuddyCredential) -> Result<Backup, String> {
    if credential.access.trim().is_empty() || credential.refresh.trim().is_empty() {
        return Err("WorkBuddy 凭据缺少可续期 token。".to_string());
    }
    let backup = read_backup(id)?;
    let access = Zeroizing::new(credential.access.as_bytes().to_vec());
    let routing = Zeroizing::new(
        serde_json::to_vec(&StoredCredential::from(credential))
            .map_err(|error| format!("无法编码 WorkBuddy 凭据：{error}"))?,
    );
    if let Err(error) = entry(ACCESS_SERVICE, id)?.set_secret(&access) {
        return Err(format!("无法写入 WorkBuddy access token：{error}"));
    }
    if let Err(error) = entry(ROUTING_SERVICE, id)?.set_secret(&routing) {
        let rollback = restore_from(id, &backup);
        return Err(match rollback {
            Ok(()) => format!("无法写入 WorkBuddy refresh token：{error}"),
            Err(rollback) => {
                format!("无法写入 WorkBuddy refresh token：{error}；凭据回滚也失败：{rollback}")
            }
        });
    }
    Ok(backup)
}

pub fn take(id: &str) -> Result<Backup, String> {
    let backup = read_backup(id)?;
    let delete = || -> Result<(), String> {
        set_or_delete(ACCESS_SERVICE, id, None)?;
        set_or_delete(ROUTING_SERVICE, id, None)
    };
    if let Err(error) = delete() {
        let rollback = restore_from(id, &backup);
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback) => format!("{error}；凭据回滚也失败：{rollback}"),
        });
    }
    Ok(backup)
}

pub fn restore(id: &str, backup: Backup) -> Result<(), String> {
    restore_from(id, &backup)
}

pub fn configured(id: &str) -> bool {
    [ACCESS_SERVICE, ROUTING_SERVICE]
        .into_iter()
        .all(|service| {
            optional_secret(service, id)
                .ok()
                .flatten()
                .is_some_and(|bytes| !bytes.is_empty())
        })
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredCredential {
    refresh: String,
    expires_at: i64,
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
            expires_at: value.expires_at,
            domain: value.domain.clone(),
            user_id: value.user_id.clone(),
            enterprise_id: value.enterprise_id.clone(),
        }
    }
}
