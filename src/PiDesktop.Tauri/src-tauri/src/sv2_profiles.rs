use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::sv2_account_probe::{probe_sv2_identity, Sv2IdentityStatus, Sv2ProfileIdentityView};
#[cfg(windows)]
use crate::sv2_concurrent::concurrent_folder;
use crate::sv2_concurrent::{
    detect_provider as detect_concurrent_provider, launch_slot as launch_concurrent,
    prepare_slot as prepare_concurrent, provider_view as concurrent_provider_view,
    slot_view as concurrent_slot_view, Sv2ConcurrentContentPreferences, Sv2ConcurrentDefaults,
    Sv2ConcurrentProviderView, Sv2ConcurrentSlotView, Sv2IsolationPreference,
};
use crate::sv2_session_guard::{
    SessionLaunchPreparation, Sv2SessionEnvironment, Sv2SessionGuardStore, Sv2SessionProtectionView,
};
use crate::sv2_sync::{self, Sv2SyncCategory, Sv2SyncCategoryId, Sv2SyncManifest, Sv2SyncResult};
use crate::svp_launch_router::{
    build_route_plan, inspect_voice_inventory, Sv2VoiceInventoryView, SvpLaunchMode, SvpRoutePlan,
};
use crate::synthv::{find_sv2_executable, succeeded, OperationResult};

const SCHEMA_VERSION: u32 = 1;
const MARKER_FILE: &str = ".synthv-toolbox-slot.json";
#[cfg(windows)]
const MANIFEST_FILE: &str = "manifest.json";
#[cfg(windows)]
const JOURNAL_FILE: &str = "switch.journal.json";
#[cfg(windows)]
const LOCK_FILE: &str = "switch.lock";
const SLOT_COLORS: [&str; 6] = [
    "#6D5CE7", "#3478C9", "#2B956C", "#C67336", "#C05278", "#637083",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlotRecord {
    id: String,
    display_name: String,
    #[serde(default, rename = "username", skip_serializing)]
    legacy_username: Option<String>,
    #[serde(default, rename = "email", skip_serializing)]
    legacy_email: Option<String>,
    #[serde(default, rename = "manuallyConfirmedVoices", skip_serializing)]
    legacy_manually_confirmed_voices: Option<Vec<String>>,
    color: String,
    created_at_utc: String,
    #[serde(default)]
    last_activated_at_utc: Option<String>,
    #[serde(default)]
    concurrent_content: Sv2ConcurrentContentPreferences,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlotManifest {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    active_slot_id: Option<String>,
    #[serde(default)]
    slots: Vec<SlotRecord>,
    #[serde(default)]
    concurrent_defaults: Sv2ConcurrentDefaults,
}

impl Default for SlotManifest {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            active_slot_id: None,
            slots: Vec::new(),
            concurrent_defaults: Sv2ConcurrentDefaults::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlotMarker {
    schema_version: u32,
    slot_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SwitchPhase {
    Prepared,
    CurrentParked,
    TargetActivated,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchJournal {
    schema_version: u32,
    transaction_id: String,
    current_slot_id: Option<String>,
    target_slot_id: String,
    phase: SwitchPhase,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ProfileSlotView {
    pub id: String,
    pub display_name: String,
    pub identity: Sv2ProfileIdentityView,
    pub color: String,
    pub created_at_utc: String,
    pub last_activated_at_utc: Option<String>,
    pub is_active: bool,
    pub session_file_present: bool,
    pub data_path: String,
    pub session_protection: Sv2SessionProtectionView,
    pub concurrent_session_protection: Sv2SessionProtectionView,
    pub concurrent: Sv2ConcurrentSlotView,
    pub voice_inventory: Sv2VoiceInventoryView,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ProcessBlocker {
    pub pid: Option<u32>,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ProfilesState {
    pub supported: bool,
    pub canonical_path: String,
    pub vault_path: String,
    pub active_slot_id: Option<String>,
    pub canonical_root_exists: bool,
    pub can_import_current: bool,
    pub recovery_required: bool,
    pub recovery_detail: String,
    pub slots: Vec<Sv2ProfileSlotView>,
    pub blockers: Vec<Sv2ProcessBlocker>,
    pub concurrent_provider: Sv2ConcurrentProviderView,
    pub concurrent_defaults: Sv2ConcurrentDefaults,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2RemoteUseStatus {
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2AccountPrecheck {
    pub supported: bool,
    pub checked_at_utc: String,
    pub slot_id: Option<String>,
    pub display_name: String,
    pub local_use: bool,
    pub local_processes: Vec<Sv2ProcessBlocker>,
    pub concurrent_pids: Vec<u32>,
    pub remote_use: Sv2RemoteUseStatus,
    pub session_file_present: bool,
    pub recovery_pending: bool,
    pub summary: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2AccountUsageSnapshot {
    pub profiles: Sv2ProfilesState,
    pub precheck: Sv2AccountPrecheck,
}

#[derive(Debug, Clone)]
struct SlotPaths {
    canonical: PathBuf,
    vault: PathBuf,
    slots: PathBuf,
    metadata: PathBuf,
    manifest: PathBuf,
    journal: PathBuf,
    lock: PathBuf,
}

impl SlotPaths {
    fn from_environment() -> Result<Self, String> {
        #[cfg(not(windows))]
        return Err("SV2 账号槽位当前仅支持 Windows。".to_string());

        #[cfg(windows)]
        {
            let app_data = std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .ok_or_else(|| "Windows APPDATA 未定义。".to_string())?;
            let local_app_data = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .ok_or_else(|| "Windows LOCALAPPDATA 未定义。".to_string())?;
            let dreamtonics = app_data.join("Dreamtonics");
            let vault = dreamtonics.join("Synthesizer V Studio 2.toolbox-slots");
            let metadata = local_app_data.join("SynthVToolbox").join("sv2-slots");
            Ok(Self {
                canonical: dreamtonics.join("Synthesizer V Studio 2"),
                slots: vault.join("slots"),
                manifest: metadata.join(MANIFEST_FILE),
                journal: metadata.join(JOURNAL_FILE),
                lock: metadata.join(LOCK_FILE),
                vault,
                metadata,
            })
        }
    }

    #[cfg(all(test, windows))]
    fn for_test(root: &Path) -> Self {
        let dreamtonics = root.join("roaming").join("Dreamtonics");
        let vault = dreamtonics.join("Synthesizer V Studio 2.toolbox-slots");
        let metadata = root.join("local").join("SynthVToolbox").join("sv2-slots");
        Self {
            canonical: dreamtonics.join("Synthesizer V Studio 2"),
            slots: vault.join("slots"),
            manifest: metadata.join(MANIFEST_FILE),
            journal: metadata.join(JOURNAL_FILE),
            lock: metadata.join(LOCK_FILE),
            vault,
            metadata,
        }
    }

    fn parked(&self, slot_id: &str) -> PathBuf {
        self.slots.join(slot_id)
    }
}

pub struct Sv2ProfileService {
    paths: Result<SlotPaths, String>,
    gate: Mutex<()>,
}

impl Default for Sv2ProfileService {
    fn default() -> Self {
        Self::new()
    }
}

impl Sv2ProfileService {
    pub fn new() -> Self {
        Self {
            paths: SlotPaths::from_environment(),
            gate: Mutex::new(()),
        }
    }

    pub fn state(&self) -> Result<Sv2ProfilesState, String> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let Ok(paths) = &self.paths else {
            return Ok(unsupported_state(
                self.paths.as_ref().err().cloned().unwrap_or_default(),
            ));
        };
        let _file_lock = acquire_switch_lock(paths)?;
        let recovery = recover_if_needed(paths);
        let (manifest, recovery_required, recovery_detail) = match recovery {
            Ok(()) => match load_manifest(paths) {
                Ok(manifest) => (manifest, false, String::new()),
                Err(detail) => (SlotManifest::default(), true, detail),
            },
            Err(detail) => (load_manifest(paths).unwrap_or_default(), true, detail),
        };
        build_state(paths, &manifest, recovery_required, recovery_detail)
    }

    pub fn account_precheck(&self) -> Result<Sv2AccountPrecheck, String> {
        self.account_usage_snapshot()
            .map(|snapshot| snapshot.precheck)
    }

    pub fn account_usage_snapshot(&self) -> Result<Sv2AccountUsageSnapshot, String> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let Ok(paths) = &self.paths else {
            let detail = self.paths.as_ref().err().cloned().unwrap_or_default();
            return Ok(Sv2AccountUsageSnapshot {
                profiles: unsupported_state(detail.clone()),
                precheck: unsupported_precheck(detail),
            });
        };
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let manifest = load_manifest(paths)?;
        let profiles = build_state(paths, &manifest, false, String::new())?;
        let precheck = build_account_precheck(&profiles);
        Ok(Sv2AccountUsageSnapshot { profiles, precheck })
    }

    pub fn sync_categories(&self) -> Vec<Sv2SyncCategory> {
        sv2_sync::categories()
    }

    pub fn preview_selective_sync(
        &self,
        source_slot_id: String,
        target_slot_id: String,
        categories: Vec<Sv2SyncCategoryId>,
        overwrite: bool,
    ) -> Result<Sv2SyncManifest, String> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        reject_blockers(paths)?;
        let manifest = load_manifest(paths)?;
        let (source, target) =
            resolve_sync_roots(paths, &manifest, &source_slot_id, &target_slot_id)?;
        sv2_sync::dry_run(&source, &target, &categories, overwrite)
    }

    pub fn execute_selective_sync(
        &self,
        source_slot_id: String,
        target_slot_id: String,
        categories: Vec<Sv2SyncCategoryId>,
        approved: Sv2SyncManifest,
        token: String,
    ) -> Result<Sv2SyncResult, String> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        reject_blockers(paths)?;
        let manifest = load_manifest(paths)?;
        let (source, target) =
            resolve_sync_roots(paths, &manifest, &source_slot_id, &target_slot_id)?;
        sv2_sync::execute(&source, &target, &categories, &approved, &token)
    }

    pub fn import_current(&self, display_name: String) -> Result<Sv2ProfilesState, String> {
        let display_name = validate_display_name(&display_name)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        reject_blockers(paths)?;
        let mut manifest = load_manifest(paths)?;
        if manifest.active_slot_id.is_some() || !manifest.slots.is_empty() {
            return Err("当前环境已经由槽位清单管理。".to_string());
        }
        if !paths.canonical.is_dir() {
            return Err("没有可导入的 SV2 官方数据目录。".to_string());
        }
        reject_reparse_point(&paths.canonical)?;
        if read_marker(&paths.canonical)?.is_some() {
            return Err("当前 SV2 数据目录已有未知槽位标记，需要先恢复。".to_string());
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        write_marker(&paths.canonical, &id)?;
        manifest.slots.push(SlotRecord {
            id: id.clone(),
            display_name,
            legacy_username: None,
            legacy_email: None,
            legacy_manually_confirmed_voices: None,
            color: SLOT_COLORS[0].to_string(),
            created_at_utc: now.clone(),
            last_activated_at_utc: Some(now),
            concurrent_content: Sv2ConcurrentContentPreferences::default(),
        });
        manifest.active_slot_id = Some(id);
        if let Err(error) = save_manifest(paths, &manifest) {
            let _ = fs::remove_file(paths.canonical.join(MARKER_FILE));
            return Err(error);
        }
        build_state(paths, &manifest, false, String::new())
    }

    pub fn create_slot(&self, display_name: String) -> Result<Sv2ProfilesState, String> {
        let display_name = validate_display_name(&display_name)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let mut manifest = load_manifest(paths)?;
        if manifest.active_slot_id.is_none()
            && manifest.slots.is_empty()
            && paths.canonical.is_dir()
        {
            return Err("请先把现有 SV2 环境导入为第一个槽位。".to_string());
        }
        fs::create_dir_all(&paths.slots).map_err(|error| format!("无法创建槽位保管区：{error}"))?;
        validate_managed_roots(paths)?;
        let id = Uuid::new_v4().to_string();
        let parked = paths.parked(&id);
        fs::create_dir(&parked).map_err(|error| format!("无法创建新槽位：{error}"))?;
        if let Err(error) = write_marker(&parked, &id) {
            let _ = fs::remove_dir(&parked);
            return Err(error);
        }
        let record = SlotRecord {
            id: id.clone(),
            display_name,
            legacy_username: None,
            legacy_email: None,
            legacy_manually_confirmed_voices: None,
            color: SLOT_COLORS[manifest.slots.len() % SLOT_COLORS.len()].to_string(),
            created_at_utc: Utc::now().to_rfc3339(),
            last_activated_at_utc: None,
            concurrent_content: Sv2ConcurrentContentPreferences::default(),
        };
        manifest.slots.push(record);
        if let Err(error) = save_manifest(paths, &manifest) {
            let _ = fs::remove_file(parked.join(MARKER_FILE));
            let _ = fs::remove_dir(&parked);
            return Err(error);
        }
        build_state(paths, &manifest, false, String::new())
    }

    pub fn rename_slot(
        &self,
        slot_id: String,
        display_name: String,
    ) -> Result<Sv2ProfilesState, String> {
        validate_slot_id(&slot_id)?;
        let display_name = validate_display_name(&display_name)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let mut manifest = load_manifest(paths)?;
        let slot = manifest
            .slots
            .iter_mut()
            .find(|slot| slot.id == slot_id)
            .ok_or_else(|| "找不到该 SV2 槽位。".to_string())?;
        slot.display_name = display_name;
        save_manifest(paths, &manifest)?;
        build_state(paths, &manifest, false, String::new())
    }

    pub fn preview_svp_route(&self, project_path: String) -> Result<SvpRoutePlan, String> {
        let snapshot = self.account_usage_snapshot()?;
        build_route_plan(&project_path, &snapshot.profiles)
    }

    pub fn launch_svp_route(
        &self,
        slot_id: String,
        project_path: String,
        mode: SvpLaunchMode,
    ) -> Result<OperationResult, String> {
        match mode {
            SvpLaunchMode::Normal => self.launch_slot(slot_id, Some(project_path)),
            SvpLaunchMode::Concurrent => self.launch_concurrent_slot(slot_id, Some(project_path)),
        }
    }

    pub fn update_concurrent_defaults(
        &self,
        app_settings: bool,
        voice_libraries: bool,
    ) -> Result<Sv2ProfilesState, String> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let mut manifest = load_manifest(paths)?;
        manifest.concurrent_defaults = Sv2ConcurrentDefaults {
            app_settings,
            voice_libraries,
        };
        save_manifest(paths, &manifest)?;
        build_state(paths, &manifest, false, String::new())
    }

    pub fn update_concurrent_content(
        &self,
        slot_id: String,
        app_settings: Sv2IsolationPreference,
        voice_libraries: Sv2IsolationPreference,
    ) -> Result<Sv2ProfilesState, String> {
        validate_slot_id(&slot_id)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let mut manifest = load_manifest(paths)?;
        let slot = manifest
            .slots
            .iter_mut()
            .find(|slot| slot.id == slot_id)
            .ok_or_else(|| "找不到该 SV2 槽位。".to_string())?;
        slot.concurrent_content = Sv2ConcurrentContentPreferences {
            app_settings,
            voice_libraries,
        };
        save_manifest(paths, &manifest)?;
        build_state(paths, &manifest, false, String::new())
    }

    pub fn activate_slot(&self, slot_id: String) -> Result<Sv2ProfilesState, String> {
        validate_slot_id(&slot_id)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        reject_blockers(paths)?;
        let mut manifest = load_manifest(paths)?;
        switch_slot(paths, &mut manifest, &slot_id)?;
        build_state(paths, &manifest, false, String::new())
    }

    pub fn force_activate_slot(&self, slot_id: String) -> Result<Sv2ProfilesState, String> {
        validate_slot_id(&slot_id)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let mut manifest = load_manifest(paths)?;
        force_switch_slot(paths, &mut manifest, &slot_id, terminate_blockers)?;
        build_state(paths, &manifest, false, String::new())
    }

    pub fn launch_slot(
        &self,
        slot_id: String,
        project_path: Option<String>,
    ) -> Result<OperationResult, String> {
        self.launch_slot_inner(slot_id, project_path, false)
    }

    pub fn force_launch_slot(
        &self,
        slot_id: String,
        project_path: Option<String>,
    ) -> Result<OperationResult, String> {
        self.launch_slot_inner(slot_id, project_path, true)
    }

    fn launch_slot_inner(
        &self,
        slot_id: String,
        project_path: Option<String>,
        force: bool,
    ) -> Result<OperationResult, String> {
        validate_slot_id(&slot_id)?;
        let executable = find_sv2_executable()
            .ok_or_else(|| "没有发现 Synthesizer V Studio 2 Pro 可执行文件。".to_string())?;
        let project = project_path
            .as_deref()
            .map(validate_project_path)
            .transpose()?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        if force {
            terminate_blockers(paths)?;
        } else {
            reject_blockers(paths)?;
        }
        let mut manifest = load_manifest(paths)?;
        switch_slot(paths, &mut manifest, &slot_id)?;
        let session_preparation = Sv2SessionGuardStore::new(&paths.metadata).prepare_launch(
            &slot_id,
            Sv2SessionEnvironment::Normal,
            &paths.canonical,
        )?;

        // Keep both the in-process gate and the cross-process file lock held until
        // CreateProcess has inherited the selected canonical data root. This closes
        // the otherwise small race where a second toolbox instance could switch the
        // root between activation and launch.
        let mut command = Command::new(&executable);
        if let Some(project) = &project {
            command.arg(project);
        }
        command
            .spawn()
            .map_err(|error| format!("无法启动 Synthesizer V Studio 2 Pro：{error}"))?;
        Ok(succeeded(
            if force {
                "已结束占用进程、切换槽位并启动 Synthesizer V Studio 2 Pro。"
            } else {
                "已切换槽位并启动 Synthesizer V Studio 2 Pro。"
            },
            launch_session_detail(&executable, session_preparation),
        ))
    }

    pub fn open_slot_folder(&self, slot_id: String) -> Result<OperationResult, String> {
        validate_slot_id(&slot_id)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        let manifest = load_manifest(paths)?;
        if !manifest.slots.iter().any(|slot| slot.id == slot_id) {
            return Err("找不到该 SV2 槽位。".to_string());
        }
        let path = if manifest.active_slot_id.as_deref() == Some(slot_id.as_str()) {
            paths.canonical.clone()
        } else {
            paths.parked(&slot_id)
        };
        if !path.is_dir() {
            return Err("槽位数据目录不存在。".to_string());
        }
        #[cfg(windows)]
        {
            Command::new("explorer.exe")
                .arg(&path)
                .spawn()
                .map_err(|error| format!("无法打开槽位目录：{error}"))?;
            Ok(succeeded("已打开槽位数据目录。", path.to_string_lossy()))
        }
        #[cfg(not(windows))]
        {
            Ok(crate::synthv::failed(
                "SV2 账号槽位当前仅支持 Windows。",
                "",
            ))
        }
    }

    pub fn prepare_concurrent_slot(&self, slot_id: String) -> Result<Sv2ProfilesState, String> {
        validate_slot_id(&slot_id)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let manifest = load_manifest(paths)?;
        let slot = manifest
            .slots
            .iter()
            .find(|slot| slot.id == slot_id)
            .ok_or_else(|| "找不到该 SV2 槽位。".to_string())?;
        let content = slot
            .concurrent_content
            .resolve(manifest.concurrent_defaults);
        let is_active = manifest.active_slot_id.as_deref() == Some(slot_id.as_str());
        if is_active {
            reject_blockers(paths)?;
        }
        let source = if is_active {
            paths.canonical.clone()
        } else {
            paths.parked(&slot_id)
        };
        verify_marker(&source, &slot_id)?;
        let provider = detect_concurrent_provider()?;
        prepare_concurrent(
            &provider,
            &paths.vault,
            &source,
            &paths.canonical,
            &slot_id,
            content,
        )?;
        build_state(paths, &manifest, false, String::new())
    }

    pub fn launch_concurrent_slot(
        &self,
        slot_id: String,
        project_path: Option<String>,
    ) -> Result<OperationResult, String> {
        validate_slot_id(&slot_id)?;
        let executable = find_sv2_executable()
            .ok_or_else(|| "没有发现 Synthesizer V Studio 2 Pro 可执行文件。".to_string())?;
        let project = project_path
            .as_deref()
            .map(validate_project_path)
            .transpose()?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        recover_if_needed(paths)?;
        let manifest = load_manifest(paths)?;
        let slot = manifest
            .slots
            .iter()
            .find(|slot| slot.id == slot_id)
            .ok_or_else(|| "找不到该 SV2 槽位。".to_string())?;
        let content = slot
            .concurrent_content
            .resolve(manifest.concurrent_defaults);
        let provider = detect_concurrent_provider()?;
        let concurrent_view =
            concurrent_slot_view(&paths.vault, &slot_id, Some(&provider), content);
        let data_root = PathBuf::from(&concurrent_view.data_path);
        let running = concurrent_view.running_pids;
        if !running.is_empty() {
            return Err(format!(
                "槽位的隔离实例已在运行（PID：{}）。",
                running
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let session_preparation = Sv2SessionGuardStore::new(&paths.metadata).prepare_launch(
            &slot_id,
            Sv2SessionEnvironment::Concurrent,
            &data_root,
        )?;
        let mut result = launch_concurrent(
            &provider,
            &paths.vault,
            &slot_id,
            &executable,
            project.as_deref(),
            &paths.canonical,
            content,
        )?;
        result.detail = append_session_detail(result.detail, session_preparation);
        Ok(result)
    }

    pub fn open_concurrent_folder(&self, slot_id: String) -> Result<OperationResult, String> {
        validate_slot_id(&slot_id)?;
        let _gate = self
            .gate
            .lock()
            .map_err(|_| "SV2 槽位状态锁已损坏。".to_string())?;
        let paths = self.paths.as_ref().map_err(Clone::clone)?;
        let _file_lock = acquire_switch_lock(paths)?;
        let manifest = load_manifest(paths)?;
        if !manifest.slots.iter().any(|slot| slot.id == slot_id) {
            return Err("找不到该 SV2 槽位。".to_string());
        }
        #[cfg(windows)]
        {
            let path = concurrent_folder(&paths.vault, &slot_id)?;
            Command::new("explorer.exe")
                .arg(&path)
                .spawn()
                .map_err(|error| format!("无法打开隔离副本目录：{error}"))?;
            Ok(succeeded(
                "已打开隔离副本数据目录。",
                path.to_string_lossy(),
            ))
        }
        #[cfg(not(windows))]
        {
            Ok(crate::synthv::failed("并发隔离当前仅支持 Windows。", ""))
        }
    }
}

fn resolve_sync_roots(
    paths: &SlotPaths,
    manifest: &SlotManifest,
    source_slot_id: &str,
    target_slot_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    validate_slot_id(source_slot_id)?;
    validate_slot_id(target_slot_id)?;
    if source_slot_id == target_slot_id {
        return Err("选择性同步的源账号和目标账号不能相同。".to_string());
    }
    let source_slot = manifest
        .slots
        .iter()
        .find(|slot| slot.id == source_slot_id)
        .ok_or_else(|| "找不到同步源账号槽位。".to_string())?;
    let target_slot = manifest
        .slots
        .iter()
        .find(|slot| slot.id == target_slot_id)
        .ok_or_else(|| "找不到同步目标账号槽位。".to_string())?;
    if let Ok(provider) = detect_concurrent_provider() {
        for slot in [source_slot, target_slot] {
            let content = slot
                .concurrent_content
                .resolve(manifest.concurrent_defaults);
            let view = concurrent_slot_view(&paths.vault, &slot.id, Some(&provider), content);
            if !view.running_pids.is_empty() {
                return Err(format!(
                    "账号“{}”的隔离实例正在运行；请关闭后再同步资源。",
                    slot.display_name
                ));
            }
        }
    }
    let root_for = |slot_id: &str| {
        if manifest.active_slot_id.as_deref() == Some(slot_id) {
            paths.canonical.clone()
        } else {
            paths.parked(slot_id)
        }
    };
    let source = root_for(source_slot_id);
    let target = root_for(target_slot_id);
    verify_marker(&source, source_slot_id)?;
    verify_marker(&target, target_slot_id)?;
    Ok((source, target))
}

fn unsupported_state(detail: String) -> Sv2ProfilesState {
    Sv2ProfilesState {
        supported: false,
        canonical_path: String::new(),
        vault_path: String::new(),
        active_slot_id: None,
        canonical_root_exists: false,
        can_import_current: false,
        recovery_required: false,
        recovery_detail: detail.clone(),
        slots: Vec::new(),
        blockers: Vec::new(),
        concurrent_provider: concurrent_provider_view(&Err(detail)),
        concurrent_defaults: Sv2ConcurrentDefaults::default(),
    }
}

fn unsupported_precheck(detail: String) -> Sv2AccountPrecheck {
    Sv2AccountPrecheck {
        supported: false,
        checked_at_utc: Utc::now().to_rfc3339(),
        slot_id: None,
        display_name: String::new(),
        local_use: false,
        local_processes: Vec::new(),
        concurrent_pids: Vec::new(),
        remote_use: Sv2RemoteUseStatus::Unknown,
        session_file_present: false,
        recovery_pending: false,
        summary: "当前平台不支持 SV2 账号占用预检。".to_string(),
        detail,
    }
}

fn build_account_precheck(state: &Sv2ProfilesState) -> Sv2AccountPrecheck {
    let Some(slot) = state.slots.iter().find(|slot| slot.is_active) else {
        return Sv2AccountPrecheck {
            supported: state.supported,
            checked_at_utc: Utc::now().to_rfc3339(),
            slot_id: None,
            display_name: String::new(),
            local_use: false,
            local_processes: state.blockers.clone(),
            concurrent_pids: Vec::new(),
            remote_use: Sv2RemoteUseStatus::Unknown,
            session_file_present: false,
            recovery_pending: false,
            summary: "尚未设置当前默认账号。".to_string(),
            detail: "请先在“SV2 账号”页面导入或创建账号槽位。".to_string(),
        };
    };
    let local_use = !state.blockers.is_empty() || !slot.concurrent.running_pids.is_empty();
    let recovery_pending = slot.session_protection.recovery_pending()
        || slot.concurrent_session_protection.recovery_pending();
    let remote_use = Sv2RemoteUseStatus::Unknown;
    let (summary, detail) = if local_use && recovery_pending {
        (
            "当前槽位存在本机进程，且有本地 session 快照待恢复。".to_string(),
            "recoveryPending 仅描述本地保护状态；remoteUse 独立保持 unknown。".to_string(),
        )
    } else if recovery_pending {
        (
            "当前槽位有本地 session 快照待恢复。".to_string(),
            "这是独立的本地恢复状态；remoteUse 保持 unknown。".to_string(),
        )
    } else if local_use {
        (
            "当前账号正在本机使用。".to_string(),
            "已发现普通 SV2、插件、WebView2 或该账号的 Sandboxie 隔离进程。".to_string(),
        )
    } else {
        (
            "本机未发现当前账号正在使用。".to_string(),
            "没有已验证的官方远端状态查询结果；remoteUse 保持 unknown。".to_string(),
        )
    };
    Sv2AccountPrecheck {
        supported: state.supported,
        checked_at_utc: Utc::now().to_rfc3339(),
        slot_id: Some(slot.id.clone()),
        display_name: slot.display_name.clone(),
        local_use,
        local_processes: state.blockers.clone(),
        concurrent_pids: slot.concurrent.running_pids.clone(),
        remote_use,
        session_file_present: slot.session_file_present,
        recovery_pending,
        summary,
        detail,
    }
}

fn launch_session_detail(executable: &Path, preparation: SessionLaunchPreparation) -> String {
    append_session_detail(executable.to_string_lossy().into_owned(), preparation)
}

fn append_session_detail(mut detail: String, preparation: SessionLaunchPreparation) -> String {
    if preparation.restored_before_launch {
        detail.push_str(
            "\n已在启动前恢复此前消失的本地 session 文件，并重新建立保护快照；不推断文件消失原因。",
        );
    } else if preparation.snapshot_armed {
        detail.push_str("\n已为本次启动建立本地 session 保护快照。");
    }
    detail
}

fn build_state(
    paths: &SlotPaths,
    manifest: &SlotManifest,
    mut recovery_required: bool,
    mut recovery_detail: String,
) -> Result<Sv2ProfilesState, String> {
    let canonical_marker = match read_marker(&paths.canonical) {
        Ok(marker) => marker,
        Err(error) => {
            recovery_required = true;
            recovery_detail = error;
            None
        }
    };
    if let Some(marker) = &canonical_marker {
        if manifest.active_slot_id.as_deref() != Some(marker.slot_id.as_str())
            || !manifest.slots.iter().any(|slot| slot.id == marker.slot_id)
        {
            recovery_required = true;
            recovery_detail = "官方数据目录的槽位标记与清单不一致。".to_string();
        }
    } else if manifest.active_slot_id.is_some() && paths.canonical.is_dir() {
        recovery_required = true;
        recovery_detail = "当前默认槽位缺少工具箱标记。".to_string();
    } else if manifest.active_slot_id.is_some() && !paths.canonical.is_dir() {
        recovery_required = true;
        recovery_detail = "清单记录了默认槽位，但官方数据目录不存在。".to_string();
    }

    let provider = detect_concurrent_provider();
    let blockers = detect_blockers(paths);
    let guard_store = Sv2SessionGuardStore::new(&paths.metadata);
    let slots = manifest
        .slots
        .iter()
        .map(|slot| {
            let is_active = manifest.active_slot_id.as_deref() == Some(slot.id.as_str());
            let data_path = if is_active {
                paths.canonical.clone()
            } else {
                paths.parked(&slot.id)
            };
            if !data_path.is_dir() {
                recovery_required = true;
                if recovery_detail.is_empty() {
                    recovery_detail = format!("槽位“{}”的数据目录不存在。", slot.display_name);
                }
            }
            let concurrent = concurrent_slot_view(
                &paths.vault,
                &slot.id,
                provider.as_ref().ok(),
                slot.concurrent_content
                    .resolve(manifest.concurrent_defaults),
            );
            let session_protection = guard_store
                .view(
                    &slot.id,
                    Sv2SessionEnvironment::Normal,
                    &data_path,
                    is_active && !blockers.is_empty(),
                )
                .unwrap_or_else(Sv2SessionProtectionView::attention);
            let concurrent_session_protection = guard_store
                .view(
                    &slot.id,
                    Sv2SessionEnvironment::Concurrent,
                    Path::new(&concurrent.data_path),
                    !concurrent.running_pids.is_empty(),
                )
                .unwrap_or_else(Sv2SessionProtectionView::attention);
            let identity = probe_sv2_identity(&data_path);
            let session_file_present = identity.status == Sv2IdentityStatus::SessionPresent;
            Sv2ProfileSlotView {
                id: slot.id.clone(),
                display_name: slot.display_name.clone(),
                identity,
                color: slot.color.clone(),
                created_at_utc: slot.created_at_utc.clone(),
                last_activated_at_utc: slot.last_activated_at_utc.clone(),
                is_active,
                session_file_present,
                data_path: data_path.to_string_lossy().into_owned(),
                session_protection,
                concurrent_session_protection,
                concurrent,
                voice_inventory: inspect_voice_inventory(),
            }
        })
        .collect();

    Ok(Sv2ProfilesState {
        supported: true,
        canonical_path: paths.canonical.to_string_lossy().into_owned(),
        vault_path: paths.vault.to_string_lossy().into_owned(),
        active_slot_id: manifest.active_slot_id.clone(),
        canonical_root_exists: paths.canonical.is_dir(),
        can_import_current: paths.canonical.is_dir()
            && manifest.active_slot_id.is_none()
            && canonical_marker.is_none(),
        recovery_required,
        recovery_detail,
        slots,
        blockers,
        concurrent_provider: concurrent_provider_view(&provider),
        concurrent_defaults: manifest.concurrent_defaults,
    })
}

fn switch_slot(
    paths: &SlotPaths,
    manifest: &mut SlotManifest,
    target_slot_id: &str,
) -> Result<(), String> {
    if !manifest.slots.iter().any(|slot| slot.id == target_slot_id) {
        return Err("找不到目标 SV2 槽位。".to_string());
    }
    if manifest.active_slot_id.as_deref() == Some(target_slot_id) {
        verify_marker(&paths.canonical, target_slot_id)?;
        return Ok(());
    }
    fs::create_dir_all(&paths.slots).map_err(|error| format!("无法创建槽位保管区：{error}"))?;
    validate_managed_roots(paths)?;
    let target = paths.parked(target_slot_id);
    reject_reparse_point(&target)?;
    verify_marker(&target, target_slot_id)?;
    let current_slot_id = manifest.active_slot_id.clone();
    if let Some(current_slot_id) = &current_slot_id {
        reject_reparse_point(&paths.canonical)?;
        verify_marker(&paths.canonical, current_slot_id)?;
        if paths.parked(current_slot_id).exists() {
            return Err("当前槽位的停放目录意外存在；为避免覆盖，切换已停止。".to_string());
        }
    } else if paths.canonical.exists() {
        return Err("官方数据目录尚未导入，不能激活其他槽位。".to_string());
    }

    let mut journal = SwitchJournal {
        schema_version: SCHEMA_VERSION,
        transaction_id: Uuid::new_v4().to_string(),
        current_slot_id: current_slot_id.clone(),
        target_slot_id: target_slot_id.to_string(),
        phase: SwitchPhase::Prepared,
    };
    save_journal(paths, &journal)?;

    if let Some(current_slot_id) = &current_slot_id {
        fs::rename(&paths.canonical, paths.parked(current_slot_id))
            .map_err(|error| format!("无法停放当前槽位：{error}"))?;
        journal.phase = SwitchPhase::CurrentParked;
        save_journal(paths, &journal)?;
    }

    fs::rename(&target, &paths.canonical).map_err(|error| format!("无法激活目标槽位：{error}"))?;
    journal.phase = SwitchPhase::TargetActivated;
    save_journal(paths, &journal)?;
    verify_marker(&paths.canonical, target_slot_id)?;

    manifest.active_slot_id = Some(target_slot_id.to_string());
    if let Some(slot) = manifest
        .slots
        .iter_mut()
        .find(|slot| slot.id == target_slot_id)
    {
        slot.last_activated_at_utc = Some(Utc::now().to_rfc3339());
    }
    save_manifest(paths, manifest)?;
    journal.phase = SwitchPhase::Committed;
    save_journal(paths, &journal)?;
    remove_journal(paths)?;
    Ok(())
}

fn force_switch_slot<F>(
    paths: &SlotPaths,
    manifest: &mut SlotManifest,
    target_slot_id: &str,
    terminate: F,
) -> Result<(), String>
where
    F: FnOnce(&SlotPaths) -> Result<(), String>,
{
    if !manifest.slots.iter().any(|slot| slot.id == target_slot_id) {
        return Err("找不到目标 SV2 槽位。".to_string());
    }
    terminate(paths)?;
    switch_slot(paths, manifest, target_slot_id)
}

fn recover_if_needed(paths: &SlotPaths) -> Result<(), String> {
    let Some(journal) = load_journal(paths)? else {
        return Ok(());
    };
    if journal.schema_version != SCHEMA_VERSION {
        return Err("发现不受支持的槽位切换日志版本。".to_string());
    }
    validate_slot_id(&journal.target_slot_id)?;
    if let Some(current) = &journal.current_slot_id {
        validate_slot_id(current)?;
    }
    let mut manifest = load_manifest(paths)?;
    let canonical_id = read_marker(&paths.canonical)?.map(|marker| marker.slot_id);
    let target_parked = paths.parked(&journal.target_slot_id);
    let target_parked_id = read_marker(&target_parked)?.map(|marker| marker.slot_id);
    let current_parked_id = journal
        .current_slot_id
        .as_deref()
        .map(|id| read_marker(&paths.parked(id)).map(|marker| marker.map(|value| value.slot_id)))
        .transpose()?
        .flatten();

    let not_started = match &journal.current_slot_id {
        Some(current) => {
            canonical_id.as_deref() == Some(current.as_str())
                && current_parked_id.is_none()
                && target_parked_id.as_deref() == Some(journal.target_slot_id.as_str())
        }
        None => {
            canonical_id.is_none()
                && target_parked_id.as_deref() == Some(journal.target_slot_id.as_str())
        }
    };
    if not_started {
        remove_journal(paths)?;
        return Ok(());
    }

    let current_is_parked = match &journal.current_slot_id {
        Some(current) => current_parked_id.as_deref() == Some(current.as_str()),
        None => true,
    };
    if canonical_id.is_none()
        && current_is_parked
        && target_parked_id.as_deref() == Some(journal.target_slot_id.as_str())
        && !paths.canonical.exists()
    {
        fs::rename(&target_parked, &paths.canonical)
            .map_err(|error| format!("无法恢复目标槽位：{error}"))?;
    }

    let canonical_id = read_marker(&paths.canonical)?.map(|marker| marker.slot_id);
    if canonical_id.as_deref() == Some(journal.target_slot_id.as_str()) && current_is_parked {
        manifest.active_slot_id = Some(journal.target_slot_id.clone());
        if let Some(slot) = manifest
            .slots
            .iter_mut()
            .find(|slot| slot.id == journal.target_slot_id)
        {
            slot.last_activated_at_utc = Some(Utc::now().to_rfc3339());
        }
        save_manifest(paths, &manifest)?;
        remove_journal(paths)?;
        return Ok(());
    }

    Err(format!(
        "无法自动恢复切换事务 {}：目录实况与日志不一致。",
        journal.transaction_id
    ))
}

fn reject_blockers(paths: &SlotPaths) -> Result<(), String> {
    let blockers = detect_blockers(paths);
    if blockers.is_empty() {
        return Ok(());
    }
    Err(format!(
        "请先保存并关闭所有使用 SV2 的程序，再切换账号槽位。\n{}",
        format_blockers(&blockers)
    ))
}

fn format_blockers(blockers: &[Sv2ProcessBlocker]) -> String {
    blockers
        .iter()
        .map(|blocker| match blocker.pid {
            Some(pid) => format!("{} (PID {pid})：{}", blocker.name, blocker.reason),
            None => format!("{}：{}", blocker.name, blocker.reason),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn terminate_blockers(paths: &SlotPaths) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = paths;
        Err("强制切换当前仅支持 Windows。".to_string())
    }

    #[cfg(windows)]
    {
        let blockers = detect_blockers(paths);
        if blockers.is_empty() {
            return Ok(());
        }
        let mut processes = blockers
            .iter()
            .filter_map(|blocker| {
                blocker.pid.map(|pid| {
                    let priority = if blocker.reason.contains("standalone") {
                        0
                    } else {
                        1
                    };
                    (priority, pid)
                })
            })
            .collect::<Vec<_>>();
        processes.sort_unstable();
        let mut seen = std::collections::HashSet::new();
        processes.retain(|(_, pid)| seen.insert(*pid));
        if processes.is_empty() {
            return Err(format!(
                "没有可安全结束的进程 PID，强制切换已取消。\n{}",
                format_blockers(&blockers)
            ));
        }
        for (_, pid) in processes {
            Command::new("taskkill.exe")
                .arg("/PID")
                .arg(pid.to_string())
                .args(["/T", "/F"])
                .output()
                .map_err(|error| format!("无法结束 PID {pid} 的进程树：{error}"))?;
        }
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if detect_blockers(paths).is_empty() {
                return Ok(());
            }
        }
        let remaining = detect_blockers(paths);
        Err(format!(
            "部分 SV2 占用在强制结束后仍存在，槽位尚未切换。\n{}",
            format_blockers(&remaining)
        ))
    }
}

fn load_manifest(paths: &SlotPaths) -> Result<SlotManifest, String> {
    if !paths.manifest.is_file() {
        return Ok(SlotManifest::default());
    }
    let mut manifest: SlotManifest = read_json(&paths.manifest, "槽位清单")?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err("槽位清单版本不受支持。".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for slot in &manifest.slots {
        validate_slot_id(&slot.id)?;
        validate_display_name(&slot.display_name)?;
        validate_color(&slot.color)?;
        if !ids.insert(slot.id.as_str()) {
            return Err("槽位清单包含重复 ID。".to_string());
        }
    }
    if manifest
        .active_slot_id
        .as_deref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err("默认槽位不在槽位清单中。".to_string());
    }
    let contains_legacy_account_fields = manifest.slots.iter().any(|slot| {
        slot.legacy_username.is_some()
            || slot.legacy_email.is_some()
            || slot.legacy_manually_confirmed_voices.is_some()
    });
    if contains_legacy_account_fields {
        for slot in &mut manifest.slots {
            slot.legacy_username = None;
            slot.legacy_email = None;
            slot.legacy_manually_confirmed_voices = None;
        }
        save_manifest(paths, &manifest)?;
    }
    Ok(manifest)
}

fn save_manifest(paths: &SlotPaths, manifest: &SlotManifest) -> Result<(), String> {
    write_json_atomic(&paths.manifest, manifest, "槽位清单")
}

fn load_journal(paths: &SlotPaths) -> Result<Option<SwitchJournal>, String> {
    if !paths.journal.is_file() {
        return Ok(None);
    }
    read_json(&paths.journal, "槽位切换日志").map(Some)
}

fn save_journal(paths: &SlotPaths, journal: &SwitchJournal) -> Result<(), String> {
    write_json_atomic(&paths.journal, journal, "槽位切换日志")
}

fn remove_journal(paths: &SlotPaths) -> Result<(), String> {
    if paths.journal.is_file() {
        fs::remove_file(&paths.journal)
            .map_err(|error| format!("无法移除已完成的切换日志：{error}"))?;
    }
    Ok(())
}

fn write_marker(root: &Path, slot_id: &str) -> Result<(), String> {
    write_json_atomic(
        &root.join(MARKER_FILE),
        &SlotMarker {
            schema_version: SCHEMA_VERSION,
            slot_id: slot_id.to_string(),
        },
        "槽位标记",
    )
}

fn read_marker(root: &Path) -> Result<Option<SlotMarker>, String> {
    if !root.is_dir() {
        return Ok(None);
    }
    let path = root.join(MARKER_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let marker: SlotMarker = read_json(&path, "槽位标记")?;
    if marker.schema_version != SCHEMA_VERSION {
        return Err(format!("{} 的槽位标记版本不受支持。", root.display()));
    }
    validate_slot_id(&marker.slot_id)?;
    Ok(Some(marker))
}

fn verify_marker(root: &Path, expected: &str) -> Result<(), String> {
    let marker = read_marker(root)?.ok_or_else(|| format!("{} 缺少槽位标记。", root.display()))?;
    if marker.slot_id != expected {
        return Err(format!("{} 的槽位标记不匹配。", root.display()));
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("无法读取{label} {}：{error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{label}不是有效 JSON：{error}"))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label}路径没有父目录。"))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建{label}目录：{error}"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("state"),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut file =
        File::create(&temporary).map_err(|error| format!("无法创建{label}临时文件：{error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("无法写入{label}：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("无法刷新{label}：{error}"))?;
    drop(file);
    replace_file(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("无法提交{label}：{error}")
    })
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

fn acquire_switch_lock(paths: &SlotPaths) -> Result<File, String> {
    validate_managed_roots(paths)?;
    fs::create_dir_all(&paths.metadata)
        .map_err(|error| format!("无法创建槽位元数据目录：{error}"))?;
    validate_managed_roots(paths)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&paths.lock)
            .map_err(|error| format!("另一个工具箱进程正在操作 SV2 槽位：{error}"))
    }
    #[cfg(not(windows))]
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&paths.lock)
        .map_err(|error| format!("无法获取 SV2 槽位锁：{error}"))
}

fn validate_managed_roots(paths: &SlotPaths) -> Result<(), String> {
    for path in [
        &paths.canonical,
        &paths.vault,
        &paths.slots,
        &paths.metadata,
    ] {
        reject_reparse_point(path)?;
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 64 || value.chars().any(char::is_control) {
        return Err("槽位名称必须为 1–64 个可见字符。".to_string());
    }
    Ok(value.to_string())
}

fn validate_color(value: &str) -> Result<(), String> {
    if value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..]
            .iter()
            .all(|character| character.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err("槽位颜色格式无效。".to_string())
    }
}

fn validate_slot_id(value: &str) -> Result<(), String> {
    match Uuid::parse_str(value) {
        Ok(id) if id.get_version_num() == 4 => Ok(()),
        _ => Err("槽位 ID 非法。".to_string()),
    }
}

fn validate_project_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_file()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("svp"))
    {
        return Err("启动工程必须是现有的 .svp 文件。".to_string());
    }
    path.canonicalize()
        .map_err(|error| format!("无法解析工程路径：{error}"))
}

fn reject_reparse_point(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查目录 {}：{error}", path.display()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "目录 {} 是 reparse point；为避免越界移动，操作已停止。",
                path.display()
            ));
        }
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        return Err(format!("目录 {} 是符号链接。", path.display()));
    }
    Ok(())
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

#[cfg(windows)]
fn detect_blockers(paths: &SlotPaths) -> Vec<Sv2ProcessBlocker> {
    windows_guard::detect(paths)
}

#[cfg(not(windows))]
fn detect_blockers(_paths: &SlotPaths) -> Vec<Sv2ProcessBlocker> {
    Vec::new()
}

#[cfg(windows)]
mod windows_guard {
    use std::collections::{HashMap, HashSet};
    use std::mem::{size_of, zeroed};
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Process32FirstW, Process32NextW,
        MODULEENTRY32W, PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::OpenMutexW;

    use super::{SlotPaths, Sv2ProcessBlocker};

    const ERROR_MORE_DATA: u32 = 234;
    const ERROR_SUCCESS: u32 = 0;
    const CCH_RM_SESSION_KEY: usize = 32;
    const CCH_RM_MAX_APP_NAME: usize = 255;
    const CCH_RM_MAX_SVC_NAME: usize = 63;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RmUniqueProcess {
        process_id: u32,
        start_time: FileTime,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RmProcessInfo {
        process: RmUniqueProcess,
        app_name: [u16; CCH_RM_MAX_APP_NAME + 1],
        service_short_name: [u16; CCH_RM_MAX_SVC_NAME + 1],
        application_type: u32,
        app_status: u32,
        session_id: u32,
        restartable: i32,
    }

    #[link(name = "Rstrtmgr")]
    unsafe extern "system" {
        fn RmStartSession(handle: *mut u32, flags: u32, key: *mut u16) -> u32;
        fn RmRegisterResources(
            handle: u32,
            file_count: u32,
            files: *const *const u16,
            app_count: u32,
            apps: *const RmUniqueProcess,
            service_count: u32,
            services: *const *const u16,
        ) -> u32;
        fn RmGetList(
            handle: u32,
            needed: *mut u32,
            count: *mut u32,
            processes: *mut RmProcessInfo,
            reboot_reasons: *mut u32,
        ) -> u32;
        fn RmEndSession(handle: u32) -> u32;
    }

    pub(super) fn detect(paths: &SlotPaths) -> Vec<Sv2ProcessBlocker> {
        let processes = process_snapshot();
        let mut blockers = Vec::new();
        let mut seen = HashSet::new();
        let standalone_names = [
            "synthv-studio.exe",
            "synthesizer v studio 2 pro.exe",
            "synthesizer v studio pro.exe",
        ];
        for (pid, name) in &processes {
            if standalone_names
                .iter()
                .any(|candidate| name.eq_ignore_ascii_case(candidate))
                && seen.insert(*pid)
            {
                blockers.push(Sv2ProcessBlocker {
                    pid: Some(*pid),
                    name: name.clone(),
                    reason: "SV2 standalone 正在运行".to_string(),
                });
                continue;
            }
            if process_loads_sv2_plugin(*pid) && seen.insert(*pid) {
                blockers.push(Sv2ProcessBlocker {
                    pid: Some(*pid),
                    name: name.clone(),
                    reason: "进程已加载 Synthesizer V Studio 2 插件".to_string(),
                });
            }
        }

        for blocker in restart_manager_blockers(paths) {
            if blocker.pid.is_none() || blocker.pid.is_some_and(|pid| seen.insert(pid)) {
                blockers.push(blocker);
            }
        }

        if !blockers
            .iter()
            .any(|blocker| blocker.reason.contains("standalone"))
            && global_app_mutex_exists()
        {
            blockers.push(Sv2ProcessBlocker {
                pid: None,
                name: "Synthesizer V Studio 2 Pro".to_string(),
                reason: "检测到全局单实例锁 Applock_SVStudio2_Pro".to_string(),
            });
        }
        blockers.sort_by(|left, right| left.name.cmp(&right.name).then(left.pid.cmp(&right.pid)));
        blockers
    }

    fn process_snapshot() -> HashMap<u32, String> {
        let mut result = HashMap::new();
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return result;
        }
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            result.insert(entry.th32ProcessID, wide_text(&entry.szExeFile));
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        result
    }

    fn process_loads_sv2_plugin(pid: u32) -> bool {
        let snapshot =
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) };
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: MODULEENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<MODULEENTRY32W>() as u32;
        let mut found = false;
        let mut ok = unsafe { Module32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            let module = wide_text(&entry.szModule).to_ascii_lowercase();
            let path = wide_text(&entry.szExePath).to_ascii_lowercase();
            let belongs_to_sv2 = module.contains("synthesizer v studio 2")
                || path.contains("synthesizer v studio 2");
            let is_plugin_module = module.ends_with(".vst3")
                || module.ends_with(".dll")
                || path.ends_with(".vst3")
                || path.ends_with(".dll")
                || path.contains(".vst3\\");
            if belongs_to_sv2 && is_plugin_module {
                found = true;
                break;
            }
            ok = unsafe { Module32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        found
    }

    fn global_app_mutex_exists() -> bool {
        ["Global\\Applock_SVStudio2_Pro", "Applock_SVStudio2_Pro"]
            .iter()
            .any(|name| {
                let wide = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
                let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, wide.as_ptr()) };
                if handle.is_null() {
                    false
                } else {
                    unsafe { CloseHandle(handle) };
                    true
                }
            })
    }

    fn restart_manager_blockers(paths: &SlotPaths) -> Vec<Sv2ProcessBlocker> {
        let candidates = [
            paths.canonical.join("license/session"),
            paths.canonical.join("settings/settings.xml"),
            paths.canonical.join("webview2/EBWebView/Local State"),
            paths
                .canonical
                .join("webview2/EBWebView/Default/Network/Cookies"),
        ];
        let wide_files = candidates
            .iter()
            .filter(|path| path.is_file())
            .map(|path| wide_path(path))
            .collect::<Vec<_>>();
        if wide_files.is_empty() {
            return Vec::new();
        }
        let pointers = wide_files
            .iter()
            .map(|path| path.as_ptr())
            .collect::<Vec<_>>();
        let mut handle = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY + 1];
        if unsafe { RmStartSession(&mut handle, 0, key.as_mut_ptr()) } != ERROR_SUCCESS {
            return Vec::new();
        }
        let result = unsafe {
            RmRegisterResources(
                handle,
                pointers.len() as u32,
                pointers.as_ptr(),
                0,
                null(),
                0,
                null(),
            )
        };
        if result != ERROR_SUCCESS {
            unsafe { RmEndSession(handle) };
            return Vec::new();
        }
        let mut needed = 0u32;
        let mut count = 0u32;
        let mut reboot = 0u32;
        let initial =
            unsafe { RmGetList(handle, &mut needed, &mut count, null_mut(), &mut reboot) };
        if initial != ERROR_MORE_DATA || needed == 0 {
            unsafe { RmEndSession(handle) };
            return Vec::new();
        }
        let mut items = vec![unsafe { zeroed::<RmProcessInfo>() }; needed as usize];
        count = needed;
        let query = unsafe {
            RmGetList(
                handle,
                &mut needed,
                &mut count,
                items.as_mut_ptr(),
                &mut reboot,
            )
        };
        unsafe { RmEndSession(handle) };
        if query != ERROR_SUCCESS {
            return Vec::new();
        }
        items
            .into_iter()
            .take(count as usize)
            .map(|item| Sv2ProcessBlocker {
                pid: Some(item.process.process_id),
                name: {
                    let name = wide_text(&item.app_name);
                    if name.is_empty() {
                        format!("PID {}", item.process.process_id)
                    } else {
                        name
                    }
                },
                reason: "正在使用当前 SV2 槽位文件".to_string(),
            })
            .collect()
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn wide_text(value: &[u16]) -> String {
        let length = value
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(value.len());
        String::from_utf16_lossy(&value[..length])
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, SlotPaths) {
        let root = std::env::temp_dir().join(format!("sv2-slot-test-{}", Uuid::new_v4()));
        let paths = SlotPaths::for_test(&root);
        fs::create_dir_all(&paths.metadata).unwrap();
        (root, paths)
    }

    fn import_fixture(paths: &SlotPaths, name: &str) -> SlotManifest {
        fs::create_dir_all(paths.canonical.join("license")).unwrap();
        fs::write(paths.canonical.join("license/session"), b"session").unwrap();
        let id = Uuid::new_v4().to_string();
        write_marker(&paths.canonical, &id).unwrap();
        let manifest = SlotManifest {
            schema_version: SCHEMA_VERSION,
            active_slot_id: Some(id.clone()),
            slots: vec![SlotRecord {
                id,
                display_name: name.to_string(),
                legacy_username: None,
                legacy_email: None,
                legacy_manually_confirmed_voices: None,
                color: SLOT_COLORS[0].to_string(),
                created_at_utc: Utc::now().to_rfc3339(),
                last_activated_at_utc: None,
                concurrent_content: Sv2ConcurrentContentPreferences::default(),
            }],
            concurrent_defaults: Sv2ConcurrentDefaults::default(),
        };
        save_manifest(paths, &manifest).unwrap();
        manifest
    }

    fn add_parked(paths: &SlotPaths, manifest: &mut SlotManifest, name: &str) -> String {
        let id = Uuid::new_v4().to_string();
        let parked = paths.parked(&id);
        fs::create_dir_all(&parked).unwrap();
        write_marker(&parked, &id).unwrap();
        fs::write(parked.join("identity.txt"), name.as_bytes()).unwrap();
        manifest.slots.push(SlotRecord {
            id: id.clone(),
            display_name: name.to_string(),
            legacy_username: None,
            legacy_email: None,
            legacy_manually_confirmed_voices: None,
            color: SLOT_COLORS[1].to_string(),
            created_at_utc: Utc::now().to_rfc3339(),
            last_activated_at_utc: None,
            concurrent_content: Sv2ConcurrentContentPreferences::default(),
        });
        save_manifest(paths, manifest).unwrap();
        id
    }

    #[test]
    fn switches_whole_roots_without_copying_session_state() {
        let (root, paths) = fixture();
        let mut manifest = import_fixture(&paths, "A");
        fs::write(paths.canonical.join("identity.txt"), b"A").unwrap();
        let a = manifest.active_slot_id.clone().unwrap();
        let b = add_parked(&paths, &mut manifest, "B");

        switch_slot(&paths, &mut manifest, &b).unwrap();

        assert_eq!(
            fs::read(paths.canonical.join("identity.txt")).unwrap(),
            b"B"
        );
        assert_eq!(
            fs::read(paths.parked(&a).join("identity.txt")).unwrap(),
            b"A"
        );
        assert_eq!(manifest.active_slot_id.as_deref(), Some(b.as_str()));
        assert!(!paths.journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_empty_slot_becomes_the_canonical_default() {
        let (root, paths) = fixture();
        let mut manifest = SlotManifest::default();
        let slot = add_parked(&paths, &mut manifest, "First");

        switch_slot(&paths, &mut manifest, &slot).unwrap();

        assert_eq!(manifest.active_slot_id.as_deref(), Some(slot.as_str()));
        assert_eq!(
            read_marker(&paths.canonical).unwrap().unwrap().slot_id,
            slot
        );
        assert!(!paths.journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn force_switch_terminates_blockers_then_only_changes_the_default() {
        let (root, paths) = fixture();
        let mut manifest = import_fixture(&paths, "A");
        let target = add_parked(&paths, &mut manifest, "B");
        let termination_called = std::cell::Cell::new(false);

        force_switch_slot(&paths, &mut manifest, &target, |_| {
            termination_called.set(true);
            Ok(())
        })
        .unwrap();

        assert!(termination_called.get());
        assert_eq!(manifest.active_slot_id.as_deref(), Some(target.as_str()));
        assert_eq!(
            read_marker(&paths.canonical).unwrap().unwrap().slot_id,
            target
        );
        assert!(!paths.journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_finishes_after_current_slot_was_parked() {
        let (root, paths) = fixture();
        let mut manifest = import_fixture(&paths, "A");
        let a = manifest.active_slot_id.clone().unwrap();
        let b = add_parked(&paths, &mut manifest, "B");
        let journal = SwitchJournal {
            schema_version: SCHEMA_VERSION,
            transaction_id: Uuid::new_v4().to_string(),
            current_slot_id: Some(a.clone()),
            target_slot_id: b.clone(),
            phase: SwitchPhase::Prepared,
        };
        save_journal(&paths, &journal).unwrap();
        fs::rename(&paths.canonical, paths.parked(&a)).unwrap();

        recover_if_needed(&paths).unwrap();

        assert_eq!(read_marker(&paths.canonical).unwrap().unwrap().slot_id, b);
        assert_eq!(load_manifest(&paths).unwrap().active_slot_id, Some(b));
        assert!(!paths.journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_commits_when_target_is_already_canonical() {
        let (root, paths) = fixture();
        let mut manifest = import_fixture(&paths, "A");
        let a = manifest.active_slot_id.clone().unwrap();
        let b = add_parked(&paths, &mut manifest, "B");
        save_journal(
            &paths,
            &SwitchJournal {
                schema_version: SCHEMA_VERSION,
                transaction_id: Uuid::new_v4().to_string(),
                current_slot_id: Some(a.clone()),
                target_slot_id: b.clone(),
                phase: SwitchPhase::CurrentParked,
            },
        )
        .unwrap();
        fs::rename(&paths.canonical, paths.parked(&a)).unwrap();
        fs::rename(paths.parked(&b), &paths.canonical).unwrap();

        recover_if_needed(&paths).unwrap();

        assert_eq!(load_manifest(&paths).unwrap().active_slot_id, Some(b));
        assert!(!paths.journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_does_not_overwrite_an_unknown_canonical_directory() {
        let (root, paths) = fixture();
        let mut manifest = import_fixture(&paths, "A");
        let a = manifest.active_slot_id.clone().unwrap();
        let b = add_parked(&paths, &mut manifest, "B");
        let journal = SwitchJournal {
            schema_version: SCHEMA_VERSION,
            transaction_id: Uuid::new_v4().to_string(),
            current_slot_id: Some(a.clone()),
            target_slot_id: b,
            phase: SwitchPhase::CurrentParked,
        };
        save_journal(&paths, &journal).unwrap();
        fs::rename(&paths.canonical, paths.parked(&a)).unwrap();
        fs::create_dir_all(&paths.canonical).unwrap();
        fs::write(paths.canonical.join("external.txt"), b"keep").unwrap();

        assert!(recover_if_needed(&paths).is_err());
        assert_eq!(
            fs::read(paths.canonical.join("external.txt")).unwrap(),
            b"keep"
        );
        assert!(paths.journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn names_and_slot_ids_are_strictly_validated() {
        assert!(validate_display_name(" ").is_err());
        assert!(validate_display_name(&"x".repeat(65)).is_err());
        assert!(validate_slot_id("../../escape").is_err());
        assert!(validate_slot_id(&Uuid::new_v4().to_string()).is_ok());
        assert!(validate_color("#6D5CE7").is_ok());
        assert!(validate_color("red;display:none").is_err());
    }

    #[test]
    fn invalid_manifest_color_is_rejected() {
        let (root, paths) = fixture();
        let mut manifest = import_fixture(&paths, "A");
        manifest.slots[0].color = "red;display:none".to_string();
        save_manifest(&paths, &manifest).unwrap();

        assert!(load_manifest(&paths).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn loading_schema_v1_manifest_atomically_removes_legacy_account_fields() {
        let (root, paths) = fixture();
        let manifest = import_fixture(&paths, "A");
        let mut legacy = serde_json::to_value(&manifest).unwrap();
        let slot = legacy["slots"][0].as_object_mut().unwrap();
        slot.insert("username".to_string(), serde_json::json!("Producer"));
        slot.insert(
            "email".to_string(),
            serde_json::json!("producer@example.com"),
        );
        slot.insert(
            "manuallyConfirmedVoices".to_string(),
            serde_json::json!(["Legacy Voice"]),
        );
        write_json_atomic(&paths.manifest, &legacy, "测试槽位清单").unwrap();

        let migrated = load_manifest(&paths).unwrap();
        let persisted: serde_json::Value = read_json(&paths.manifest, "测试槽位清单").unwrap();
        let persisted_slot = persisted["slots"][0].as_object().unwrap();

        assert!(migrated.slots[0].legacy_username.is_none());
        assert!(migrated.slots[0].legacy_email.is_none());
        assert!(migrated.slots[0].legacy_manually_confirmed_voices.is_none());
        assert!(!persisted_slot.contains_key("username"));
        assert!(!persisted_slot.contains_key("email"));
        assert!(!persisted_slot.contains_key("manuallyConfirmedVoices"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn precheck_keeps_local_recovery_separate_from_remote_status() {
        let (root, paths) = fixture();
        let manifest = import_fixture(&paths, "A");
        let slot_id = manifest.active_slot_id.clone().unwrap();
        let store = Sv2SessionGuardStore::new(&paths.metadata);
        store
            .prepare_launch(&slot_id, Sv2SessionEnvironment::Normal, &paths.canonical)
            .unwrap();
        fs::remove_file(paths.canonical.join("license/session")).unwrap();

        let service = Sv2ProfileService {
            paths: Ok(paths),
            gate: Mutex::new(()),
        };
        let snapshot = service.account_usage_snapshot().unwrap();
        let precheck = snapshot.precheck;

        assert!(precheck.recovery_pending);
        assert_eq!(precheck.remote_use, Sv2RemoteUseStatus::Unknown);
        assert!(precheck.detail.contains("本地恢复状态"));
        assert!(!precheck.detail.contains("其他设备"));
        assert!(!precheck.detail.contains("冲突"));
        assert_eq!(precheck.slot_id.as_deref(), Some(slot_id.as_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn usage_snapshot_keeps_profile_and_precheck_evidence_consistent() {
        let (root, paths) = fixture();
        let manifest = import_fixture(&paths, "A");
        let active_slot_id = manifest.active_slot_id.clone().unwrap();
        let service = Sv2ProfileService {
            paths: Ok(paths),
            gate: Mutex::new(()),
        };

        let snapshot = service.account_usage_snapshot().unwrap();
        let active_slot = snapshot
            .profiles
            .slots
            .iter()
            .find(|slot| slot.is_active)
            .unwrap();

        assert_eq!(
            snapshot.profiles.active_slot_id,
            Some(active_slot_id.clone())
        );
        assert_eq!(snapshot.precheck.slot_id, Some(active_slot_id));
        assert_eq!(
            snapshot.precheck.local_processes,
            snapshot.profiles.blockers
        );
        assert_eq!(
            snapshot.precheck.concurrent_pids,
            active_slot.concurrent.running_pids
        );
        fs::remove_dir_all(root).unwrap();
    }
}
