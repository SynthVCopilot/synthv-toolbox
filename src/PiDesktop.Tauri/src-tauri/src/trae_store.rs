use crate::agent::traecode::TraeCredential;
use zeroize::Zeroizing;
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
const SERVICE: &str = "com.synthvcopilot.toolbox.trae.credential";
pub type Backup = Option<Zeroizing<Vec<u8>>>;
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|_| "系统凭据库不可用。".into())
}
fn read(id: &str) -> Result<Backup, String> {
    match entry(id)?.get_secret() {
        Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取 Trae 凭据。".into()),
    }
}
pub fn load(id: &str) -> Result<TraeCredential, String> {
    let bytes = read(id)?.ok_or_else(|| "没有找到 Trae 凭据，请重新授权。".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Trae 凭据格式无效。".into())
}
pub fn replace(id: &str, credential: &TraeCredential) -> Result<Backup, String> {
    let _guard = WRITES.lock().map_err(|_| "Trae 凭据库忙碌。".to_string())?;
    replace_unlocked(id, credential)
}
fn replace_unlocked(id: &str, credential: &TraeCredential) -> Result<Backup, String> {
    let backup = read(id)?;
    let bytes = Zeroizing::new(
        serde_json::to_vec(credential).map_err(|_| "无法编码 Trae 凭据。".to_string())?,
    );
    entry(id)?
        .set_secret(&bytes)
        .map_err(|_| "无法保存 Trae 凭据。".to_string())?;
    Ok(backup)
}
pub fn restore(id: &str, backup: Backup) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "Trae 凭据库忙碌。".to_string())?;
    restore_unlocked(id, backup)
}
fn restore_unlocked(id: &str, backup: Backup) -> Result<(), String> {
    match backup {
        Some(bytes) => entry(id)?
            .set_secret(&bytes)
            .map_err(|_| "无法恢复 Trae 凭据。".into()),
        None => match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法删除 Trae 凭据。".into()),
        },
    }
}
pub fn take(id: &str) -> Result<Backup, String> {
    let _guard = WRITES.lock().map_err(|_| "Trae 凭据库忙碌。".to_string())?;
    let backup = read(id)?;
    restore_unlocked(id, None)?;
    Ok(backup)
}
pub fn configured(id: &str) -> bool {
    load(id).is_ok_and(|c| c.refresh_expires > chrono::Utc::now().timestamp_millis())
}
pub fn models(id: &str) -> Vec<String> {
    load(id).map(|c| c.models.clone()).unwrap_or_default()
}

pub fn replace_current(
    id: &str,
    expected_refresh: &str,
    credential: &TraeCredential,
) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "Trae 凭据库忙碌。".to_string())?;
    let current = load(id)?;
    if current.refresh != expected_refresh {
        return Err("Trae 账号已重新授权，请重试请求。".into());
    }
    replace_unlocked(id, credential)?;
    Ok(())
}
