use super::*;

const OFFLINE_PRODUCT: &str = "Synthesizer V Studio 2 Pro";
const LICENSES_URL: &str = "https://authr3.dreamtonics.com/api/v1/client/my_licenses";
const DEVICES_URL: &str = "https://authr3.dreamtonics.com/api/v1/client/my_devices?native_product=Synthesizer+V+Studio+2+Pro";
const ACTIVATE_URL: &str = "https://authr3.dreamtonics.com/api/v1/client/activate_offline_license";
const DEACTIVATE_URL: &str =
    "https://authr3.dreamtonics.com/api/v1/client/deactivate_offline_license";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2OfflineLicenseStatus {
    pub enabled: bool,
    pub eligible: bool,
    pub local_cache_status: Sv2OfflineLicenseCacheStatus,
    pub current_device: bool,
    pub device_name: Option<String>,
    pub cached_products: Vec<Sv2OfflineCachedProduct>,
    pub checked_at_utc: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2OfflineLicenseOperation {
    pub status: Sv2OfflineLicenseStatus,
    pub backup_path: String,
    pub access_changed: bool,
    pub refresh_changed: bool,
    pub detail: String,
}

#[derive(Clone)]
struct OfflineProduct {
    license_id: String,
    product_id: String,
    name: String,
    vendor: String,
    kind: String,
    version: String,
}

struct RemoteDeviceState {
    enabled: bool,
    current_device: bool,
    name: Option<String>,
}

trait OfflineTransport {
    fn get(&self, url: &str, access: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String>;
    fn post(&self, url: &str, access: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String>;
}

struct UreqOfflineTransport;

impl OfflineTransport for UreqOfflineTransport {
    fn get(&self, url: &str, access: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
        request_ureq(false, url, access)
    }
    fn post(&self, url: &str, access: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
        request_ureq(true, url, access)
    }
}

#[cfg(windows)]
fn request_ureq(post: bool, url: &str, access: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
    let mut authorization = Zeroizing::new(format!("Bearer {access}"));
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .redirects(0)
        .build();
    let result = if post {
        agent
            .post(url)
            .set("Authorization", &authorization)
            .set("Content-Type", "application/json")
            .send_string("{}")
    } else {
        agent
            .get(url)
            .set("Accept", "application/json")
            .set("Authorization", &authorization)
            .call()
    };
    authorization.zeroize();
    let (status, response) = match result {
        Ok(response) => (response.status(), response),
        Err(ureq::Error::Status(status, response)) => (status, response),
        Err(ureq::Error::Transport(_)) => {
            return Err("授权服务不可达；未改动本地缓存。".to_string())
        }
    };
    match read_bounded_response(response) {
        Ok(body) => Ok((status, body)),
        Err(_) => Err("授权服务响应无效；未改动本地缓存。".to_string()),
    }
}

#[cfg(not(windows))]
fn request_ureq(_: bool, _: &str, _: &str) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
    Err("当前系统不支持 SV2 原生离线授权。".to_string())
}

pub fn inspect_offline_license(
    data_root: &Path,
    source_in_use: bool,
) -> Result<Sv2OfflineLicenseStatus, String> {
    inspect_with_transport(data_root, source_in_use, &UreqOfflineTransport)
}

pub fn set_offline_license(
    data_root: &Path,
    backup_parent: &Path,
    enabled: bool,
    source_in_use: bool,
) -> Result<Sv2OfflineLicenseOperation, String> {
    set_with_transport(
        data_root,
        backup_parent,
        enabled,
        source_in_use,
        &UreqOfflineTransport,
    )
}

fn inspect_with_transport<T: OfflineTransport>(
    data_root: &Path,
    source_in_use: bool,
    transport: &T,
) -> Result<Sv2OfflineLicenseStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (data_root, source_in_use, transport);
        Err("当前系统不支持 SV2 原生离线授权。".to_string())
    }
    #[cfg(windows)]
    {
        if source_in_use {
            return Err("SV2 数据正在使用；请退出 SV2 后再检查离线授权。".to_string());
        }
        let (credentials, _) = read_credentials(data_root)?;
        if credentials.access_expires_at <= Utc::now() {
            return Err(
                "登录凭据已到期；请先在 Toolbox 中刷新该账号，再检查离线授权。".to_string(),
            );
        }
        let products = licensed_products(transport, credentials.access_token())?;
        let device = current_device(
            transport,
            credentials.access_token(),
            credentials.device_id(),
        )?;
        Ok(status_from(&credentials, !products.is_empty(), device))
    }
}

fn set_with_transport<T: OfflineTransport>(
    data_root: &Path,
    backup_parent: &Path,
    enabled: bool,
    source_in_use: bool,
    transport: &T,
) -> Result<Sv2OfflineLicenseOperation, String> {
    #[cfg(not(windows))]
    {
        let _ = (data_root, backup_parent, enabled, source_in_use, transport);
        Err("当前系统不支持 SV2 原生离线授权。".to_string())
    }
    #[cfg(windows)]
    {
        if source_in_use {
            return Err("SV2 数据正在使用；请退出 SV2 后再切换离线授权。".to_string());
        }
        ensure_sv2_not_running()?;
        let (credentials, fingerprint) = read_credentials(data_root)?;
        if credentials.access_expires_at <= Utc::now() {
            return Err(
                "登录凭据已到期；请先在 Toolbox 中刷新该账号，再切换离线授权。".to_string(),
            );
        }
        let user_id = jwt_subject(credentials.access_token())
            .ok_or_else(|| "本地 access token 缺少账号主体；未改动本地缓存。".to_string())?;
        let products = licensed_products(transport, credentials.access_token())?;
        if enabled && products.is_empty() {
            return Err(
                "当前账号没有可用于 SV2 Pro 的永久有效离线授权；未改动本地缓存。".to_string(),
            );
        }
        let device = current_device(
            transport,
            credentials.access_token(),
            credentials.device_id(),
        )?;
        if !device.current_device {
            return Err("授权服务未确认当前本地设备；未改动本地缓存。".to_string());
        }
        let backup = crate::sv2_data_backup::create_verified_sv2_data_backup(
            data_root,
            backup_parent,
            false,
        )?;
        if backup.session_sha256.as_deref() != Some(&hex::encode(fingerprint.content_hash)) {
            return Err(format!(
                "本地 session 在读取与备份之间发生变化；未联系授权服务。完整备份位于 {}。",
                backup.backup_root.display()
            ));
        }
        let rewritten = rewrite_cache(
            &credentials,
            &user_id,
            if enabled { &products } else { &[] },
        )?;
        let machine_key = read_machine_key()
            .map_err(|_| "无法读取本机 SV2 加密密钥；本地未改动。".to_string())?;
        if inspect_session_fingerprint(data_root)
            .map_err(|_| "无法复核本地 session；未联系授权服务。".to_string())?
            .as_ref()
            != Some(&fingerprint)
        {
            return Err(format!(
                "本地 session 在远程切换前发生变化；未联系授权服务。完整备份位于 {}。",
                backup.backup_root.display()
            ));
        }
        ensure_sv2_not_running()?;
        let endpoint = if enabled {
            ACTIVATE_URL
        } else {
            DEACTIVATE_URL
        };
        let (status, body) = transport
            .post(endpoint, credentials.access_token())
            .map_err(|error| {
                format!(
                    "远程离线授权请求未确认；远端状态可能已改变。{error} 可从完整备份恢复：{}",
                    backup.backup_root.display()
                )
            })?;
        let remote_enabled = parse_toggle_response(status, &body, credentials.device_id())
            .map_err(|error| {
                format!(
                    "远程离线授权响应无效；远端状态可能已改变。{error} 可从完整备份恢复：{}",
                    backup.backup_root.display()
                )
            })?;
        if remote_enabled != enabled {
            return Err(format!(
                "授权服务返回的离线状态不明确；本地未改动。完整备份位于 {}。",
                backup.backup_root.display()
            ));
        }
        ensure_sv2_not_running().map_err(|error| {
            format!(
                "{error} 远端状态可能已改变；可从完整备份恢复：{}",
                backup.backup_root.display()
            )
        })?;
        persist_refreshed_session(data_root, &fingerprint, &rewritten, &machine_key).map_err(
            |_| {
                format!(
                "授权服务已成功，但本地缓存写入未确认；远程状态可能已改变。可从完整备份恢复：{}",
                backup.backup_root.display()
            )
            },
        )?;
        let (after, _) = read_credentials(data_root)?;
        let access_changed = after.access_token() != credentials.access_token();
        let refresh_changed = after.refresh_token() != credentials.refresh_token();
        let checked = inspect_with_transport(data_root, false, transport).map_err(|error| {
            format!(
                "本地缓存已写入，但重新确认远程状态失败：{error}；完整备份位于 {}。",
                backup.backup_root.display()
            )
        })?;
        if checked.enabled != enabled
            || (enabled && checked.local_cache_status != Sv2OfflineLicenseCacheStatus::Active)
            || (!enabled && checked.local_cache_status == Sv2OfflineLicenseCacheStatus::Active)
        {
            return Err(format!(
                "本地写入后状态与远程状态不一致；远端状态可能已改变。可从完整备份恢复：{}",
                backup.backup_root.display()
            ));
        }
        Ok(Sv2OfflineLicenseOperation {
            status: checked,
            backup_path: display_backup_path(&backup.backup_root),
            access_changed,
            refresh_changed,
            detail: if enabled {
                "已启用 SV2 原生离线授权缓存。".to_string()
            } else {
                "已停用 SV2 原生离线授权缓存。".to_string()
            },
        })
    }
}

fn display_backup_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[cfg(windows)]
fn read_credentials(data_root: &Path) -> Result<(SessionCredentials, SessionCacheKey), String> {
    let (encrypted, fingerprint) = read_stable_session(data_root)
        .map_err(|_| "无法稳定读取本地 session；未改动任何内容。".to_string())?
        .ok_or_else(|| "未找到本地 SV2 session。".to_string())?;
    let key = read_machine_key().map_err(|_| "无法读取本机 SV2 加密密钥。".to_string())?;
    match decode_session_credentials(encrypted, &key) {
        SessionDecode::Credentials(value) => Ok((value, fingerprint)),
        SessionDecode::LoginRequired => Err("本地 session 尚未登录。".to_string()),
        SessionDecode::Invalid => Err("本地 session 格式无效；未改动任何内容。".to_string()),
    }
}

fn status_from(
    credentials: &SessionCredentials,
    eligible: bool,
    device: RemoteDeviceState,
) -> Sv2OfflineLicenseStatus {
    let local = credentials.offline_license_view();
    Sv2OfflineLicenseStatus {
        enabled: device.enabled,
        eligible,
        local_cache_status: local.cache_status,
        current_device: device.current_device,
        device_name: device.name,
        cached_products: local.cached_products,
        checked_at_utc: Utc::now().to_rfc3339(),
    }
}

fn jwt_subject(access: &str) -> Option<String> {
    let payload = decode_base64url(access.split('.').nth(1)?).ok()?;
    serde_json::from_slice::<JwtIdentityClaims<'_>>(&payload)
        .ok()?
        .sub
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn licensed_products<T: OfflineTransport>(
    transport: &T,
    access: &str,
) -> Result<Vec<OfflineProduct>, String> {
    let (status, body) = transport.get(LICENSES_URL, access)?;
    if status != 200 {
        return Err("授权服务拒绝了授权查询；未改动本地缓存。".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| "授权服务返回了无效数据；未改动本地缓存。".to_string())?;
    if value.get("status").and_then(serde_json::Value::as_i64) != Some(200) {
        return Err("授权服务未确认授权查询；未改动本地缓存。".to_string());
    }
    let entries = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "授权服务返回了不完整数据；未改动本地缓存。".to_string())?;
    if entries.len() > MAX_LICENSE_ITEMS {
        return Err("授权服务返回了过多授权记录；未改动本地缓存。".to_string());
    }
    let mut products = Vec::new();
    for entry in entries {
        if entry.get("status").and_then(serde_json::Value::as_str) != Some("active")
            || entry
                .get("license_type")
                .and_then(serde_json::Value::as_str)
                != Some("permanent")
            || !entry
                .get("valid_to")
                .is_some_and(serde_json::Value::is_null)
        {
            continue;
        }
        let product = entry
            .get("product")
            .ok_or_else(|| "永久授权缺少产品缓存字段；未改动本地缓存。".to_string())?;
        let fields = (
            entry.get("id"),
            product.get("id"),
            product.get("name"),
            product.get("vendor"),
            product.get("type"),
            product.get("version").and_then(|v| v.get("version_name")),
        );
        let (
            Some(license_id),
            Some(product_id),
            Some(name),
            Some(vendor),
            Some(kind),
            Some(version),
        ) = fields
        else {
            return Err("永久授权缺少产品缓存字段；未改动本地缓存。".to_string());
        };
        let (
            Some(license_id),
            Some(product_id),
            Some(name),
            Some(vendor),
            Some(kind),
            Some(version),
        ) = (
            license_id.as_str(),
            product_id.as_str(),
            name.as_str(),
            vendor.as_str(),
            kind.as_str(),
            version.as_str(),
        )
        else {
            return Err("永久授权包含不可序列化的产品缓存字段；未改动本地缓存。".to_string());
        };
        if [license_id, product_id, name, vendor, kind, version]
            .iter()
            .any(|v| {
                v.is_empty() || v.len() > 512 || v.contains(';') || v.chars().any(char::is_control)
            })
        {
            return Err("永久授权包含不安全的产品缓存字段；未改动本地缓存。".to_string());
        }
        products.push(OfflineProduct {
            license_id: license_id.to_string(),
            product_id: product_id.to_string(),
            name: name.to_string(),
            vendor: vendor.to_string(),
            kind: kind.to_string(),
            version: version.to_string(),
        });
    }
    if !products.iter().any(|product| {
        product.name.eq_ignore_ascii_case(OFFLINE_PRODUCT)
            && product.kind.eq_ignore_ascii_case("Synthesizer V Editor")
    }) {
        return Ok(Vec::new());
    }
    Ok(products)
}

fn current_device<T: OfflineTransport>(
    transport: &T,
    access: &str,
    expected: Option<&str>,
) -> Result<RemoteDeviceState, String> {
    let expected =
        expected.ok_or_else(|| "本地 session 没有设备标识；未改动本地缓存。".to_string())?;
    let (status, body) = transport.get(DEVICES_URL, access)?;
    if status != 200 {
        return Err("授权服务拒绝了设备查询；未改动本地缓存。".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| "授权服务返回了无效设备数据；未改动本地缓存。".to_string())?;
    if value.get("status").and_then(serde_json::Value::as_i64) != Some(200) {
        return Err("授权服务未确认设备查询；未改动本地缓存。".to_string());
    }
    let devices = value
        .pointer("/data/offline_license_devices")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "授权服务返回了不完整设备数据；未改动本地缓存。".to_string())?;
    let matching = devices
        .iter()
        .filter(|device| device.get("id").and_then(serde_json::Value::as_str) == Some(expected))
        .collect::<Vec<_>>();
    if devices.iter().any(|device| {
        device
            .get("offline_license_enabled")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
            && device.get("id").and_then(serde_json::Value::as_str) != Some(expected)
    }) {
        return Ok(RemoteDeviceState {
            enabled: true,
            current_device: false,
            name: None,
        });
    }
    // The encrypted session identifies the current device when no offline record exists.
    if matching.is_empty() {
        return Ok(RemoteDeviceState {
            enabled: false,
            current_device: true,
            name: None,
        });
    }
    if matching.len() != 1 {
        return Ok(RemoteDeviceState {
            enabled: false,
            current_device: false,
            name: None,
        });
    }
    let enabled = matching[0]
        .get("offline_license_enabled")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "授权服务返回了无效设备状态；未改动本地缓存。".to_string())?;
    Ok(RemoteDeviceState {
        enabled,
        current_device: true,
        name: matching[0]
            .get("device_name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| {
                !name.is_empty() && name.len() <= 160 && !name.chars().any(char::is_control)
            })
            .map(str::to_owned),
    })
}

pub(crate) fn parse_toggle_response(
    status: u16,
    body: &[u8],
    expected_device: Option<&str>,
) -> Result<bool, String> {
    if status != 200 {
        return Err("授权服务未确认离线授权切换；本地未改动。".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| "授权服务返回了无效切换结果；本地未改动。".to_string())?;
    let data = value
        .get("data")
        .ok_or_else(|| "授权服务返回了不完整切换结果；本地未改动。".to_string())?;
    if expected_device.is_none_or(str::is_empty)
        || value.get("status").and_then(serde_json::Value::as_i64) != Some(200)
    {
        return Err("授权服务未确认离线授权切换；本地未改动。".to_string());
    }
    if data.get("id").and_then(serde_json::Value::as_str) != expected_device
        || data
            .get("native_product")
            .and_then(serde_json::Value::as_str)
            != Some(OFFLINE_PRODUCT)
    {
        return Err("授权服务返回了不同设备；本地未改动。".to_string());
    }
    data.get("offline_license_enabled")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "授权服务未提供离线状态；本地未改动。".to_string())
}

fn rewrite_cache(
    credentials: &SessionCredentials,
    user_id: &str,
    products: &[OfflineProduct],
) -> Result<SessionCredentials, String> {
    let mut plaintext = Zeroizing::new(format!(
        "{}\n{}\n{}\n{}\n{}",
        credentials.access_token(),
        credentials.refresh_token(),
        &credentials.buffer[credentials.access_expiry_text.clone()],
        Local::now().to_rfc3339_opts(SecondsFormat::Millis, false),
        credentials
            .device_id()
            .ok_or_else(|| "本地 session 没有设备标识。".to_string())?
    ));
    if !products.is_empty() {
        plaintext.push('\n');
        plaintext.push_str(user_id);
        for product in products {
            write!(
                &mut *plaintext,
                "\nK1={};K2={};K3={};K4={};K5={};K6={};K7=2;K8=0;K9=0",
                product.license_id,
                product.product_id,
                product.name,
                product.vendor,
                product.kind,
                product.version
            )
            .map_err(|_| "无法构建本地离线缓存。".to_string())?;
        }
    }
    parse_session_plaintext(Zeroizing::new(std::mem::take(&mut *plaintext).into_bytes()))
        .map_err(|_| "生成的本地离线缓存未通过格式校验。".to_string())
}

#[cfg(all(windows, not(test)))]
fn ensure_sv2_not_running() -> Result<(), String> {
    if crate::synthv_control::list_processes()
        .map_err(|_| "无法确认 SV2 进程状态。".to_string())?
        .is_empty()
    {
        Ok(())
    } else {
        Err("SV2 正在运行；请退出后再切换离线授权。".to_string())
    }
}

#[cfg(all(windows, test))]
fn ensure_sv2_not_running() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
#[path = "../../../../test/sv2_offline_license.rs"]
mod tests;
