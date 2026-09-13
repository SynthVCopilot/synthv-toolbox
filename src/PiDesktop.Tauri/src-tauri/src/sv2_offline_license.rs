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
        .build();
    let result = if post {
        agent
            .post(url)
            .set("Authorization", &authorization)
            .set("Content-Type", "application/json")
            .send_string("{}")
    } else {
        agent.get(url).set("Authorization", &authorization).call()
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
        return Err("当前系统不支持 SV2 原生离线授权。".to_string());
    }
    #[cfg(windows)]
    {
        if source_in_use {
            return Err("SV2 数据正在使用；请退出 SV2 后再检查离线授权。".to_string());
        }
        let (credentials, _) = read_credentials(data_root)?;
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
        return Err("当前系统不支持 SV2 原生离线授权。".to_string());
    }
    #[cfg(windows)]
    {
        if source_in_use {
            return Err("SV2 数据正在使用；请退出 SV2 后再切换离线授权。".to_string());
        }
        let (credentials, fingerprint) = read_credentials(data_root)?;
        if credentials.access_expires_at <= Utc::now() {
            return Err("access token 已到期；请先在 SV2 中刷新账号状态，工具箱不会自行使用 refresh token。".to_string());
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
        if device.is_none() {
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
        let endpoint = if enabled {
            ACTIVATE_URL
        } else {
            DEACTIVATE_URL
        };
        let (status, body) = transport.post(endpoint, credentials.access_token())?;
        let remote_enabled = parse_toggle_response(status, &body, credentials.device_id())?;
        if remote_enabled != enabled {
            return Err(format!(
                "授权服务返回的离线状态不明确；本地未改动。完整备份位于 {}。",
                backup.backup_root.display()
            ));
        }
        let rewritten = rewrite_cache(
            &credentials,
            &user_id,
            if enabled { &products } else { &[] },
        )?;
        persist_refreshed_session(
            data_root,
            &fingerprint,
            &rewritten,
            &*read_machine_key()
                .map_err(|_| "无法读取本机 SV2 加密密钥；本地未改动。".to_string())?,
        )
        .map_err(|_| {
            format!(
                "授权服务已成功，但本地缓存写入未确认；远程状态可能已改变。可从完整备份恢复：{}",
                backup.backup_root.display()
            )
        })?;
        let checked = inspect_with_transport(data_root, false, transport).map_err(|error| {
            format!(
                "本地缓存已写入，但重新确认远程状态失败：{error}；完整备份位于 {}。",
                backup.backup_root.display()
            )
        })?;
        Ok(Sv2OfflineLicenseOperation {
            status: checked,
            backup_path: backup.backup_root.to_string_lossy().into_owned(),
            access_changed: false,
            refresh_changed: false,
            detail: if enabled {
                "已启用 SV2 原生离线授权缓存。".to_string()
            } else {
                "已停用 SV2 原生离线授权缓存。".to_string()
            },
        })
    }
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
    device: Option<String>,
) -> Sv2OfflineLicenseStatus {
    let local = credentials.offline_license_view();
    Sv2OfflineLicenseStatus {
        enabled: local.cache_status == Sv2OfflineLicenseCacheStatus::Active,
        eligible,
        local_cache_status: local.cache_status,
        current_device: device.is_some(),
        device_name: device.filter(|name| !name.is_empty()),
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
            .any(|v| v.is_empty() || v.len() > 512 || v.chars().any(char::is_control))
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
    if !products
        .iter()
        .any(|product| product.name.eq_ignore_ascii_case(OFFLINE_PRODUCT))
    {
        return Ok(Vec::new());
    }
    products.sort_by(|left, right| left.license_id.cmp(&right.license_id));
    Ok(products)
}

fn current_device<T: OfflineTransport>(
    transport: &T,
    access: &str,
    expected: Option<&str>,
) -> Result<Option<String>, String> {
    let expected =
        expected.ok_or_else(|| "本地 session 没有设备标识；未改动本地缓存。".to_string())?;
    let (status, body) = transport.get(DEVICES_URL, access)?;
    if status != 200 {
        return Err("授权服务拒绝了设备查询；未改动本地缓存。".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| "授权服务返回了无效设备数据；未改动本地缓存。".to_string())?;
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
        return Ok(None);
    }
    // Before first activation the endpoint legitimately returns no offline records.
    // The encrypted local session still establishes the current device identity.
    if matching.is_empty() {
        return Ok(Some(String::new()));
    }
    if matching.len() != 1 {
        return Ok(None);
    }
    Ok(matching[0]
        .get("device_name")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty() && name.len() <= 160 && !name.chars().any(char::is_control))
        .map(str::to_owned)
        .or_else(|| Some(String::new())))
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
