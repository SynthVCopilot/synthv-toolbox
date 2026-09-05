#![cfg_attr(
    not(windows),
    allow(dead_code, unused_imports, clippy::chunks_exact_to_as_chunks)
)]

//! Explicit inspection of the Synthesizer V Studio 2 account session.
//!
//! Secrets stay inside zeroizing, private buffers.  The public view contains
//! only derived status and product names, so callers cannot accidentally log or
//! serialize a bearer token.  A refresh may rotate the cached JWTs, and the
//! no-launch login check deliberately reproduces `enroll_device(false)`; callers
//! must therefore gate the refresh entry point behind explicit user consent.

use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::ops::Range;
use std::path::Path;
use std::time::Duration;

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use blowfish::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use blowfish::Blowfish;
use chrono::{DateTime, Duration as ChronoDuration, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

#[cfg(windows)]
use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::fs::{self, File, Metadata, OpenOptions};
#[cfg(windows)]
use std::hash::{Hash, Hasher};
#[cfg(windows)]
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::sync::{Mutex, OnceLock};
#[cfg(windows)]
use std::time::Instant;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
#[cfg(windows)]
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, ReplaceFileW, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE,
};
#[cfg(windows)]
use windows_sys::Win32::System::SystemInformation::{
    ComputerNamePhysicalDnsHostname, GetComputerNameExW, GetSystemFirmwareTable,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
#[cfg(windows)]
use xxhash_rust::xxh32::xxh32;

const MAX_SESSION_BYTES: usize = 1024 * 1024;
const MAX_FIRMWARE_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_JWT_BYTES: usize = 512 * 1024;
const MAX_JWT_PART_BYTES: usize = 256 * 1024;
const MAX_JWT_JSON_BYTES: usize = 128 * 1024;
const MAX_LICENSE_ITEMS: usize = 4096;
const MAX_AUTHORIZED_VOICES: usize = 256;
const MAX_PRODUCT_NAME_CHARS: usize = 160;
const MAX_TOKEN_CLOCK_SKEW_MILLIS: u64 = 5 * 60 * 1000;
const TOKEN_URL: &str =
    "https://account.dreamtonics.com/realms/Dreamtonics/protocol/openid-connect/token";
const TOKEN_ISSUER: &str = "https://account.dreamtonics.com/realms/Dreamtonics";
const LICENSES_URL: &str = "https://authr3.dreamtonics.com/api/v1/client/my_licenses";
const ENROLL_URL: &str = "https://authr3.dreamtonics.com/api/v1/client/enroll_device";
const EDITOR_VERSION: u32 = 0x20201;
const CONCURRENT_ERROR: &[u8] = b"device-concurrent-session-exceeded";
const KICKOUT_ERROR: &[u8] = b"device-require-session-kickout-confirmation";
const RELOGIN_ERROR: &[u8] = b"device-require-relogin";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2SessionInspectionStatus {
    Ready,
    Missing,
    InUse,
    Expired,
    Invalid,
    SyncFailed,
    AccountMismatch,
    Unsupported,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2RemoteUseStatus {
    Clear,
    Detected,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2AuthorizationStatus {
    Verified,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2AccountProbeView {
    pub session_status: Sv2SessionInspectionStatus,
    pub remote_use: Sv2RemoteUseStatus,
    pub authorization_status: Sv2AuthorizationStatus,
    pub authorized_voice_count: usize,
    pub authorized_voices: Vec<String>,
    pub account_display_name: Option<String>,
    pub account_email: Option<String>,
    pub checked_at_utc: String,
    pub detail: String,
}

impl Sv2AccountProbeView {
    /// A cheap placeholder for ordinary state snapshots.  This constructor
    /// never opens or decrypts the session and never contacts Dreamtonics.
    pub fn not_checked(session_present: bool) -> Self {
        if session_present {
            Self::new(
                Sv2SessionInspectionStatus::Ready,
                Sv2RemoteUseStatus::Unknown,
                Sv2AuthorizationStatus::Unknown,
                Vec::new(),
                "已发现登录缓存，正在等待显式账号预检；尚未解密会话或联系授权服务。",
            )
        } else {
            Self::new(
                Sv2SessionInspectionStatus::Missing,
                Sv2RemoteUseStatus::Unknown,
                Sv2AuthorizationStatus::Unknown,
                Vec::new(),
                "未发现登录缓存；需要先在 SV2 中完成登录。",
            )
        }
    }

    fn new(
        session_status: Sv2SessionInspectionStatus,
        remote_use: Sv2RemoteUseStatus,
        authorization_status: Sv2AuthorizationStatus,
        authorized_voices: Vec<String>,
        detail: &str,
    ) -> Self {
        let authorized_voice_count = authorized_voices.len();
        Self {
            session_status,
            remote_use,
            authorization_status,
            authorized_voice_count,
            checked_at_utc: Utc::now().to_rfc3339(),
            detail: detail.to_string(),
            authorized_voices,
            account_display_name: None,
            account_email: None,
        }
    }

    fn with_account_identity(mut self, access_token: &str) -> Self {
        if let Some(identity) = account_identity(access_token) {
            self.account_display_name = identity.display_name;
            self.account_email = identity.email;
        }
        self
    }

    fn in_use() -> Self {
        Self::new(
            Sv2SessionInspectionStatus::InUse,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "账号环境正在本机使用；为避免读取变化中的会话，本次未执行预检。",
        )
    }

    fn in_use_with_cached_authorization(cached: Option<&Self>) -> Self {
        let mut view = Self::in_use();
        let Some(cached) = cached else {
            return view;
        };
        view.authorization_status = cached.authorization_status;
        view.authorized_voice_count = cached.authorized_voice_count;
        view.authorized_voices.clone_from(&cached.authorized_voices);
        view.account_display_name
            .clone_from(&cached.account_display_name);
        view.account_email.clone_from(&cached.account_email);
        if cached.authorization_status == Sv2AuthorizationStatus::Verified {
            view.detail =
                "账号环境正在本机使用；显示本次运行前已安全缓存的声库授权，未读取或轮换会话。"
                    .to_string();
        }
        view
    }

    fn invalid() -> Self {
        Self::new(
            Sv2SessionInspectionStatus::Invalid,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "本地登录缓存无法安全验证；未读取任何账号状态。",
        )
    }

    fn account_mismatch() -> Self {
        Self::new(
            Sv2SessionInspectionStatus::AccountMismatch,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "该物理副本的账号主体与槽位 authority 不一致；本次未刷新、未提交登录事件，也未覆盖任一账号缓存。",
        )
    }

    fn sync_failed(detail: &str) -> Self {
        Self::new(
            Sv2SessionInspectionStatus::SyncFailed,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            detail,
        )
    }

    fn unsupported() -> Self {
        Self::new(
            Sv2SessionInspectionStatus::Unsupported,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "当前系统无法按已知 SV2 2.2.1 格式验证本地登录缓存。",
        )
    }
}

/// One input to an explicit batch account precheck.  Callers must mark roots
/// that may be changing so the batch never reads or writes an active session.
#[derive(Clone, Copy)]
pub struct Sv2AccountProbeRequest<'a> {
    pub data_root: &'a Path,
    pub source_in_use: bool,
    pub account_scope: Option<usize>,
    pub preferred_source: bool,
    quarantine_slot_id: Option<&'a str>,
    quarantine_concurrent: bool,
}

impl<'a> Sv2AccountProbeRequest<'a> {
    pub fn new(data_root: &'a Path, source_in_use: bool) -> Self {
        Self {
            data_root,
            source_in_use,
            account_scope: None,
            preferred_source: false,
            quarantine_slot_id: None,
            quarantine_concurrent: false,
        }
    }

    pub fn for_account(
        data_root: &'a Path,
        source_in_use: bool,
        account_scope: usize,
        preferred_source: bool,
        slot_id: &'a str,
        concurrent: bool,
    ) -> Self {
        Self {
            data_root,
            source_in_use,
            account_scope: Some(account_scope),
            preferred_source,
            quarantine_slot_id: Some(slot_id),
            quarantine_concurrent: concurrent,
        }
    }

    fn quarantine_identity(&self) -> Option<(&str, bool)> {
        self.quarantine_slot_id
            .map(|slot_id| (slot_id, self.quarantine_concurrent))
    }
}

/// Performs explicit, consent-gated account prechecks. Results preserve input
/// order and never read a root that the caller marked as in use.
pub fn refresh_sv2_account_probes(
    requests: &[Sv2AccountProbeRequest<'_>],
) -> Vec<Sv2AccountProbeView> {
    #[cfg(not(windows))]
    {
        requests
            .iter()
            .map(|_| Sv2AccountProbeView::unsupported())
            .collect()
    }

    #[cfg(windows)]
    {
        refresh_windows_batch(requests)
    }
}

/// Convenience wrapper for a single explicit precheck.  Batch callers should
/// prefer [`refresh_sv2_account_probes`] so refresh-token rotation can be
/// coordinated across normal and concurrent copies.
#[allow(dead_code)]
pub fn refresh_sv2_account_probe(data_root: &Path, source_in_use: bool) -> Sv2AccountProbeView {
    refresh_sv2_account_probes(&[Sv2AccountProbeRequest::new(data_root, source_in_use)])
        .into_iter()
        .next()
        .unwrap_or_else(Sv2AccountProbeView::invalid)
}

/// Returns a same-process, sanitized precheck result when its session
/// fingerprint still matches.  It never decrypts a session or accesses the
/// network.
#[allow(dead_code)]
pub fn cached_sv2_account_probe(data_root: &Path, source_in_use: bool) -> Sv2AccountProbeView {
    cached_sv2_account_probe_with_identity(data_root, source_in_use, None)
}

/// Cached account-scoped lookup. The stable slot/mode identity lets sanitized
/// results and SyncFailed quarantine follow a physical session when switching
/// moves it between the canonical and parked directories.
pub fn cached_sv2_account_probe_for_account(
    data_root: &Path,
    source_in_use: bool,
    slot_id: &str,
    concurrent: bool,
) -> Sv2AccountProbeView {
    cached_sv2_account_probe_with_identity(data_root, source_in_use, Some((slot_id, concurrent)))
}

fn cached_sv2_account_probe_with_identity(
    data_root: &Path,
    source_in_use: bool,
    logical_identity: Option<(&str, bool)>,
) -> Sv2AccountProbeView {
    #[cfg(not(windows))]
    {
        let _ = (data_root, source_in_use, logical_identity);
        Sv2AccountProbeView::unsupported()
    }

    #[cfg(windows)]
    {
        if source_in_use {
            return cached_active_session_view(data_root, logical_identity);
        }
        match inspect_session_fingerprint(data_root) {
            Ok(Some(key)) => {
                let root_key = probe_root_key(logical_identity, &key.canonical_root);
                cached_view_for_fingerprint(&key, &root_key)
                    .unwrap_or_else(|| Sv2AccountProbeView::not_checked(true))
            }
            Ok(None) => Sv2AccountProbeView::not_checked(false),
            Err(()) => probe_root_key_for_identity(data_root, logical_identity)
                .and_then(|root| sync_quarantine_get(&root.quarantine_key()))
                .unwrap_or_else(Sv2AccountProbeView::invalid),
        }
    }
}

#[cfg(windows)]
fn cached_active_session_view(
    data_root: &Path,
    logical_identity: Option<(&str, bool)>,
) -> Sv2AccountProbeView {
    let root = probe_root_key_for_identity(data_root, logical_identity);
    let cached = inspect_session_fingerprint(data_root)
        .ok()
        .flatten()
        .and_then(|fingerprint| root.as_ref().and_then(|root| cache_get(&fingerprint, root)));
    let mut view = Sv2AccountProbeView::in_use_with_cached_authorization(cached.as_ref());
    if view.account_display_name.is_none() && view.account_email.is_none() {
        if let Some((name, email)) = root.as_ref().and_then(cached_identity_for_root) {
            view.account_display_name = name;
            view.account_email = email;
        }
    }
    view
}

#[cfg(windows)]
fn inspect_active_session_license(
    data_root: &Path,
    logical_identity: Option<(&str, bool)>,
) -> Sv2AccountProbeView {
    let root = probe_root_key_for_identity(data_root, logical_identity);
    let Some((ciphertext, fingerprint)) = (match read_stable_session(data_root) {
        Ok(value) => value,
        Err(()) => return Sv2AccountProbeView::invalid(),
    }) else {
        return Sv2AccountProbeView::not_checked(false);
    };
    let key = match read_machine_key() {
        Ok(key) => key,
        Err(()) => return Sv2AccountProbeView::unsupported(),
    };
    let credentials = match decrypt_session(ciphertext, &key).and_then(parse_session_plaintext) {
        Ok(credentials) => credentials,
        Err(()) => return Sv2AccountProbeView::invalid(),
    };
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(5))
        .redirects(0)
        .build();
    let Some(root) = root.as_ref() else {
        return Sv2AccountProbeView::in_use();
    };
    if should_refresh_session(credentials.access_expires_at, false) {
        return refresh_active_session_license(
            data_root,
            root,
            &fingerprint,
            &credentials,
            &key,
            &agent,
        );
    }
    let initial = read_only_authorization(
        data_root,
        root,
        &fingerprint,
        &credentials,
        true,
        |access| query_license_snapshot_with_agent(&agent, access),
    );
    match initial {
        Some(view)
            if !should_refresh_session(
                credentials.access_expires_at,
                view.session_status == Sv2SessionInspectionStatus::Invalid,
            ) =>
        {
            view
        }
        Some(_) => refresh_active_session_license(
            data_root,
            root,
            &fingerprint,
            &credentials,
            &key,
            &agent,
        ),
        None => Sv2AccountProbeView::in_use(),
    }
}

fn should_refresh_session(access_expires_at: DateTime<Utc>, authorization_rejected: bool) -> bool {
    access_expires_at <= Utc::now() + ChronoDuration::seconds(60) || authorization_rejected
}

#[cfg(windows)]
fn refresh_active_session_license(
    data_root: &Path,
    root: &ProbeRootKey,
    fingerprint: &SessionCacheKey,
    credentials: &SessionCredentials,
    key: &[u8; 8],
    agent: &ureq::Agent,
) -> Sv2AccountProbeView {
    let original_account = account_group_key(credentials.access_token());
    let refreshed = match refresh_session_credentials(agent, credentials) {
        Ok(value) if account_group_key(value.access_token()) == original_account => value,
        Ok(_) => {
            return Sv2AccountProbeView::sync_failed(
                "刷新后的账号主体与当前会话不一致；未写入本地 session。",
            )
        }
        Err(failure) => return refresh_failure_view(failure),
    };
    let fingerprint = match persist_refreshed_session(data_root, fingerprint, &refreshed, key) {
        Ok(value) => value,
        Err(()) => {
            return Sv2AccountProbeView::sync_failed("刷新凭据无法安全写回；未继续读取授权。")
        }
    };
    read_only_authorization(data_root, root, &fingerprint, &refreshed, true, |access| {
        query_license_snapshot_with_agent(agent, access)
    })
    .unwrap_or_else(Sv2AccountProbeView::in_use)
}

#[cfg(windows)]
fn read_only_authorization<F>(
    data_root: &Path,
    root: &ProbeRootKey,
    fingerprint: &SessionCacheKey,
    credentials: &SessionCredentials,
    active: bool,
    fetch: F,
) -> Option<Sv2AccountProbeView>
where
    F: FnOnce(&str) -> RemoteOutcome,
{
    let licenses = fetch(credentials.access_token());
    if inspect_session_fingerprint(data_root)
        .ok()
        .flatten()
        .as_ref()
        != Some(fingerprint)
    {
        return None;
    }
    let view = if active {
        view_from_active_license(licenses)
    } else {
        view_from_remote(licenses, EnrollOutcome::Unknown)
    }
    .with_account_identity(credentials.access_token());
    if view.authorization_status == Sv2AuthorizationStatus::Verified {
        clear_sync_quarantine(&root.quarantine_key());
    }
    cache_put(
        fingerprint.clone(),
        root,
        &view,
        Some(credentials.access_expires_at),
    );
    Some(view)
}

#[derive(Clone)]
enum RemoteOutcome {
    Authorized(Vec<String>),
    ConcurrentUse,
    Unauthorized,
    Offline,
    Unknown,
}

#[derive(Clone, Copy)]
enum EnrollOutcome {
    Clear,
    ConcurrentUse,
    Unauthorized,
    Offline,
    Unknown,
}

fn view_from_remote(licenses: RemoteOutcome, enroll: EnrollOutcome) -> Sv2AccountProbeView {
    if matches!(licenses, RemoteOutcome::Unauthorized)
        || matches!(enroll, EnrollOutcome::Unauthorized)
    {
        return Sv2AccountProbeView::new(
            Sv2SessionInspectionStatus::Invalid,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "账号服务要求重新登录；本地缓存未被用于启动。",
        );
    }

    let license_reported_concurrent = matches!(licenses, RemoteOutcome::ConcurrentUse);
    let license_offline = matches!(licenses, RemoteOutcome::Offline);
    let remote_use =
        if matches!(enroll, EnrollOutcome::ConcurrentUse) || license_reported_concurrent {
            Sv2RemoteUseStatus::Detected
        } else if matches!(enroll, EnrollOutcome::Clear) {
            Sv2RemoteUseStatus::Clear
        } else {
            Sv2RemoteUseStatus::Unknown
        };
    let (authorization_status, voices) = match licenses {
        RemoteOutcome::Authorized(voices) => (Sv2AuthorizationStatus::Verified, voices),
        _ => (Sv2AuthorizationStatus::Unknown, Vec::new()),
    };
    let accepted = authorization_status == Sv2AuthorizationStatus::Verified
        || matches!(enroll, EnrollOutcome::Clear | EnrollOutcome::ConcurrentUse)
        || license_reported_concurrent;
    let offline = license_offline || matches!(enroll, EnrollOutcome::Offline);
    let session_status = if accepted {
        Sv2SessionInspectionStatus::Ready
    } else if offline {
        Sv2SessionInspectionStatus::Offline
    } else {
        Sv2SessionInspectionStatus::Ready
    };
    let detail = match (remote_use, authorization_status, offline) {
        (Sv2RemoteUseStatus::Clear, Sv2AuthorizationStatus::Verified, _) => {
            "官方服务已接受设备登录事件并返回有效声库授权；该账号可用于立即启动。"
        }
        (Sv2RemoteUseStatus::Clear, _, _) => "官方服务已接受设备登录事件；声库授权结果仍未知。",
        (Sv2RemoteUseStatus::Detected, Sv2AuthorizationStatus::Verified, _) => {
            "官方服务拒绝了无踢出登录事件，检测到其他会话占用；声库授权已读取。"
        }
        (Sv2RemoteUseStatus::Detected, _, _) => {
            "官方服务拒绝了无踢出登录事件，检测到其他会话占用。"
        }
        (_, Sv2AuthorizationStatus::Verified, true) => {
            "声库授权已读取，但设备登录检查暂时不可达；远端占用保持未知。"
        }
        (_, Sv2AuthorizationStatus::Verified, false) => {
            "声库授权已读取，但设备登录检查没有返回可判定结果；远端占用保持未知。"
        }
        (_, _, true) => "本地登录缓存有效，但官方服务暂时不可达；远端占用与授权保持未知。",
        _ => "官方服务没有返回可判定的登录或授权结果；状态保持未知。",
    };
    Sv2AccountProbeView::new(
        session_status,
        remote_use,
        authorization_status,
        voices,
        detail,
    )
}

fn view_from_active_license(licenses: RemoteOutcome) -> Sv2AccountProbeView {
    let view = view_from_remote(licenses, EnrollOutcome::Unknown);
    if view.session_status == Sv2SessionInspectionStatus::Invalid {
        return view;
    }
    let mut active = Sv2AccountProbeView::in_use_with_cached_authorization(Some(&view));
    if active.authorization_status == Sv2AuthorizationStatus::Verified {
        active.detail = "账号环境正在本机使用；已只读读取当前会话的声库授权。".to_string();
    } else if view.session_status == Sv2SessionInspectionStatus::Offline {
        active.detail = "账号环境正在本机使用；授权服务暂时不可达。".to_string();
    }
    active
}

struct SessionCredentials {
    buffer: Zeroizing<String>,
    access: Range<usize>,
    refresh: Range<usize>,
    access_expiry_text: Range<usize>,
    device_id: Range<usize>,
    user_id: Option<Range<usize>>,
    extensions: Range<usize>,
    access_issued_at: i64,
    access_expires_at: DateTime<Utc>,
}

impl SessionCredentials {
    fn access_token(&self) -> &str {
        &self.buffer[self.access.clone()]
    }

    fn refresh_token(&self) -> &str {
        &self.buffer[self.refresh.clone()]
    }

    fn device_id(&self) -> Option<&str> {
        let value = &self.buffer[self.device_id.clone()];
        (!value.is_empty()).then_some(value)
    }

    fn user_id(&self) -> Option<&str> {
        self.user_id
            .as_ref()
            .map(|range| &self.buffer[range.clone()])
            .filter(|value| !value.is_empty())
    }

    fn extension_text(&self) -> &str {
        &self.buffer[self.extensions.clone()]
    }

    /// Lines 1-4 plus their delimiter before the device-id field.
    fn token_core(&self) -> &str {
        &self.buffer[..self.extensions.start]
    }

    fn has_full_cache(&self) -> bool {
        self.user_id.is_some()
    }

    fn with_enrollment_identity(&self, device_id: &str, user_id: &str) -> Result<Self, ()> {
        if device_id.is_empty()
            || device_id.len() > 512
            || user_id.len() > 512
            || device_id.chars().any(char::is_control)
            || user_id.chars().any(char::is_control)
        {
            return Err(());
        }
        let mut plaintext = Zeroizing::new(String::with_capacity(self.buffer.len() + 1024));
        let session_written_at = Local::now().to_rfc3339_opts(SecondsFormat::Millis, false);
        write!(
            &mut *plaintext,
            "{}\n{}\n{}\n{}\n{}",
            self.access_token(),
            self.refresh_token(),
            &self.buffer[self.access_expiry_text.clone()],
            session_written_at,
            device_id,
        )
        .map_err(|_| ())?;
        if let Some(old_user) = &self.user_id {
            plaintext.push('\n');
            plaintext.push_str(user_id);
            plaintext.push_str(&self.buffer[old_user.end..]);
        }
        let bytes = Zeroizing::new(std::mem::take(&mut *plaintext).into_bytes());
        parse_session_plaintext(bytes)
    }

    /// Replaces lines 1-4 while preserving this copy's opaque line 5+
    /// extension.  When enrollment returned an identity, only the fields the
    /// native writer would expose for this copy's full-cache mode are changed.
    fn with_token_core_and_identity(
        &self,
        token_core: &str,
        identity: Option<(&str, &str)>,
    ) -> Result<Self, ()> {
        if !token_core.ends_with('\n') || token_core.len() > MAX_SESSION_BYTES {
            return Err(());
        }
        let mut plaintext = Zeroizing::new(String::with_capacity(
            token_core.len() + self.extension_text().len() + 1024,
        ));
        plaintext.push_str(token_core);
        match identity {
            None => plaintext.push_str(self.extension_text()),
            Some((device_id, user_id)) => {
                if device_id.is_empty()
                    || device_id.len() > 512
                    || user_id.len() > 512
                    || device_id.chars().any(char::is_control)
                    || user_id.chars().any(char::is_control)
                {
                    return Err(());
                }
                plaintext.push_str(device_id);
                if let Some(old_user) = &self.user_id {
                    plaintext.push('\n');
                    plaintext.push_str(user_id);
                    plaintext.push_str(&self.buffer[old_user.end..]);
                }
            }
        }
        let bytes = Zeroizing::new(std::mem::take(&mut *plaintext).into_bytes());
        parse_session_plaintext(bytes)
    }
}

#[derive(Deserialize)]
struct JwtHeader {
    alg: String,
}

#[derive(Deserialize)]
struct JwtClaims {
    #[serde(default)]
    exp: Option<i64>,
    iat: i64,
}

#[derive(Deserialize)]
struct JwtIdentityClaims<'a> {
    #[serde(default, borrow)]
    sub: Option<&'a str>,
    #[serde(default, borrow)]
    name: Option<&'a str>,
    #[serde(default, borrow)]
    preferred_username: Option<&'a str>,
    #[serde(default, borrow)]
    email: Option<&'a str>,
}

struct AccountIdentity {
    display_name: Option<String>,
    email: Option<String>,
}

fn decrypt_session(
    mut ciphertext: Zeroizing<Vec<u8>>,
    key: &[u8; 8],
) -> Result<Zeroizing<Vec<u8>>, ()> {
    if ciphertext.is_empty()
        || ciphertext.len() > MAX_SESSION_BYTES
        || !ciphertext.len().is_multiple_of(8)
    {
        return Err(());
    }

    let cipher: Blowfish = Blowfish::new_from_slice(key).map_err(|_| ())?;
    for chunk in ciphertext.as_chunks_mut::<8>().0 {
        // JUCE loads both halves as native little-endian uint32 values.  The
        // RustCrypto default Blowfish block adapter is big-endian.
        chunk[..4].reverse();
        chunk[4..].reverse();
        cipher.decrypt_block(blowfish::cipher::Block::<Blowfish>::from_mut_slice(chunk));
        chunk[..4].reverse();
        chunk[4..].reverse();
    }

    let padding = *ciphertext.last().ok_or(())? as usize;
    if !(1..=8).contains(&padding) || padding > ciphertext.len() {
        return Err(());
    }
    let unpadded_len = ciphertext.len() - padding;
    if !ciphertext[unpadded_len..]
        .iter()
        .all(|value| *value as usize == padding)
    {
        return Err(());
    }
    ciphertext[unpadded_len..].zeroize();
    ciphertext.truncate(unpadded_len);
    Ok(ciphertext)
}

fn encrypt_session(plaintext: &[u8], key: &[u8; 8]) -> Result<Zeroizing<Vec<u8>>, ()> {
    if plaintext.is_empty() || plaintext.len() > MAX_SESSION_BYTES.saturating_sub(8) {
        return Err(());
    }
    let cipher: Blowfish = Blowfish::new_from_slice(key).map_err(|_| ())?;
    let mut ciphertext = Zeroizing::new(Vec::with_capacity(plaintext.len() + 8));
    ciphertext.extend_from_slice(plaintext);
    let padding = 8 - ciphertext.len() % 8;
    ciphertext.extend(std::iter::repeat_n(padding as u8, padding));
    for chunk in ciphertext.as_chunks_mut::<8>().0 {
        chunk[..4].reverse();
        chunk[4..].reverse();
        cipher.encrypt_block(blowfish::cipher::Block::<Blowfish>::from_mut_slice(chunk));
        chunk[..4].reverse();
        chunk[4..].reverse();
    }
    Ok(ciphertext)
}

fn parse_session_plaintext(mut plaintext: Zeroizing<Vec<u8>>) -> Result<SessionCredentials, ()> {
    let bytes = std::mem::take(&mut *plaintext);
    let buffer = match String::from_utf8(bytes) {
        Ok(value) => Zeroizing::new(value),
        Err(error) => {
            let _invalid = Zeroizing::new(error.into_bytes());
            return Err(());
        }
    };

    if buffer.is_empty() || buffer.len() > MAX_SESSION_BYTES || buffer.as_bytes().contains(&b'\r') {
        return Err(());
    }
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for (index, value) in buffer.as_bytes().iter().enumerate() {
        if *value == b'\n' {
            ranges.push(start..index);
            start = index + 1;
            if ranges.len() > 4096 {
                return Err(());
            }
        }
    }
    ranges.push(start..buffer.len());
    if ranges.len() < 5 || ranges[..4].iter().any(Range::is_empty) {
        return Err(());
    }
    let device_id = &buffer[ranges[4].clone()];
    let user_id = ranges.get(5).map(|range| &buffer[range.clone()]);
    if device_id.len() > 512
        || user_id.is_some_and(|value| value.len() > 512)
        || device_id.chars().any(char::is_control)
        || user_id.is_some_and(|value| value.chars().any(char::is_control))
    {
        return Err(());
    }

    let access = &buffer[ranges[0].clone()];
    let refresh = &buffer[ranges[1].clone()];
    if access.len() > MAX_JWT_BYTES
        || refresh.len() > MAX_JWT_BYTES
        || !access.is_ascii()
        || !refresh.is_ascii()
    {
        return Err(());
    }
    let access_claims = parse_jwt(access, true)?;
    let refresh_claims = parse_jwt(refresh, false)?;

    let access_expires_at = parse_session_time(&buffer[ranges[2].clone()])?;
    let _session_written_at = parse_session_time(&buffer[ranges[3].clone()])?;
    if !timestamp_near_claim(access_expires_at, access_claims.exp.ok_or(())?)
        || !reasonable_iat(access_claims.iat, access_claims.exp)
        || !reasonable_iat(refresh_claims.iat, refresh_claims.exp)
    {
        return Err(());
    }

    let extensions = ranges[4].start..buffer.len();
    Ok(SessionCredentials {
        buffer,
        access: ranges[0].clone(),
        refresh: ranges[1].clone(),
        access_expiry_text: ranges[2].clone(),
        device_id: ranges[4].clone(),
        user_id: ranges.get(5).cloned(),
        extensions,
        access_issued_at: access_claims.iat,
        access_expires_at,
    })
}

/// Returns a fixed-length, non-reversible identifier for one account.  Normal
/// and Sandboxie copies of an account slot deliberately share this authority
/// even if Keycloak rotated their `sid`: preflight is account-scoped, not
/// environment-scoped. Borrowed identity fields never outlive the zeroizing
/// decoded payload.
fn account_group_key(access_token: &str) -> Option<[u8; 32]> {
    let payload_part = access_token.split('.').nth(1)?;
    let payload = decode_base64url(payload_part).ok()?;
    let claims: JwtIdentityClaims<'_> = serde_json::from_slice(&payload).ok()?;
    let subject = claims.sub.filter(|value| !value.is_empty())?;

    let mut digest = Sha256::new();
    digest.update(b"sv2-account-probe/account/v1\0");
    digest.update((subject.len() as u64).to_be_bytes());
    digest.update(subject.as_bytes());
    Some(digest.finalize().into())
}

fn account_identity(access_token: &str) -> Option<AccountIdentity> {
    let payload_part = access_token.split('.').nth(1)?;
    let payload = decode_base64url(payload_part).ok()?;
    let claims: JwtIdentityClaims<'_> = serde_json::from_slice(&payload).ok()?;
    let display_name = claims
        .name
        .and_then(normalize_account_name)
        .or_else(|| claims.preferred_username.and_then(normalize_account_name));
    let email = claims.email.and_then(normalize_account_email);
    if display_name.is_none() && email.is_none() {
        None
    } else {
        Some(AccountIdentity {
            display_name,
            email,
        })
    }
}

fn normalize_account_name(value: &str) -> Option<String> {
    if value.chars().any(char::is_control) {
        return None;
    }
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() || normalized.chars().count() > 160 {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_account_email(value: &str) -> Option<String> {
    let normalized = value.trim();
    let (local, domain) = normalized.split_once('@')?;
    if local.is_empty()
        || domain.is_empty()
        || normalized.len() > 254
        || normalized.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || character == '<'
                || character == '>'
        })
    {
        None
    } else {
        Some(normalized.to_string())
    }
}

fn choose_authority<'a, I>(candidates: I) -> Option<usize>
where
    I: IntoIterator<Item = (usize, &'a SessionCredentials, bool)>,
{
    candidates
        .into_iter()
        .max_by_key(|(index, credentials, preferred)| {
            (
                credentials.access_issued_at,
                credentials.access_expires_at.timestamp_millis(),
                *preferred,
                Reverse(*index),
            )
        })
        .map(|(index, _, _)| index)
}

fn timestamp_near_claim(value: DateTime<Utc>, claim_seconds: i64) -> bool {
    value
        .timestamp_millis()
        .checked_sub(claim_seconds.saturating_mul(1000))
        .is_some_and(|difference| difference.unsigned_abs() <= MAX_TOKEN_CLOCK_SKEW_MILLIS)
}

fn reasonable_iat(iat: i64, exp: Option<i64>) -> bool {
    iat > 0
        && DateTime::<Utc>::from_timestamp(iat, 0).is_some()
        && exp.is_none_or(|expires| {
            DateTime::<Utc>::from_timestamp(expires, 0).is_some() && iat <= expires
        })
}

fn parse_session_time(value: &str) -> Result<DateTime<Utc>, ()> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| ())?
        .with_timezone(&Utc);
    if parsed.timestamp_subsec_nanos() % 1_000_000 != 0 {
        return Err(());
    }
    Ok(parsed)
}

fn parse_jwt(token: &str, require_exp: bool) -> Result<JwtClaims, ()> {
    let mut parts = token.split('.');
    let header_part = parts.next().ok_or(())?;
    let payload_part = parts.next().ok_or(())?;
    let signature_part = parts.next().ok_or(())?;
    if parts.next().is_some()
        || header_part.is_empty()
        || payload_part.is_empty()
        || signature_part.is_empty()
        || header_part.len() > MAX_JWT_PART_BYTES
        || payload_part.len() > MAX_JWT_PART_BYTES
        || signature_part.len() > MAX_JWT_PART_BYTES
        || !valid_base64url_part(signature_part)
    {
        return Err(());
    }

    let header_bytes = decode_base64url(header_part)?;
    let header: JwtHeader = serde_json::from_slice(&header_bytes).map_err(|_| ())?;
    if header.alg.trim().is_empty() || header.alg.eq_ignore_ascii_case("none") {
        return Err(());
    }

    let payload_bytes = decode_base64url(payload_part)?;
    let claims: JwtClaims = serde_json::from_slice(&payload_bytes).map_err(|_| ())?;
    if require_exp && claims.exp.is_none() {
        return Err(());
    }
    Ok(claims)
}

fn valid_base64url_part(value: &str) -> bool {
    let mut padding_started = false;
    value.bytes().all(|byte| match byte {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' if !padding_started => true,
        b'=' => {
            padding_started = true;
            true
        }
        _ => false,
    })
}

fn decode_base64url(value: &str) -> Result<Zeroizing<Vec<u8>>, ()> {
    if value.is_empty() || value.len() > MAX_JWT_PART_BYTES {
        return Err(());
    }
    let output_len = base64::decoded_len_estimate(value.len());
    if output_len == 0 || output_len > MAX_JWT_JSON_BYTES {
        return Err(());
    }
    let mut output = Zeroizing::new(vec![0u8; output_len]);
    let decoded = match URL_SAFE_NO_PAD.decode_slice(value.as_bytes(), &mut output) {
        Ok(length) => length,
        Err(_) => {
            output.zeroize();
            URL_SAFE
                .decode_slice(value.as_bytes(), &mut output)
                .map_err(|_| ())?
        }
    };
    if decoded > MAX_JWT_JSON_BYTES {
        return Err(());
    }
    output[decoded..].zeroize();
    output.truncate(decoded);
    Ok(output)
}

#[cfg(windows)]
#[derive(Deserialize)]
struct TokenRefreshResponse<'a> {
    #[serde(borrow)]
    access_token: &'a str,
    #[serde(borrow)]
    refresh_token: &'a str,
    expires_in: i64,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum RefreshFailure {
    Expired,
    UnsupportedClient,
    Unavailable(u16),
    Rejected(u16),
    Ambiguous,
}

#[cfg(windows)]
#[derive(Deserialize)]
struct RefreshClientClaims<'a> {
    #[serde(borrow)]
    iss: Option<&'a str>,
    #[serde(borrow)]
    azp: Option<&'a str>,
}

#[cfg(windows)]
fn refresh_client_id(access_token: &str) -> Result<String, ()> {
    let payload = decode_base64url(access_token.split('.').nth(1).ok_or(())?)?;
    let claims: RefreshClientClaims<'_> = serde_json::from_slice(&payload).map_err(|_| ())?;
    let client_id = claims.azp.ok_or(())?;
    if claims.iss != Some(TOKEN_ISSUER)
        || client_id.is_empty()
        || client_id.len() > 160
        || !client_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-._".contains(character))
    {
        return Err(());
    }
    Ok(client_id.to_string())
}

#[cfg(windows)]
fn refresh_failure_for_http_response(status: u16, body: &[u8]) -> RefreshFailure {
    if status == 403 || status == 429 || status >= 500 {
        return RefreshFailure::Unavailable(status);
    }
    if contains_json_string(body, b"invalid_grant") || contains_json_string(body, RELOGIN_ERROR) {
        RefreshFailure::Expired
    } else if (400..500).contains(&status) {
        RefreshFailure::Rejected(status)
    } else {
        RefreshFailure::Ambiguous
    }
}

#[cfg(windows)]
fn refresh_session_credentials(
    agent: &ureq::Agent,
    current: &SessionCredentials,
) -> Result<SessionCredentials, RefreshFailure> {
    let client_id =
        refresh_client_id(current.access_token()).map_err(|_| RefreshFailure::UnsupportedClient)?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("grant_type", "refresh_token");
    serializer.append_pair("refresh_token", current.refresh_token());
    serializer.append_pair("client_id", &client_id);
    let form = Zeroizing::new(serializer.finish());
    let response = agent
        .post(TOKEN_URL)
        .set("Accept", "application/json")
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("User-Agent", "SynthV-Toolbox/account-indicator")
        .send_string(&form);
    drop(form);

    let (status, response) = match response {
        Ok(response) => (response.status(), response),
        Err(ureq::Error::Status(status, response)) => (status, response),
        Err(ureq::Error::Transport(_)) => return Err(RefreshFailure::Ambiguous),
    };
    let body = match read_bounded_response(response) {
        Ok(body) => body,
        Err(ResponseReadFailure::Transport | ResponseReadFailure::TooLarge) => {
            return Err(RefreshFailure::Ambiguous);
        }
    };
    if status != 200 {
        return Err(refresh_failure_for_http_response(status, &body));
    }

    let refreshed: TokenRefreshResponse<'_> =
        serde_json::from_slice(&body).map_err(|_| RefreshFailure::Ambiguous)?;
    if refreshed.access_token.is_empty()
        || refreshed.refresh_token.is_empty()
        || refreshed.access_token.len() > MAX_JWT_BYTES
        || refreshed.refresh_token.len() > MAX_JWT_BYTES
        || !refreshed.access_token.is_ascii()
        || !refreshed.refresh_token.is_ascii()
        || !(1..=7 * 24 * 60 * 60).contains(&refreshed.expires_in)
    {
        return Err(RefreshFailure::Ambiguous);
    }
    parse_jwt(refreshed.access_token, true).map_err(|_| RefreshFailure::Ambiguous)?;
    parse_jwt(refreshed.refresh_token, false).map_err(|_| RefreshFailure::Ambiguous)?;

    let session_written_at = Local::now();
    let access_expires_at = session_written_at
        .checked_add_signed(ChronoDuration::seconds(refreshed.expires_in))
        .ok_or(RefreshFailure::Ambiguous)?;
    let mut plaintext = Zeroizing::new(String::with_capacity(
        refreshed.access_token.len()
            + refreshed.refresh_token.len()
            + current.extension_text().len()
            + 96,
    ));
    write!(
        &mut *plaintext,
        "{}\n{}\n{}\n{}\n",
        refreshed.access_token,
        refreshed.refresh_token,
        access_expires_at.to_rfc3339_opts(SecondsFormat::Millis, false),
        session_written_at.to_rfc3339_opts(SecondsFormat::Millis, false),
    )
    .map_err(|_| RefreshFailure::Ambiguous)?;
    plaintext.push_str(current.extension_text());
    let bytes = Zeroizing::new(std::mem::take(&mut *plaintext).into_bytes());
    parse_session_plaintext(bytes).map_err(|_| RefreshFailure::Ambiguous)
}

fn juce_hash64(value: &str) -> u64 {
    value.chars().fold(0u64, |hash, character| {
        hash.wrapping_mul(101)
            .wrapping_add(u64::from(character as u32))
    })
}

fn derive_machine_key_from_raw_smbios(raw: &[u8]) -> Result<Zeroizing<[u8; 8]>, ()> {
    let material = collect_juce_machine_material(raw)?;
    let first_hash = juce_hash64(&material) as i64;
    let decimal = Zeroizing::new(first_hash.to_string());
    Ok(Zeroizing::new(juce_hash64(&decimal).to_le_bytes()))
}

fn collect_juce_machine_material(raw: &[u8]) -> Result<Zeroizing<String>, ()> {
    if raw.len() < 8 || raw.len() > MAX_FIRMWARE_BYTES {
        return Err(());
    }
    let declared = u32::from_le_bytes(raw[4..8].try_into().map_err(|_| ())?) as usize;
    if declared == 0 || declared > raw.len() - 8 {
        return Err(());
    }
    let table = &raw[8..8 + declared];
    let mut material = Zeroizing::new(String::new());
    let mut offset = 0usize;

    while offset < table.len() {
        let remaining = &table[offset..];
        if remaining.len() < 4 {
            return Err(());
        }
        let structure_type = remaining[0];
        let formatted_len = remaining[1] as usize;
        if formatted_len < 4 || formatted_len > remaining.len() {
            return Err(());
        }
        let strings_start = offset + formatted_len;
        let strings_end = find_double_nul(table, strings_start).ok_or(())?;
        let formatted = &table[offset..strings_start];
        let strings = &table[strings_start..=strings_end];

        match structure_type {
            1 => {
                append_smbios_string(&mut material, formatted, strings, 0x04)?;
                append_smbios_string(&mut material, formatted, strings, 0x05)?;
                // JUCE 8 uses this strict check against the remaining content.
                if 0x08 + 16 < remaining.len() && formatted.len() >= 0x08 + 16 {
                    for byte in &formatted[0x08..0x08 + 16] {
                        write!(&mut *material, "{byte:02X}").map_err(|_| ())?;
                    }
                }
                material.push('\n');
            }
            2 => {
                for field in [0x04, 0x05, 0x06, 0x07, 0x08] {
                    append_smbios_string(&mut material, formatted, strings, field)?;
                }
            }
            4 => {
                for field in [0x07, 0x10, 0x21, 0x22] {
                    append_smbios_string(&mut material, formatted, strings, field)?;
                }
            }
            127 => break,
            _ => {}
        }

        offset = strings_end.checked_add(2).ok_or(())?;
    }
    Ok(material)
}

fn find_double_nul(table: &[u8], start: usize) -> Option<usize> {
    if start >= table.len() {
        return None;
    }
    (start..table.len().saturating_sub(1))
        .find(|index| table[*index] == 0 && table[*index + 1] == 0)
}

fn append_smbios_string(
    output: &mut String,
    formatted: &[u8],
    strings: &[u8],
    field: usize,
) -> Result<(), ()> {
    let index = formatted.get(field).copied().unwrap_or(0);
    if index != 0 {
        let value = nth_smbios_string(strings, index).ok_or(())?;
        output.push_str(std::str::from_utf8(value).map_err(|_| ())?);
    }
    output.push('\n');
    Ok(())
}

fn nth_smbios_string(strings: &[u8], wanted: u8) -> Option<&[u8]> {
    let mut index = 1u16;
    let mut offset = 0usize;
    while offset < strings.len() && strings[offset] != 0 {
        let end = strings[offset..]
            .iter()
            .position(|value| *value == 0)?
            .checked_add(offset)?;
        if index == u16::from(wanted) {
            return Some(&strings[offset..end]);
        }
        index += 1;
        offset = end.checked_add(1)?;
    }
    None
}

#[derive(Deserialize)]
struct LicenseEnvelope {
    data: Option<Vec<LicenseItem>>,
}

#[derive(Deserialize)]
struct LicenseItem {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    product: Option<LicenseProduct>,
}

#[derive(Deserialize)]
struct LicenseProduct {
    #[serde(default)]
    name: Option<String>,
    #[serde(
        default,
        rename = "type",
        alias = "productType",
        alias = "product_type"
    )]
    kind: Option<String>,
}

fn interpret_license_response(status: u16, body: Zeroizing<Vec<u8>>) -> RemoteOutcome {
    if contains_json_string(&body, CONCURRENT_ERROR) || contains_json_string(&body, KICKOUT_ERROR) {
        return RemoteOutcome::ConcurrentUse;
    }
    if status == 401 || status == 403 {
        return RemoteOutcome::Unauthorized;
    }
    if status != 200 {
        return RemoteOutcome::Unknown;
    }
    let Some(voices) = extract_authorized_voices(&body) else {
        return RemoteOutcome::Unknown;
    };
    RemoteOutcome::Authorized(voices)
}

fn contains_json_string(body: &[u8], needle: &[u8]) -> bool {
    let needed = needle.len().saturating_add(2);
    body.windows(needed).any(|window| {
        window.first() == Some(&b'"')
            && window.last() == Some(&b'"')
            && &window[1..needed - 1] == needle
    })
}

fn extract_authorized_voices(body: &[u8]) -> Option<Vec<String>> {
    let envelope: LicenseEnvelope = serde_json::from_slice(body).ok()?;
    let licenses = envelope.data?;
    if licenses.len() > MAX_LICENSE_ITEMS {
        return None;
    }

    let mut names = BTreeMap::<String, String>::new();
    for license in licenses {
        if license.status.as_deref() != Some("active") {
            continue;
        }
        let Some(product) = license.product else {
            continue;
        };
        if !is_voice_product(&product) {
            continue;
        }
        let Some(name) = product.name.and_then(normalize_product_name) else {
            continue;
        };
        names.entry(name.to_lowercase()).or_insert(name);
    }

    let mut voices = names.into_values().collect::<Vec<_>>();
    voices.sort_by(|left, right| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
    voices.truncate(MAX_AUTHORIZED_VOICES);
    Some(voices)
}

fn is_voice_product(product: &LicenseProduct) -> bool {
    matches!(
        product.kind.as_deref(),
        Some("Voice Database" | "Voice Databases 2")
    )
}

fn normalize_product_name(value: String) -> Option<String> {
    if value.chars().any(char::is_control) {
        return None;
    }
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() || normalized.chars().count() > MAX_PRODUCT_NAME_CHARS {
        None
    } else {
        Some(normalized)
    }
}

#[cfg(windows)]
#[derive(Clone, Eq)]
struct SessionCacheKey {
    canonical_root: PathBuf,
    session_len: u64,
    last_write_time: u64,
}

#[cfg(windows)]
#[derive(Clone, Eq, Hash, PartialEq)]
enum ProbeRootKey {
    AccountEnvironment { slot_id: String, concurrent: bool },
    CanonicalRoot(PathBuf),
}

#[cfg(windows)]
#[derive(Clone, Eq, Hash, PartialEq)]
enum SyncQuarantineKey {
    AccountSlot(String),
    CanonicalRoot(PathBuf),
}

#[cfg(windows)]
impl ProbeRootKey {
    fn quarantine_key(&self) -> SyncQuarantineKey {
        match self {
            Self::AccountEnvironment { slot_id, .. } => {
                SyncQuarantineKey::AccountSlot(slot_id.clone())
            }
            Self::CanonicalRoot(path) => SyncQuarantineKey::CanonicalRoot(path.clone()),
        }
    }

    fn belongs_to_quarantine(&self, quarantine: &SyncQuarantineKey) -> bool {
        match (self, quarantine) {
            (
                Self::AccountEnvironment { slot_id, .. },
                SyncQuarantineKey::AccountSlot(quarantined_slot),
            ) => slot_id == quarantined_slot,
            (Self::CanonicalRoot(path), SyncQuarantineKey::CanonicalRoot(quarantined_path)) => {
                path == quarantined_path
            }
            _ => false,
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Eq, Hash, PartialEq)]
struct ProbeCacheKey {
    root: ProbeRootKey,
    session_len: u64,
    last_write_time: u64,
}

#[cfg(windows)]
impl ProbeCacheKey {
    fn new(fingerprint: &SessionCacheKey, root: &ProbeRootKey) -> Self {
        Self {
            root: root.clone(),
            session_len: fingerprint.session_len,
            last_write_time: fingerprint.last_write_time,
        }
    }
}

#[cfg(windows)]
fn probe_root_key(logical_identity: Option<(&str, bool)>, canonical_root: &Path) -> ProbeRootKey {
    match logical_identity {
        Some((slot_id, concurrent)) => ProbeRootKey::AccountEnvironment {
            slot_id: slot_id.to_string(),
            concurrent,
        },
        None => ProbeRootKey::CanonicalRoot(canonical_root.to_path_buf()),
    }
}

#[cfg(windows)]
type StableSessionSnapshot = (Zeroizing<Vec<u8>>, SessionCacheKey);

#[cfg(windows)]
impl PartialEq for SessionCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.canonical_root == other.canonical_root
            && self.session_len == other.session_len
            && self.last_write_time == other.last_write_time
    }
}

#[cfg(windows)]
impl Hash for SessionCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.canonical_root.hash(state);
        self.session_len.hash(state);
        self.last_write_time.hash(state);
    }
}

#[cfg(windows)]
struct CacheEntry {
    stored_at: Instant,
    ttl: Duration,
    view: Sv2AccountProbeView,
}

#[cfg(windows)]
static PROBE_CACHE: OnceLock<Mutex<HashMap<ProbeCacheKey, CacheEntry>>> = OnceLock::new();

/// A refresh-token rotation can succeed remotely while a local CAS write loses
/// a race. Fingerprint-keyed cache entries are not sufficient in that case:
/// the changed file has a new fingerprint but is not known to contain the
/// rotated token. Keep a separate slot-level quarantine until an explicit
/// precheck proves and persists one coherent authority across every physical
/// copy again. A normal/concurrent copy created later must inherit the same
/// quarantine instead of becoming a second authority.
#[cfg(windows)]
static SYNC_QUARANTINE: OnceLock<Mutex<HashMap<SyncQuarantineKey, Sv2AccountProbeView>>> =
    OnceLock::new();

pub(crate) fn clear_sv2_account_probe_cache() {
    #[cfg(windows)]
    if let Some(cache) = PROBE_CACHE.get() {
        cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
    #[cfg(windows)]
    if let Some(quarantine) = SYNC_QUARANTINE.get() {
        for view in quarantine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values_mut()
        {
            view.account_display_name = None;
            view.account_email = None;
        }
    }
    // A slot-level SyncFailed quarantine is a launch-safety invariant, not a
    // reusable account result. Disabling the indicator may clear sanitized
    // observations, but only a successful explicit repair may clear it. A
    // transiently missing/renamed session must not make an old rotated token
    // eligible again when the file reappears.
}

#[cfg(windows)]
fn probe_cache() -> &'static Mutex<HashMap<ProbeCacheKey, CacheEntry>> {
    PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn sync_quarantine() -> &'static Mutex<HashMap<SyncQuarantineKey, Sv2AccountProbeView>> {
    SYNC_QUARANTINE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn sync_quarantine_get(key: &SyncQuarantineKey) -> Option<Sv2AccountProbeView> {
    sync_quarantine()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(key)
        .cloned()
}

#[cfg(windows)]
fn set_sync_quarantine(key: &SyncQuarantineKey, view: &Sv2AccountProbeView) {
    debug_assert_eq!(view.session_status, Sv2SessionInspectionStatus::SyncFailed);
    sync_quarantine()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key.clone(), view.clone());
}

#[cfg(windows)]
fn clear_sync_quarantine(key: &SyncQuarantineKey) {
    if let Some(quarantine) = SYNC_QUARANTINE.get() {
        quarantine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(key);
    }
    // A SyncFailed view may also exist under the pre-race fingerprint. Remove
    // every ordinary cache entry covered by this slot so clearing the safety
    // marker cannot reveal a stale permanent result in the other mode.
    if let Some(cache) = PROBE_CACHE.get() {
        cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|cache_key, _| !cache_key.root.belongs_to_quarantine(key));
    }
}

#[cfg(windows)]
fn probe_root_key_for_identity(
    data_root: &Path,
    logical_identity: Option<(&str, bool)>,
) -> Option<ProbeRootKey> {
    match logical_identity {
        Some((slot_id, concurrent)) => Some(probe_root_key(Some((slot_id, concurrent)), data_root)),
        None => fs::canonicalize(data_root)
            .ok()
            .map(|canonical_root| probe_root_key(None, &canonical_root)),
    }
}

#[cfg(windows)]
fn cache_get(fingerprint: &SessionCacheKey, root: &ProbeRootKey) -> Option<Sv2AccountProbeView> {
    let now = Instant::now();
    let cache = probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache
        .get(&ProbeCacheKey::new(fingerprint, root))
        .filter(|entry| now.saturating_duration_since(entry.stored_at) <= entry.ttl)
        .map(|entry| entry.view.clone())
}

#[cfg(windows)]
fn cached_view_for_fingerprint(
    fingerprint: &SessionCacheKey,
    root: &ProbeRootKey,
) -> Option<Sv2AccountProbeView> {
    if let Some(view) = sync_quarantine_get(&root.quarantine_key()) {
        return Some(view);
    }
    if let Some(view) = cache_get(fingerprint, root) {
        return Some(view);
    }
    cached_identity_for_fingerprint(fingerprint, root).map(|(name, email)| {
        let mut view = Sv2AccountProbeView::not_checked(true);
        view.account_display_name = name;
        view.account_email = email;
        view
    })
}

#[cfg(windows)]
fn cached_identity_for_fingerprint(
    fingerprint: &SessionCacheKey,
    root: &ProbeRootKey,
) -> Option<(Option<String>, Option<String>)> {
    let cache = probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache
        .get(&ProbeCacheKey::new(fingerprint, root))
        .filter(|entry| entry.view.session_status != Sv2SessionInspectionStatus::AccountMismatch)
        .and_then(|entry| cached_identity(&entry.view))
}

#[cfg(windows)]
fn cached_identity_for_root(root: &ProbeRootKey) -> Option<(Option<String>, Option<String>)> {
    let cache = probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache
        .iter()
        .filter(|(key, entry)| {
            key.root == *root
                && entry.view.session_status != Sv2SessionInspectionStatus::AccountMismatch
                && cached_identity(&entry.view).is_some()
        })
        .max_by_key(|(_, entry)| entry.stored_at)
        .and_then(|(_, entry)| cached_identity(&entry.view))
}

#[cfg(windows)]
fn cached_identity(view: &Sv2AccountProbeView) -> Option<(Option<String>, Option<String>)> {
    (view.account_display_name.is_some() || view.account_email.is_some()).then(|| {
        (
            view.account_display_name.clone(),
            view.account_email.clone(),
        )
    })
}

#[cfg(windows)]
fn cache_put(
    fingerprint: SessionCacheKey,
    root: &ProbeRootKey,
    view: &Sv2AccountProbeView,
    access_expires_at: Option<DateTime<Utc>>,
) {
    let mut ttl = match (
        view.session_status,
        view.authorization_status,
        view.remote_use,
    ) {
        (_, _, Sv2RemoteUseStatus::Detected) => Duration::from_secs(5),
        (_, Sv2AuthorizationStatus::Verified, _) => Duration::from_secs(30),
        (Sv2SessionInspectionStatus::Offline, _, _) => Duration::from_secs(3),
        (Sv2SessionInspectionStatus::Invalid, _, _) => Duration::from_secs(5),
        (Sv2SessionInspectionStatus::SyncFailed, _, _) => Duration::MAX,
        (Sv2SessionInspectionStatus::AccountMismatch, _, _) => Duration::MAX,
        (Sv2SessionInspectionStatus::Expired, _, _) => Duration::from_secs(15),
        _ => Duration::from_secs(5),
    };
    if let Some(expires_at) = access_expires_at {
        let Ok(remaining) = (expires_at - Utc::now()).to_std() else {
            return;
        };
        ttl = ttl.min(remaining);
    }
    if ttl.is_zero() {
        return;
    }

    let now = Instant::now();
    let mut cache = probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = ProbeCacheKey::new(&fingerprint, root);
    if cache.len() >= 32 && !cache.contains_key(&key) {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.stored_at)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        key,
        CacheEntry {
            stored_at: now,
            ttl,
            view: view.clone(),
        },
    );
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum BatchGroupKey {
    Account(usize, [u8; 32]),
    Singleton(usize),
}

#[cfg(windows)]
struct PendingBatchSession {
    request_index: usize,
    data_root: PathBuf,
    ciphertext: Zeroizing<Vec<u8>>,
    fingerprint: SessionCacheKey,
    root_key: ProbeRootKey,
    account_scope: Option<usize>,
    preferred_source: bool,
}

#[cfg(windows)]
struct EquivalentSessionAlias {
    leader_request_index: usize,
    fingerprint: SessionCacheKey,
    root_key: ProbeRootKey,
}

#[cfg(windows)]
fn is_equivalent_session_root(
    account_scope: Option<usize>,
    canonical_root: &Path,
    pending_scope: Option<usize>,
    pending_root: &Path,
) -> bool {
    account_scope == pending_scope && canonical_root == pending_root
}

#[cfg(windows)]
struct BatchSession {
    request_index: usize,
    data_root: PathBuf,
    fingerprint: SessionCacheKey,
    root_key: ProbeRootKey,
    quarantine_key: SyncQuarantineKey,
    credentials: SessionCredentials,
    group: BatchGroupKey,
    account_scope: Option<usize>,
    preferred_source: bool,
    sync_quarantined: bool,
}

#[cfg(windows)]
struct BatchPlan {
    groups: BTreeMap<BatchGroupKey, Vec<usize>>,
    mismatches: Vec<usize>,
    invalid_scope_members: Vec<usize>,
}

#[cfg(windows)]
fn plan_batch_sessions(sessions: &[BatchSession]) -> BatchPlan {
    let mut excluded = vec![false; sessions.len()];
    let mut mismatches = Vec::new();
    let mut invalid_scope_members = Vec::new();
    let mut scope_members = BTreeMap::<usize, Vec<usize>>::new();
    for (index, session) in sessions.iter().enumerate() {
        if let Some(account_scope) = session.account_scope {
            scope_members.entry(account_scope).or_default().push(index);
        }
    }

    for members in scope_members.into_values() {
        let preferred_members = members
            .iter()
            .copied()
            .filter(|index| sessions[*index].preferred_source)
            .collect::<Vec<_>>();
        if preferred_members.len() > 1 {
            for member in members {
                excluded[member] = true;
                invalid_scope_members.push(member);
            }
            continue;
        }
        let preferred = preferred_members.first().copied().or_else(|| {
            choose_authority(members.iter().map(|index| {
                (
                    *index,
                    &sessions[*index].credentials,
                    sessions[*index].preferred_source,
                )
            }))
        });
        let Some(preferred) = preferred else {
            continue;
        };
        let expected_group = sessions[preferred].group;
        for member in members {
            if sessions[member].group != expected_group {
                excluded[member] = true;
                mismatches.push(member);
            }
        }
    }

    let mut groups = BTreeMap::<BatchGroupKey, Vec<usize>>::new();
    for (index, session) in sessions.iter().enumerate() {
        if !excluded[index] {
            groups.entry(session.group).or_default().push(index);
        }
    }
    BatchPlan {
        groups,
        mismatches,
        invalid_scope_members,
    }
}

#[cfg(windows)]
fn refresh_failure_view(failure: RefreshFailure) -> Sv2AccountProbeView {
    match failure {
        RefreshFailure::UnsupportedClient => Sv2AccountProbeView::new(
            Sv2SessionInspectionStatus::Unsupported,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "会话未提供可识别的官方客户端标识；未发送续期请求或修改本地文件。",
        ),
        RefreshFailure::Expired => Sv2AccountProbeView::new(
            Sv2SessionInspectionStatus::Expired,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "已从该账号普通/隔离缓存中选择最新 authority 尝试自动续期，但官方令牌端点明确要求重新登录。",
        ),
        RefreshFailure::Unavailable(status) => Sv2AccountProbeView::new(
            Sv2SessionInspectionStatus::Offline,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            &format!("账号令牌端点暂不可用（HTTP {status}）；未刷新或修改本地会话。"),
        ),
        RefreshFailure::Rejected(status) => Sv2AccountProbeView::new(
            Sv2SessionInspectionStatus::Offline,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            &format!("账号令牌请求被拒绝（HTTP {status}）；未刷新或修改本地会话。"),
        ),
        RefreshFailure::Ambiguous => Sv2AccountProbeView::sync_failed(
            "refresh 请求可能已被令牌端点接收，但未取得可安全验证的完整响应；服务端可能已经轮换 refresh token，本组等待下一次显式预检修复。",
        ),
    }
}

#[cfg(windows)]
fn cache_group_view(
    results: &mut [Option<Sv2AccountProbeView>],
    sessions: &[BatchSession],
    members: &[usize],
    view: &Sv2AccountProbeView,
    access_expires_at: Option<DateTime<Utc>>,
) {
    for member in members {
        let session = &sessions[*member];
        cache_put(
            session.fingerprint.clone(),
            &session.root_key,
            view,
            access_expires_at,
        );
        results[session.request_index] = Some(view.clone());
    }
}

#[cfg(windows)]
fn quarantine_group_view(
    results: &mut [Option<Sv2AccountProbeView>],
    sessions: &mut [BatchSession],
    members: &[usize],
    view: &Sv2AccountProbeView,
) {
    for member in members {
        let session = &mut sessions[*member];
        set_sync_quarantine(&session.quarantine_key, view);
        session.sync_quarantined = true;
        cache_put(session.fingerprint.clone(), &session.root_key, view, None);
        results[session.request_index] = Some(view.clone());
    }
}

#[cfg(windows)]
fn synchronize_account_copies(
    sessions: &mut [BatchSession],
    members: &[usize],
    authority: usize,
    results: &mut [Option<Sv2AccountProbeView>],
    token_core: &str,
    identity: Option<(&str, &str)>,
    key: &[u8; 8],
) -> usize {
    let mut synchronized = 0;
    for member in members {
        if *member == authority || results[sessions[*member].request_index].is_some() {
            continue;
        }
        let updated = match sessions[*member]
            .credentials
            .with_token_core_and_identity(token_core, identity)
        {
            Ok(value) => value,
            Err(()) => {
                let view = Sv2AccountProbeView::sync_failed(
                    "无法把账号 authority 会话转换为该副本的官方缓存结构；该环境保持隔离，等待下一次显式预检修复。",
                )
                .with_account_identity(sessions[*member].credentials.access_token());
                set_sync_quarantine(&sessions[*member].quarantine_key, &view);
                sessions[*member].sync_quarantined = true;
                cache_put(
                    sessions[*member].fingerprint.clone(),
                    &sessions[*member].root_key,
                    &view,
                    None,
                );
                results[sessions[*member].request_index] = Some(view);
                continue;
            }
        };
        if updated.buffer.as_str() == sessions[*member].credentials.buffer.as_str() {
            let stable = inspect_session_fingerprint(&sessions[*member].data_root)
                .ok()
                .flatten()
                .as_ref()
                == Some(&sessions[*member].fingerprint);
            if stable {
                sessions[*member].sync_quarantined = false;
                synchronized += 1;
            } else {
                let view = Sv2AccountProbeView::sync_failed(
                    "该物理副本在确认 authority 会话期间发生变化；为避免误清旧 refresh token 隔离，本次不用于自动启动。",
                )
                .with_account_identity(sessions[*member].credentials.access_token());
                set_sync_quarantine(&sessions[*member].quarantine_key, &view);
                sessions[*member].sync_quarantined = true;
                cache_put(
                    sessions[*member].fingerprint.clone(),
                    &sessions[*member].root_key,
                    &view,
                    None,
                );
                results[sessions[*member].request_index] = Some(view);
            }
            continue;
        }
        match persist_refreshed_session(
            &sessions[*member].data_root,
            &sessions[*member].fingerprint,
            &updated,
            key,
        ) {
            Ok(fingerprint) => {
                sessions[*member].credentials = updated;
                sessions[*member].fingerprint = fingerprint;
                sessions[*member].sync_quarantined = false;
                synchronized += 1;
            }
            Err(()) => {
                let view = Sv2AccountProbeView::sync_failed(
                    "账号 authority 已更新，但该物理副本在同步前发生变化；为避免继续使用旧 refresh token，本次不用于自动启动。",
                )
                .with_account_identity(sessions[*member].credentials.access_token());
                set_sync_quarantine(&sessions[*member].quarantine_key, &view);
                sessions[*member].sync_quarantined = true;
                cache_put(
                    sessions[*member].fingerprint.clone(),
                    &sessions[*member].root_key,
                    &view,
                    None,
                );
                results[sessions[*member].request_index] = Some(view);
            }
        }
    }
    synchronized
}

#[cfg(windows)]
fn quarantine_repair_complete(
    requests: &[Sv2AccountProbeRequest<'_>],
    results: &[Option<Sv2AccountProbeView>],
    sessions: &[BatchSession],
    quarantine_key: &SyncQuarantineKey,
) -> bool {
    // Every requested physical environment covered by the slot must have made
    // it into the coherent group. Missing, active, unreadable, mismatched or
    // failed siblings intentionally keep the slot-level marker in place.
    let all_requests_repaired = requests.iter().enumerate().all(|(index, request)| {
        let request_key =
            probe_root_key_for_identity(request.data_root, request.quarantine_identity())
                .map(|root| root.quarantine_key());
        request_key.as_ref() != Some(quarantine_key) || results[index].is_none()
    });
    let all_sessions_repaired = sessions.iter().all(|session| {
        &session.quarantine_key != quarantine_key
            || (!session.sync_quarantined && results[session.request_index].is_none())
    });
    all_requests_repaired && all_sessions_repaired
}

#[cfg(windows)]
fn all_slot_requests_loaded(
    requests: &[Sv2AccountProbeRequest<'_>],
    results: &[Option<Sv2AccountProbeView>],
    quarantine_key: &SyncQuarantineKey,
) -> bool {
    requests.iter().enumerate().all(|(index, request)| {
        let request_key =
            probe_root_key_for_identity(request.data_root, request.quarantine_identity())
                .map(|root| root.quarantine_key());
        request_key.as_ref() != Some(quarantine_key) || results[index].is_none()
    })
}

#[cfg(windows)]
fn verify_synchronized_account_copies(
    sessions: &mut [BatchSession],
    members: &[usize],
    authority: usize,
    identity: Option<(&str, &str)>,
    key: &[u8; 8],
) -> Result<(), ()> {
    let expected_token_core =
        Zeroizing::new(sessions[authority].credentials.token_core().to_string());
    let expected_account = account_group_key(sessions[authority].credentials.access_token());
    let mut verified = Vec::with_capacity(members.len());
    for member in members {
        let Some((ciphertext, fingerprint)) = read_stable_session(&sessions[*member].data_root)?
        else {
            return Err(());
        };
        let credentials = decrypt_session(ciphertext, key).and_then(parse_session_plaintext)?;
        if credentials.token_core() != expected_token_core.as_str()
            || account_group_key(credentials.access_token()) != expected_account
        {
            return Err(());
        }
        if let Some((device_id, user_id)) = identity {
            if credentials.device_id() != Some(device_id)
                || (credentials.has_full_cache() && credentials.user_id() != Some(user_id))
            {
                return Err(());
            }
        }
        verified.push((*member, fingerprint, credentials));
    }
    for (member, fingerprint, credentials) in verified {
        sessions[member].fingerprint = fingerprint;
        sessions[member].credentials = credentials;
        sessions[member].sync_quarantined = false;
    }
    Ok(())
}

#[cfg(windows)]
fn finish_batch_results(
    requests: &[Sv2AccountProbeRequest<'_>],
    mut results: Vec<Option<Sv2AccountProbeView>>,
) -> Vec<Sv2AccountProbeView> {
    // No error or placeholder may downgrade an existing root quarantine. This
    // final overlay also covers stable-read, machine-key and decrypt failures,
    // plus an explicitly rejected refresh of a previously quarantined root.
    for (request_index, request) in requests.iter().enumerate() {
        let Some(root) =
            probe_root_key_for_identity(request.data_root, request.quarantine_identity())
        else {
            continue;
        };
        if matches!(
            results[request_index]
                .as_ref()
                .map(|view| view.session_status),
            Some(
                Sv2SessionInspectionStatus::Missing
                    | Sv2SessionInspectionStatus::InUse
                    | Sv2SessionInspectionStatus::AccountMismatch
            )
        ) {
            continue;
        }
        if let Some(view) = sync_quarantine_get(&root.quarantine_key()) {
            results[request_index] = Some(view);
        }
    }
    results
        .into_iter()
        .map(|view| view.unwrap_or_else(Sv2AccountProbeView::invalid))
        .collect()
}

#[cfg(windows)]
fn apply_equivalent_session_aliases(
    results: &mut [Option<Sv2AccountProbeView>],
    aliases: &[Option<EquivalentSessionAlias>],
) {
    for (request_index, alias) in aliases.iter().enumerate() {
        let Some(alias) = alias else {
            continue;
        };
        let view = results[alias.leader_request_index]
            .clone()
            .unwrap_or_else(Sv2AccountProbeView::invalid);
        cache_put(alias.fingerprint.clone(), &alias.root_key, &view, None);
        results[request_index] = Some(view);
    }
}

#[cfg(windows)]
fn refresh_windows_batch(requests: &[Sv2AccountProbeRequest<'_>]) -> Vec<Sv2AccountProbeView> {
    let mut results = vec![None; requests.len()];
    let mut equivalent_session_aliases = (0..requests.len()).map(|_| None).collect::<Vec<_>>();
    let mut pending = Vec::<PendingBatchSession>::new();
    let blocked_account_scopes = requests
        .iter()
        .filter(|request| request.source_in_use)
        .filter_map(|request| request.account_scope)
        .collect::<HashSet<_>>();

    // Take stable snapshots of every idle root before any refresh can rotate a
    // credential. If either physical environment of an account slot is active,
    // the whole slot is excluded: rotating only the idle sibling would leave
    // the running client with an obsolete refresh token.
    for (request_index, request) in requests.iter().enumerate() {
        if request.source_in_use
            || request
                .account_scope
                .is_some_and(|scope| blocked_account_scopes.contains(&scope))
        {
            results[request_index] = Some(inspect_active_session_license(
                request.data_root,
                request.quarantine_identity(),
            ));
            continue;
        }
        match read_stable_session(request.data_root) {
            Ok(Some((ciphertext, fingerprint))) => {
                let root_key =
                    probe_root_key(request.quarantine_identity(), &fingerprint.canonical_root);
                if let Some(leader) = pending.iter().find(|pending| {
                    is_equivalent_session_root(
                        request.account_scope,
                        &fingerprint.canonical_root,
                        pending.account_scope,
                        &pending.fingerprint.canonical_root,
                    )
                }) {
                    equivalent_session_aliases[request_index] = Some(EquivalentSessionAlias {
                        leader_request_index: leader.request_index,
                        fingerprint,
                        root_key,
                    });
                    continue;
                }
                pending.push(PendingBatchSession {
                    request_index,
                    data_root: request.data_root.to_path_buf(),
                    ciphertext,
                    fingerprint,
                    root_key,
                    account_scope: request.account_scope,
                    preferred_source: request.preferred_source,
                });
            }
            Ok(None) => {
                results[request_index] = Some(Sv2AccountProbeView::not_checked(false));
            }
            Err(()) => {
                results[request_index] = Some(Sv2AccountProbeView::invalid());
            }
        }
    }

    if pending.is_empty() {
        return finish_batch_results(requests, results);
    }

    let key = match read_machine_key() {
        Ok(value) => value,
        Err(()) => {
            let view = Sv2AccountProbeView::unsupported();
            for session in pending {
                cache_put(session.fingerprint, &session.root_key, &view, None);
                results[session.request_index] = Some(view.clone());
            }
            apply_equivalent_session_aliases(&mut results, &equivalent_session_aliases);
            return finish_batch_results(requests, results);
        }
    };

    let mut sessions = Vec::with_capacity(pending.len());
    for session in pending {
        let credentials =
            decrypt_session(session.ciphertext, &key).and_then(parse_session_plaintext);
        let credentials = match credentials {
            Ok(value) => value,
            Err(()) => {
                let view = Sv2AccountProbeView::invalid();
                cache_put(session.fingerprint, &session.root_key, &view, None);
                results[session.request_index] = Some(view);
                continue;
            }
        };
        let group = match (
            session.account_scope,
            account_group_key(credentials.access_token()),
        ) {
            (Some(account_scope), Some(subject)) => BatchGroupKey::Account(account_scope, subject),
            _ => BatchGroupKey::Singleton(session.request_index),
        };
        let quarantine_key = session.root_key.quarantine_key();
        let sync_quarantined = sync_quarantine_get(&quarantine_key).is_some();
        sessions.push(BatchSession {
            request_index: session.request_index,
            data_root: session.data_root,
            fingerprint: session.fingerprint,
            root_key: session.root_key,
            quarantine_key,
            credentials,
            group,
            account_scope: session.account_scope,
            preferred_source: session.preferred_source,
            sync_quarantined,
        });
    }

    // One slot has one account authority. Prefer its ordinary root when it can
    // be inspected; a prepared copy with a different subject is quarantined
    // instead of receiving its own refresh/enroll sequence or being overwritten.
    let plan = plan_batch_sessions(&sessions);
    for member in plan.invalid_scope_members {
        let view = Sv2AccountProbeView::new(
            Sv2SessionInspectionStatus::Invalid,
            Sv2RemoteUseStatus::Unknown,
            Sv2AuthorizationStatus::Unknown,
            Vec::new(),
            "账号预检收到多个普通 authority 来源；为避免跨根同步，本槽位未访问账号服务。",
        )
        .with_account_identity(sessions[member].credentials.access_token());
        cache_put(
            sessions[member].fingerprint.clone(),
            &sessions[member].root_key,
            &view,
            None,
        );
        results[sessions[member].request_index] = Some(view);
    }
    for member in plan.mismatches {
        let view = Sv2AccountProbeView::account_mismatch()
            .with_account_identity(sessions[member].credentials.access_token());
        cache_put(
            sessions[member].fingerprint.clone(),
            &sessions[member].root_key,
            &view,
            None,
        );
        results[sessions[member].request_index] = Some(view);
    }
    let groups = plan.groups;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(5))
        .redirects(0)
        .build();

    for members in groups.into_values() {
        let group_quarantine_key = sessions[members[0]].quarantine_key.clone();
        let repairing_quarantine = sync_quarantine_get(&group_quarantine_key).is_some();
        if !all_slot_requests_loaded(requests, &results, &group_quarantine_key) {
            let view = Sv2AccountProbeView::sync_failed(
                "同一账号槽位仍有缺失、活动、无效或账号不一致的会话副本；为避免只刷新其中一份，本槽位未访问官方账号服务。",
            )
            .with_account_identity(sessions[members[0]].credentials.access_token());
            quarantine_group_view(&mut results, &mut sessions, &members, &view);
            continue;
        }
        let preferred_safe_authority = choose_authority(
            members
                .iter()
                .filter(|index| !sessions[**index].sync_quarantined)
                .map(|index| {
                    (
                        *index,
                        &sessions[*index].credentials,
                        sessions[*index].preferred_source,
                    )
                }),
        );
        let Some(mut authority) = preferred_safe_authority.or_else(|| {
            choose_authority(members.iter().map(|index| {
                (
                    *index,
                    &sessions[*index].credentials,
                    sessions[*index].preferred_source,
                )
            }))
        }) else {
            continue;
        };

        if sessions[authority].credentials.access_expires_at
            > Utc::now() + ChronoDuration::seconds(60)
        {
            let one_physical_session = members.iter().all(|member| {
                sessions[*member].fingerprint.canonical_root
                    == sessions[authority].fingerprint.canonical_root
            });
            if !one_physical_session {
                let view = Sv2AccountProbeView::sync_failed(
                    "同一槽位请求指向多个物理会话；未接受只读授权结果或清除同步隔离。",
                )
                .with_account_identity(sessions[authority].credentials.access_token());
                quarantine_group_view(&mut results, &mut sessions, &members, &view);
                continue;
            }
            let Some(view) = read_only_authorization(
                &sessions[authority].data_root,
                &sessions[authority].root_key,
                &sessions[authority].fingerprint,
                &sessions[authority].credentials,
                false,
                |access| query_license_snapshot_with_agent(&agent, access),
            ) else {
                results[sessions[authority].request_index] = Some(Sv2AccountProbeView::in_use());
                continue;
            };
            if view.session_status != Sv2SessionInspectionStatus::Invalid {
                cache_group_view(
                    &mut results,
                    &sessions,
                    &members,
                    &view,
                    Some(sessions[authority].credentials.access_expires_at),
                );
                continue;
            }
        }

        // Only the newest physical copy for an account may consume a refresh
        // token. Normal and Sandboxie copies therefore cannot race each other
        // or submit two startup-equivalent login events merely because their
        // Keycloak login ids drifted.
        {
            let refreshed =
                match refresh_session_credentials(&agent, &sessions[authority].credentials) {
                    Ok(value) => value,
                    Err(failure) => {
                        let view = refresh_failure_view(failure)
                            .with_account_identity(sessions[authority].credentials.access_token());
                        if matches!(failure, RefreshFailure::Ambiguous) {
                            quarantine_group_view(&mut results, &mut sessions, &members, &view);
                        } else {
                            cache_group_view(&mut results, &sessions, &members, &view, None);
                        }
                        continue;
                    }
                };
            if let BatchGroupKey::Account(_, expected_group) = sessions[authority].group {
                if account_group_key(refreshed.access_token()) != Some(expected_group) {
                    let view = Sv2AccountProbeView::sync_failed(
                        "官方刷新响应的账号主体与槽位 authority 不一致；为避免传播错误或已轮换的凭据，本组等待重新登录。",
                    )
                    .with_account_identity(sessions[authority].credentials.access_token());
                    quarantine_group_view(&mut results, &mut sessions, &members, &view);
                    continue;
                }
            }

            // Preserve the rotated credential in every stable sibling before
            // replacing the authority. If the authority CAS then fails, a
            // successfully updated sibling becomes the in-memory authority and
            // the changed root stays quarantined until an explicit repair.
            let refreshed_token_core = Zeroizing::new(refreshed.token_core().to_string());
            synchronize_account_copies(
                &mut sessions,
                &members,
                authority,
                &mut results,
                &refreshed_token_core,
                None,
                &key,
            );
            drop(refreshed_token_core);
            match persist_refreshed_session(
                &sessions[authority].data_root,
                &sessions[authority].fingerprint,
                &refreshed,
                &key,
            ) {
                Ok(fingerprint) => {
                    sessions[authority].credentials = refreshed;
                    sessions[authority].fingerprint = fingerprint;
                    sessions[authority].sync_quarantined = false;
                }
                Err(()) => {
                    let failed_authority = authority;
                    let failed_fingerprint = sessions[failed_authority].fingerprint.clone();
                    sessions[failed_authority].credentials = refreshed;
                    let view = Sv2AccountProbeView::sync_failed(
                        "JWT 刷新已完成，但最新会话无法安全原子写回；为避免 rotation 状态分叉，本组不再登录。",
                    )
                    .with_account_identity(
                        sessions[failed_authority].credentials.access_token(),
                    );
                    set_sync_quarantine(&sessions[failed_authority].quarantine_key, &view);
                    sessions[failed_authority].sync_quarantined = true;
                    cache_put(
                        failed_fingerprint,
                        &sessions[failed_authority].root_key,
                        &view,
                        None,
                    );
                    results[sessions[failed_authority].request_index] = Some(view);
                    let fallback = members.iter().copied().find(|member| {
                        *member != failed_authority
                            && results[sessions[*member].request_index].is_none()
                            && sessions[*member].credentials.token_core()
                                == sessions[failed_authority].credentials.token_core()
                    });
                    let Some(fallback) = fallback else {
                        continue;
                    };
                    authority = fallback;
                }
            }
        }

        // Converge every idle physical copy before any further network wait.
        // This minimizes the crash window after refresh-token rotation and also
        // collapses older, still-valid Keycloak login ids to the one authority.
        let authority_token_core =
            Zeroizing::new(sessions[authority].credentials.token_core().to_string());
        synchronize_account_copies(
            &mut sessions,
            &members,
            authority,
            &mut results,
            &authority_token_core,
            None,
            &key,
        );
        drop(authority_token_core);

        // The side-effectful startup-equivalent checks run once per account,
        // never once per physical environment copy.
        let enrollment = query_enrollment(
            &agent,
            sessions[authority].credentials.access_token(),
            sessions[authority].credentials.device_id(),
        );
        let mut authority_identity_write_failed = false;
        if let Some(identity) = enrollment.identity.as_ref() {
            let should_persist = sessions[authority].credentials.device_id()
                != Some(identity.device_id.as_str())
                || (sessions[authority].credentials.has_full_cache()
                    && sessions[authority].credentials.user_id()
                        != Some(identity.user_id.as_str()));
            if should_persist {
                match sessions[authority]
                    .credentials
                    .with_enrollment_identity(&identity.device_id, &identity.user_id)
                {
                    Ok(updated) => match persist_refreshed_session(
                        &sessions[authority].data_root,
                        &sessions[authority].fingerprint,
                        &updated,
                        &key,
                    ) {
                        Ok(fingerprint) => {
                            sessions[authority].credentials = updated;
                            sessions[authority].fingerprint = fingerprint;
                        }
                        Err(()) => authority_identity_write_failed = true,
                    },
                    Err(()) => authority_identity_write_failed = true,
                }
            }
        }

        if authority_identity_write_failed {
            let view = Sv2AccountProbeView::sync_failed(
                "官方服务已接受登录事件，但最新副本的设备身份无法安全写回；为避免覆盖或传播旧状态，本组不再同步。",
            )
            .with_account_identity(sessions[authority].credentials.access_token());
            quarantine_group_view(&mut results, &mut sessions, &members, &view);
            continue;
        }

        let licenses = query_license_snapshot_with_agent(
            &agent,
            sessions[authority].credentials.access_token(),
        );
        let group_view = view_from_remote(licenses, enrollment.outcome)
            .with_account_identity(sessions[authority].credentials.access_token());
        let identity = enrollment
            .identity
            .as_ref()
            .map(|value| (value.device_id.as_str(), value.user_id.as_str()));

        if identity.is_some() {
            let authority_token_core =
                Zeroizing::new(sessions[authority].credentials.token_core().to_string());
            synchronize_account_copies(
                &mut sessions,
                &members,
                authority,
                &mut results,
                &authority_token_core,
                identity,
                &key,
            );
        }

        if !quarantine_repair_complete(requests, &results, &sessions, &group_quarantine_key)
            || verify_synchronized_account_copies(
                &mut sessions,
                &members,
                authority,
                identity,
                &key,
            )
            .is_err()
        {
            let view = Sv2AccountProbeView::sync_failed(
                "普通/隔离会话写回后未能重新解密并核对为同一账号 authority；本槽位保持隔离，不用于自动启动。",
            )
            .with_account_identity(sessions[authority].credentials.access_token());
            quarantine_group_view(&mut results, &mut sessions, &members, &view);
            continue;
        }
        if repairing_quarantine {
            clear_sync_quarantine(&group_quarantine_key);
        }

        for member in &members {
            let session = &sessions[*member];
            if results[session.request_index].is_none() {
                cache_put(
                    session.fingerprint.clone(),
                    &session.root_key,
                    &group_view,
                    Some(session.credentials.access_expires_at),
                );
                results[session.request_index] = Some(group_view.clone());
            }
        }
    }

    drop(key);
    apply_equivalent_session_aliases(&mut results, &equivalent_session_aliases);
    finish_batch_results(requests, results)
}

#[cfg(windows)]
fn query_license_snapshot_with_agent(agent: &ureq::Agent, access_token: &str) -> RemoteOutcome {
    let mut authorization = Zeroizing::new(String::with_capacity(7 + access_token.len()));
    authorization.push_str("Bearer ");
    authorization.push_str(access_token);

    let request = agent
        .get(LICENSES_URL)
        .set("Accept", "application/json")
        .set("User-Agent", "SynthV-Toolbox/account-precheck")
        .set("Authorization", &authorization);
    let response = request.call();
    drop(authorization);

    let (status, response) = match response {
        Ok(response) => (response.status(), response),
        Err(ureq::Error::Status(status, response)) => (status, response),
        Err(ureq::Error::Transport(_)) => return RemoteOutcome::Offline,
    };
    let body = match read_bounded_response(response) {
        Ok(body) => body,
        Err(ResponseReadFailure::Transport) => return RemoteOutcome::Offline,
        Err(ResponseReadFailure::TooLarge) => return RemoteOutcome::Unknown,
    };
    interpret_license_response(status, body)
}

#[cfg(windows)]
struct EnrollIdentity {
    device_id: Zeroizing<String>,
    user_id: Zeroizing<String>,
}

#[cfg(windows)]
struct EnrollCheck {
    outcome: EnrollOutcome,
    identity: Option<EnrollIdentity>,
}

#[cfg(windows)]
enum EnrollAttempt {
    Checked(EnrollCheck),
    DeviceNotFound,
}

#[cfg(windows)]
#[derive(Serialize)]
struct EnrollRequest<'a> {
    payload: EnrollPayload<'a>,
}

#[cfg(windows)]
#[derive(Serialize)]
struct EnrollPayload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<&'a str>,
    device_hash: &'a str,
    editor_version: u32,
    device_name: &'a str,
    kickout_other_sessions: bool,
}

#[cfg(windows)]
#[derive(Deserialize)]
struct EnrollResponse<'a> {
    #[serde(default, borrow)]
    data: Option<EnrollResponseData<'a>>,
    #[serde(default, borrow)]
    error: Option<EnrollResponseError<'a>>,
}

#[cfg(windows)]
#[derive(Deserialize)]
struct EnrollResponseData<'a> {
    #[serde(default)]
    status: Option<&'a str>,
    #[serde(default)]
    device_id: Option<&'a str>,
    #[serde(default)]
    user_id: Option<&'a str>,
}

#[cfg(windows)]
#[derive(Deserialize)]
struct EnrollResponseError<'a> {
    #[serde(default)]
    code: Option<&'a str>,
}

#[cfg(windows)]
fn query_enrollment(
    agent: &ureq::Agent,
    access_token: &str,
    existing_device_id: Option<&str>,
) -> EnrollCheck {
    let first = query_enrollment_once(agent, access_token, existing_device_id);
    match first {
        EnrollAttempt::DeviceNotFound if existing_device_id.is_some() => {
            match query_enrollment_once(agent, access_token, None) {
                EnrollAttempt::Checked(result) => result,
                EnrollAttempt::DeviceNotFound => EnrollCheck {
                    outcome: EnrollOutcome::Unknown,
                    identity: None,
                },
            }
        }
        EnrollAttempt::DeviceNotFound => EnrollCheck {
            outcome: EnrollOutcome::Unknown,
            identity: None,
        },
        EnrollAttempt::Checked(result) => result,
    }
}

#[cfg(windows)]
fn query_enrollment_once(
    agent: &ureq::Agent,
    access_token: &str,
    existing_device_id: Option<&str>,
) -> EnrollAttempt {
    let device_hash = match existing_device_id {
        Some(_) => Zeroizing::new(String::new()),
        None => match sv2_device_hash() {
            Ok(value) => value,
            Err(()) => {
                return EnrollAttempt::Checked(EnrollCheck {
                    outcome: EnrollOutcome::Unknown,
                    identity: None,
                })
            }
        },
    };
    let device_name = match physical_dns_hostname() {
        Ok(value) => value,
        Err(()) => {
            return EnrollAttempt::Checked(EnrollCheck {
                outcome: EnrollOutcome::Unknown,
                identity: None,
            })
        }
    };
    let request = EnrollRequest {
        payload: EnrollPayload {
            device_id: existing_device_id,
            device_hash: &device_hash,
            editor_version: EDITOR_VERSION,
            device_name: &device_name,
            kickout_other_sessions: false,
        },
    };
    let body = match serde_json::to_string(&request) {
        Ok(value) if value.len() <= 4096 => Zeroizing::new(value),
        _ => {
            return EnrollAttempt::Checked(EnrollCheck {
                outcome: EnrollOutcome::Unknown,
                identity: None,
            })
        }
    };
    let mut authorization = Zeroizing::new(String::with_capacity(7 + access_token.len()));
    authorization.push_str("Bearer ");
    authorization.push_str(access_token);
    let response = agent
        .post(ENROLL_URL)
        .set("Authorization", &authorization)
        .set("Content-Type", "application/json")
        .send_string(&body);
    drop(authorization);
    drop(body);
    drop(device_name);
    drop(device_hash);

    let (status, response) = match response {
        Ok(response) => (response.status(), response),
        Err(ureq::Error::Status(status, response)) => (status, response),
        Err(ureq::Error::Transport(_)) => {
            return EnrollAttempt::Checked(EnrollCheck {
                outcome: EnrollOutcome::Offline,
                identity: None,
            })
        }
    };
    let response_body = match read_bounded_response(response) {
        Ok(body) => body,
        Err(ResponseReadFailure::Transport) => {
            return EnrollAttempt::Checked(EnrollCheck {
                outcome: EnrollOutcome::Offline,
                identity: None,
            })
        }
        Err(ResponseReadFailure::TooLarge) => {
            return EnrollAttempt::Checked(EnrollCheck {
                outcome: EnrollOutcome::Unknown,
                identity: None,
            })
        }
    };
    interpret_enrollment_response(status, response_body, existing_device_id)
}

#[cfg(windows)]
fn interpret_enrollment_response(
    status: u16,
    response_body: Zeroizing<Vec<u8>>,
    existing_device_id: Option<&str>,
) -> EnrollAttempt {
    let parsed: EnrollResponse<'_> = match serde_json::from_slice(&response_body) {
        Ok(value) => value,
        Err(_) => {
            return EnrollAttempt::Checked(EnrollCheck {
                outcome: EnrollOutcome::Unknown,
                identity: None,
            })
        }
    };
    let data_status = parsed.data.as_ref().and_then(|data| data.status);
    let error_code = parsed.error.as_ref().and_then(|error| error.code);
    if code_matches(data_status, KICKOUT_ERROR)
        || code_matches(error_code, KICKOUT_ERROR)
        || code_matches(error_code, CONCURRENT_ERROR)
    {
        return EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::ConcurrentUse,
            identity: None,
        });
    }
    if error_code == Some("device-not-found") {
        return EnrollAttempt::DeviceNotFound;
    }
    if code_matches(error_code, RELOGIN_ERROR) || matches!(status, 401 | 403) {
        return EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::Unauthorized,
            identity: None,
        });
    }
    if status != 200 {
        return EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::Unknown,
            identity: None,
        });
    }
    let Some(data) = parsed.data else {
        return EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::Unknown,
            identity: None,
        });
    };
    let Some(device_id) = data.device_id.or(existing_device_id) else {
        return EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::Unknown,
            identity: None,
        });
    };
    let Some(user_id) = data.user_id else {
        return EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::Unknown,
            identity: None,
        });
    };
    if !valid_enrollment_id(device_id) || !valid_enrollment_id(user_id) {
        return EnrollAttempt::Checked(EnrollCheck {
            outcome: EnrollOutcome::Unknown,
            identity: None,
        });
    }
    EnrollAttempt::Checked(EnrollCheck {
        outcome: EnrollOutcome::Clear,
        identity: Some(EnrollIdentity {
            device_id: Zeroizing::new(device_id.to_string()),
            user_id: Zeroizing::new(user_id.to_string()),
        }),
    })
}

#[cfg(windows)]
fn code_matches(value: Option<&str>, expected: &[u8]) -> bool {
    value.is_some_and(|value| value.as_bytes() == expected)
}

#[cfg(windows)]
fn valid_enrollment_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

#[cfg(windows)]
enum ResponseReadFailure {
    Transport,
    TooLarge,
}

#[cfg(windows)]
fn read_bounded_response(
    response: ureq::Response,
) -> Result<Zeroizing<Vec<u8>>, ResponseReadFailure> {
    if response
        .header("Content-Length")
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(ResponseReadFailure::TooLarge);
    }
    let mut body = Zeroizing::new(Vec::new());
    response
        .into_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| ResponseReadFailure::Transport)?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(ResponseReadFailure::TooLarge);
    }
    Ok(body)
}

#[cfg(windows)]
fn read_machine_key() -> Result<Zeroizing<[u8; 8]>, ()> {
    // Multi-character constants in JUCE/MSVC have the first character in the
    // most-significant byte.
    const PROVIDER_RSMB: u32 = u32::from_be_bytes(*b"RSMB");
    const TABLE_RSDT: u32 = u32::from_be_bytes(*b"RSDT");

    let required =
        unsafe { GetSystemFirmwareTable(PROVIDER_RSMB, TABLE_RSDT, std::ptr::null_mut(), 0) }
            as usize;
    if !(8..=MAX_FIRMWARE_BYTES).contains(&required) {
        return Err(());
    }
    let mut raw = Zeroizing::new(vec![0u8; required]);
    let received = unsafe {
        GetSystemFirmwareTable(
            PROVIDER_RSMB,
            TABLE_RSDT,
            raw.as_mut_ptr(),
            u32::try_from(raw.len()).map_err(|_| ())?,
        )
    } as usize;
    if received < 8 || received > raw.len() {
        return Err(());
    }
    raw[received..].zeroize();
    raw.truncate(received);
    derive_machine_key_from_raw_smbios(&raw)
}

#[cfg(windows)]
struct OwnedHandle(HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(windows)]
fn current_user_sid_hash() -> Result<u32, ()> {
    let mut raw_token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0
        || raw_token.is_null()
    {
        return Err(());
    }
    let token = OwnedHandle(raw_token);
    let mut required = 0u32;
    unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut required) };
    if required < std::mem::size_of::<TOKEN_USER>() as u32 || required > 64 * 1024 {
        return Err(());
    }
    let word_size = std::mem::size_of::<usize>();
    let words = (required as usize).div_ceil(word_size);
    let mut information = Zeroizing::new(vec![0usize; words]);
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            information.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(());
    }
    let user = unsafe { &*(information.as_ptr().cast::<TOKEN_USER>()) };
    if user.User.Sid.is_null() {
        return Err(());
    }
    let mut sid_text: *mut u16 = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid_text) } == 0 || sid_text.is_null() {
        return Err(());
    }
    let Some(length) = (0..256usize).find(|index| unsafe { *sid_text.add(*index) } == 0) else {
        unsafe { LocalFree(sid_text.cast()) };
        return Err(());
    };
    let bytes = unsafe { std::slice::from_raw_parts(sid_text.cast::<u8>(), length * 2) };
    let hash = xxh32(bytes, 6);
    unsafe { LocalFree(sid_text.cast()) };
    Ok(hash)
}

#[cfg(windows)]
#[allow(unused_unsafe)]
fn processor_signature() -> u32 {
    #[cfg(target_arch = "x86_64")]
    {
        let maximum = unsafe { std::arch::x86_64::__cpuid(0) }.eax;
        return if maximum >= 1 {
            unsafe { std::arch::x86_64::__cpuid(1) }.eax
        } else {
            0
        };
    }
    #[cfg(target_arch = "x86")]
    {
        let maximum = unsafe { std::arch::x86::__cpuid(0) }.eax;
        return if maximum >= 1 {
            unsafe { std::arch::x86::__cpuid(1) }.eax
        } else {
            0
        };
    }
    #[allow(unreachable_code)]
    0
}

#[cfg(windows)]
fn sv2_device_hash() -> Result<Zeroizing<String>, ()> {
    Ok(Zeroizing::new(format!(
        "{:08x}{:08x}",
        current_user_sid_hash()?,
        processor_signature()
    )))
}

#[cfg(windows)]
fn physical_dns_hostname() -> Result<Zeroizing<String>, ()> {
    let mut required = 0u32;
    unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            std::ptr::null_mut(),
            &mut required,
        )
    };
    if required == 0 || required > 256 {
        return Err(());
    }
    let mut wide = Zeroizing::new(vec![0u16; required as usize + 1]);
    let mut length = required;
    if unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            wide.as_mut_ptr(),
            &mut length,
        )
    } == 0
        || length == 0
        || length as usize > wide.len()
    {
        return Err(());
    }
    let value = String::from_utf16(&wide[..length as usize]).map_err(|_| ())?;
    if value.chars().any(char::is_control) {
        return Err(());
    }
    Ok(Zeroizing::new(value))
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileSignature {
    attributes: u32,
    len: u64,
    last_write_time: u64,
}

#[cfg(windows)]
fn signature(metadata: &Metadata) -> FileSignature {
    FileSignature {
        attributes: metadata.file_attributes(),
        len: metadata.len(),
        last_write_time: metadata.last_write_time(),
    }
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<(u32, u64), ()> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) } != 0;
    if !succeeded {
        return Err(());
    }
    let index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok((information.dwVolumeSerialNumber, index))
}

#[cfg(windows)]
fn has_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn validate_session_hierarchy(data_root: &Path) -> Result<Option<(PathBuf, Metadata)>, ()> {
    let root_metadata = match fs::symlink_metadata(data_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if has_reparse_point(&root_metadata) || !root_metadata.is_dir() {
        return Err(());
    }
    let license = data_root.join("license");
    let license_metadata = match fs::symlink_metadata(&license) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if has_reparse_point(&license_metadata) || !license_metadata.is_dir() {
        return Err(());
    }
    let session = license.join("session");
    let session_metadata = match fs::symlink_metadata(&session) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if has_reparse_point(&session_metadata) || !session_metadata.is_file() {
        return Err(());
    }
    if session_metadata.len() == 0
        || session_metadata.len() > MAX_SESSION_BYTES as u64
        || session_metadata.len() % 8 != 0
    {
        return Err(());
    }
    Ok(Some((session, session_metadata)))
}

#[cfg(windows)]
fn inspect_session_fingerprint(data_root: &Path) -> Result<Option<SessionCacheKey>, ()> {
    for _ in 0..2 {
        let Some((_, before)) = validate_session_hierarchy(data_root)? else {
            return Ok(None);
        };
        let canonical_root = fs::canonicalize(data_root).map_err(|_| ())?;
        let Some((_, after)) = validate_session_hierarchy(data_root)? else {
            continue;
        };
        if signature(&before) == signature(&after) {
            return Ok(Some(SessionCacheKey {
                canonical_root,
                session_len: after.len(),
                last_write_time: after.last_write_time(),
            }));
        }
    }
    Err(())
}

#[cfg(windows)]
fn read_stable_session(data_root: &Path) -> Result<Option<StableSessionSnapshot>, ()> {
    for _ in 0..2 {
        let Some((session_path, path_before)) = validate_session_hierarchy(data_root)? else {
            return Ok(None);
        };
        let canonical_root = fs::canonicalize(data_root).map_err(|_| ())?;
        let attempt =
            read_stable_session_once(data_root, &session_path, &path_before, canonical_root);
        match attempt {
            StableRead::Ready(bytes, key) => return Ok(Some((bytes, key))),
            StableRead::Missing => return Ok(None),
            StableRead::Unsafe => return Err(()),
            StableRead::Changed => continue,
        }
    }
    Err(())
}

#[cfg(windows)]
enum StableRead {
    Ready(Zeroizing<Vec<u8>>, SessionCacheKey),
    Missing,
    Unsafe,
    Changed,
}

#[cfg(windows)]
fn read_stable_session_once(
    data_root: &Path,
    session_path: &Path,
    path_before: &Metadata,
    canonical_root: PathBuf,
) -> StableRead {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let mut file = match options.open(session_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return StableRead::Missing,
        Err(_) => return StableRead::Unsafe,
    };
    let handle_before = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return StableRead::Unsafe,
    };
    let identity_before = match file_identity(&file) {
        Ok(identity) => identity,
        Err(()) => return StableRead::Unsafe,
    };
    if has_reparse_point(&handle_before)
        || !handle_before.is_file()
        || signature(&handle_before) != signature(path_before)
    {
        return StableRead::Changed;
    }
    let expected_len = handle_before.len() as usize;
    if expected_len == 0 || expected_len > MAX_SESSION_BYTES || !expected_len.is_multiple_of(8) {
        return StableRead::Unsafe;
    }

    let mut bytes = Zeroizing::new(Vec::with_capacity(expected_len));
    if std::io::Read::by_ref(&mut file)
        .take((expected_len + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return StableRead::Unsafe;
    }
    if bytes.len() != expected_len {
        return StableRead::Changed;
    }
    let handle_after = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return StableRead::Unsafe,
    };
    let Some((path_after_name, path_after)) = (match validate_session_hierarchy(data_root) {
        Ok(value) => value,
        Err(()) => return StableRead::Unsafe,
    }) else {
        return StableRead::Changed;
    };
    if path_after_name != session_path
        || signature(&handle_before) != signature(&handle_after)
        || signature(&handle_after) != signature(&path_after)
    {
        return StableRead::Changed;
    }
    let path_after_file = match options.open(session_path) {
        Ok(file) => file,
        Err(_) => return StableRead::Changed,
    };
    let identity_after = match file_identity(&path_after_file) {
        Ok(identity) => identity,
        Err(()) => return StableRead::Unsafe,
    };
    if identity_before != identity_after {
        return StableRead::Changed;
    }
    StableRead::Ready(
        bytes,
        SessionCacheKey {
            canonical_root,
            session_len: handle_after.len(),
            last_write_time: handle_after.last_write_time(),
        },
    )
}

#[cfg(windows)]
fn persist_refreshed_session(
    data_root: &Path,
    expected: &SessionCacheKey,
    credentials: &SessionCredentials,
    key: &[u8; 8],
) -> Result<SessionCacheKey, ()> {
    if inspect_session_fingerprint(data_root)?.as_ref() != Some(expected) {
        return Err(());
    }
    let Some((session_path, _)) = validate_session_hierarchy(data_root)? else {
        return Err(());
    };
    let license_dir = session_path.parent().ok_or(())?;
    if license_dir.file_name().and_then(|value| value.to_str()) != Some("license") {
        return Err(());
    }

    let encrypted = encrypt_session(credentials.buffer.as_bytes(), key)?;
    let temporary = license_dir.join(format!(
        ".session.sv2-account-indicator.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let write_result = (|| -> Result<(), ()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).share_mode(0);
        let mut file = options.open(&temporary).map_err(|_| ())?;
        file.write_all(&encrypted).map_err(|_| ())?;
        file.flush().map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        drop(file);

        if inspect_session_fingerprint(data_root)?.as_ref() != Some(expected) {
            return Err(());
        }
        let replaced = session_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let replacement = temporary
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if unsafe {
            ReplaceFileW(
                replaced.as_ptr(),
                replacement.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(());
        }
        Ok(())
    })();
    drop(encrypted);
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(());
    }
    inspect_session_fingerprint(data_root)?.ok_or(())
}

#[cfg(test)]
#[path = "../../../../test/sv2_account_probe_tests.rs"]
mod tests;
