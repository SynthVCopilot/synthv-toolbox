use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent::{AgentError, ToolCall, ToolDefinition, ToolExecutor, ToolResult};
use crate::agent_files::FileApprovalManager;
use crate::bridge_workflows;
use crate::components::component_list;
use crate::config::AgentWorkMode;
use crate::creative_history;
use crate::downloads::ComponentDownloadManager;
use crate::mcp::McpToolExecutor;
use crate::mcp::{McpManager, SynthVConnectionProfile};
use crate::media_import;
use crate::media_tasks::{CoverTaskRequest, MediaTaskManager};
use crate::solo_tuning::{self, SoloTuningRequest};
use crate::synthv_unified;
use crate::tuning_profiles::{self, TuningParameters};
use crate::workflows;
use tokio::runtime::Handle;

const MAX_CLIP_SECONDS: f64 = 30.0;
const MAX_GUARD_SECONDS: f64 = 2.0;
const MAX_WAV_BYTES: u64 = 128 * 1024 * 1024;
const PLAYBACK_POLL_INTERVAL: Duration = Duration::from_millis(45);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureCapability {
    pub supported: bool,
    pub backend: String,
    pub detail: String,
    pub max_clip_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureTarget {
    pub process_id: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureClipRequest {
    pub process_id: Option<u32>,
    pub start_seconds: f64,
    pub end_seconds: f64,
    #[serde(default = "default_pre_roll")]
    pub pre_roll_seconds: f64,
    #[serde(default = "default_post_roll")]
    pub post_roll_seconds: f64,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMetrics {
    pub duration_seconds: f64,
    pub peak_dbfs: f64,
    pub rms_dbfs: f64,
    pub clipped_sample_ratio: f64,
    pub silent_sample_ratio: f64,
    pub high_frequency_proxy_db: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedClip {
    pub output_path: String,
    pub metadata_path: String,
    pub process_id: u32,
    pub process_name: String,
    pub session_token: Option<String>,
    pub requested_start_seconds: f64,
    pub requested_end_seconds: f64,
    pub actual_pre_roll_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub frames: u64,
    pub discontinuities: u32,
    pub boundary_uncertainty_ms: f64,
    pub sha256: String,
    pub metrics: ClipMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareClipsRequest {
    pub baseline_path: String,
    pub candidate_path: String,
    #[serde(default = "default_max_lag_ms")]
    pub max_lag_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbComparison {
    pub baseline_path: String,
    pub candidate_path: String,
    pub sample_rate: u32,
    pub aligned_lag_ms: f64,
    pub overlap_seconds: f64,
    pub correlation: f64,
    pub delta_rms_db: f64,
    pub loudness_delta_db: f64,
    pub peak_delta_db: f64,
    pub clipping_delta_percent: f64,
    pub high_frequency_delta_db: f64,
    pub similarity_percent: f64,
    pub classification: String,
    pub baseline: ClipMetrics,
    pub candidate: ClipMetrics,
}

fn default_pre_roll() -> f64 {
    0.4
}

fn default_post_roll() -> f64 {
    0.25
}

fn default_max_lag_ms() -> f64 {
    250.0
}

pub fn capability() -> AudioCaptureCapability {
    #[cfg(windows)]
    {
        match windows_build_number() {
            Some(build) if build >= 20_348 => AudioCaptureCapability {
                supported: true,
                backend: "wasapi-process-loopback".to_string(),
                detail: format!(
                    "使用 Windows 进程级回环，只捕获所选 SynthV 进程树；当前系统 build {build}。"
                ),
                max_clip_seconds: MAX_CLIP_SECONDS,
            },
            Some(build) => AudioCaptureCapability {
                supported: false,
                backend: "unavailable".to_string(),
                detail: format!(
                    "当前 Windows build {build} 不支持进程级回环；需要 build 20348 或更高版本。"
                ),
                max_clip_seconds: MAX_CLIP_SECONDS,
            },
            None => AudioCaptureCapability {
                supported: false,
                backend: "unavailable".to_string(),
                detail: "无法确认 Windows build，已停用进程级回环以避免不可靠捕获。".to_string(),
                max_clip_seconds: MAX_CLIP_SECONDS,
            },
        }
    }
    #[cfg(target_os = "macos")]
    {
        match macos_version() {
            Some((major, minor)) if major > 14 || (major == 14 && minor >= 2) => {
                AudioCaptureCapability {
                    supported: true,
                    backend: "core-audio-process-tap".to_string(),
                    detail: "使用 Core Audio Process Tap，只捕获所选 SynthV 进程的输出。首次开始录制时，macOS 会请求系统音频录制权限。".to_string(),
                    max_clip_seconds: MAX_CLIP_SECONDS,
                }
            }
            Some((major, minor)) => AudioCaptureCapability {
                supported: false,
                backend: "unavailable".to_string(),
                detail: format!("当前 macOS {major}.{minor} 不支持 Core Audio Process Tap；需要 macOS 14.2 或更高版本。"),
                max_clip_seconds: MAX_CLIP_SECONDS,
            },
            None => AudioCaptureCapability {
                supported: false,
                backend: "unavailable".to_string(),
                detail: "无法确认 macOS 版本，已停用进程级音频捕获。".to_string(),
                max_clip_seconds: MAX_CLIP_SECONDS,
            },
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        AudioCaptureCapability {
            supported: false,
            backend: "unavailable".to_string(),
            detail: "当前构建尚未包含此平台的进程级音频捕获后端。".to_string(),
            max_clip_seconds: MAX_CLIP_SECONDS,
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_version() -> Option<(u32, u32)> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut parts = std::str::from_utf8(&output.stdout).ok()?.trim().split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
    ))
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .ok()?
        .get_value::<String, _>("CurrentBuildNumber")
        .ok()?
        .parse()
        .ok()
}

pub fn list_targets() -> Result<Vec<AudioCaptureTarget>, String> {
    platform::list_targets()
}

pub async fn capture_clip(
    manager: &McpManager,
    request: CaptureClipRequest,
) -> Result<CapturedClip, String> {
    validate_capture_request(&request)?;
    if !capability().supported {
        return Err(capability().detail);
    }
    let target = resolve_target(request.process_id)?;
    let session_before = synthv_unified::capture_status(manager, target.process_id).await?;
    let session_token = recursive_string(&session_before, "sessionToken").map(str::to_string);
    let playback_before = playback(manager, target.process_id, "status", None).await?;
    let status = recursive_string(&playback_before, "status").unwrap_or("unknown");
    if status != "stopped" {
        return Err(
            "SynthV 当前正在播放。为避免打断用户操作，片段捕获只会在 stopped 状态启动。"
                .to_string(),
        );
    }
    let original_playhead = recursive_f64(&playback_before, "playheadSeconds")
        .ok_or_else(|| "Bridge 没有返回当前播放头。".to_string())?;
    let play_from = (request.start_seconds - request.pre_roll_seconds).max(0.0);
    let actual_pre_roll = request.start_seconds - play_from;
    let play_until = request.end_seconds + request.post_roll_seconds;

    let output_dir = capture_output_dir()?;
    let file_stem = unique_capture_stem(&request.label);
    let raw_path = output_dir.join(format!("{file_stem}.raw.wav"));
    let output_path = output_dir.join(format!("{file_stem}.wav"));
    let metadata_path = output_dir.join(format!("{file_stem}.json"));

    playback(manager, target.process_id, "seek", Some(play_from)).await?;
    let raw_for_start = raw_path.clone();
    let process_id = target.process_id;
    let capture_start = tauri::async_runtime::spawn_blocking(move || {
        platform::NativeCapture::start(process_id, raw_for_start)
    })
    .await
    .map_err(|error| format!("无法启动音频捕获任务：{error}"))
    .and_then(|result| result);
    let mut capture = match capture_start {
        Ok(capture) => capture,
        Err(error) => {
            let _ = playback(manager, target.process_id, "seek", Some(original_playhead)).await;
            cleanup_capture_files(&[&raw_path]);
            return Err(error);
        }
    };
    let capture_armed_at = Instant::now();

    let play_call_started = Instant::now();
    let play_result = playback(manager, target.process_id, "play", None).await;
    let play_call_finished = Instant::now();
    if let Err(error) = play_result {
        capture.stop();
        let _ = tauri::async_runtime::spawn_blocking(move || capture.finish()).await;
        let _ = playback(manager, target.process_id, "stop", None).await;
        let _ = playback(manager, target.process_id, "seek", Some(original_playhead)).await;
        cleanup_capture_files(&[&raw_path]);
        return Err(error);
    }
    let call_roundtrip = play_call_finished.duration_since(play_call_started);
    let estimated_play_at = play_call_started + call_roundtrip / 2;

    let playback_deadline =
        Instant::now() + Duration::from_secs_f64((play_until - play_from).max(0.1) + 15.0);
    let playback_result = loop {
        if Instant::now() >= playback_deadline {
            break Err("等待 SynthV 播放到片段终点超时。".to_string());
        }
        tokio::time::sleep(PLAYBACK_POLL_INTERVAL).await;
        match playback(manager, target.process_id, "status", None).await {
            Ok(state) => {
                let state_status = recursive_string(&state, "status").unwrap_or("unknown");
                let playhead = recursive_f64(&state, "playheadSeconds").unwrap_or(play_from);
                if playhead + 0.002 >= play_until {
                    break Ok(());
                }
                if state_status == "stopped" {
                    break Err(format!(
                        "SynthV 在到达片段终点前停止播放（播放头 {playhead:.3} 秒）。"
                    ));
                }
            }
            Err(error) => break Err(error),
        }
    };

    let stop_result = playback(manager, target.process_id, "stop", None).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    capture.stop();
    let native_result = tauri::async_runtime::spawn_blocking(move || capture.finish())
        .await
        .map_err(|error| format!("等待音频捕获完成失败：{error}"))
        .and_then(|result| result);
    let restore_result =
        playback(manager, target.process_id, "seek", Some(original_playhead)).await;

    if let Err(error) = playback_result {
        cleanup_capture_files(&[&raw_path]);
        return Err(error);
    }
    if let Err(error) = stop_result {
        cleanup_capture_files(&[&raw_path]);
        return Err(error);
    }
    if let Err(error) = restore_result {
        cleanup_capture_files(&[&raw_path]);
        return Err(error);
    }
    let native = match native_result {
        Ok(result) => result,
        Err(error) => {
            cleanup_capture_files(&[&raw_path]);
            return Err(error);
        }
    };
    if native.discontinuities > 0 {
        cleanup_capture_files(&[&raw_path]);
        return Err(format!(
            "音频捕获检测到 {} 次数据中断；为避免错误 A/B 结论，本次片段已拒绝。",
            native.discontinuities
        ));
    }

    let session_after = match synthv_unified::capture_status(manager, target.process_id).await {
        Ok(status) => status,
        Err(error) => {
            cleanup_capture_files(&[&raw_path]);
            return Err(error);
        }
    };
    let final_session_token = recursive_string(&session_after, "sessionToken");
    if session_token.as_deref().is_some()
        && final_session_token.is_some()
        && session_token.as_deref() != final_session_token
    {
        cleanup_capture_files(&[&raw_path]);
        return Err("捕获过程中 SynthV/Bridge Session 已变化，片段上下文不再可信。".to_string());
    }

    let estimated_play_offset = estimated_play_at
        .checked_duration_since(capture_armed_at)
        .unwrap_or_default()
        .as_secs_f64();
    let crop_start = estimated_play_offset + actual_pre_roll;
    let requested_duration = request.end_seconds - request.start_seconds;
    let cropped = match read_wave(&raw_path)
        .and_then(|wave| crop_wave(&wave, crop_start, requested_duration))
    {
        Ok(cropped) => cropped,
        Err(error) => {
            cleanup_capture_files(&[&raw_path]);
            return Err(error);
        }
    };
    if let Err(error) = write_wave(&output_path, &cropped) {
        cleanup_capture_files(&[&raw_path, &output_path]);
        return Err(error);
    }
    cleanup_capture_files(&[&raw_path]);

    let metrics = metrics(&cropped);
    let sha256 = match sha256_file(&output_path) {
        Ok(sha256) => sha256,
        Err(error) => {
            cleanup_capture_files(&[&output_path]);
            return Err(error);
        }
    };
    let result = CapturedClip {
        output_path: output_path.to_string_lossy().into_owned(),
        metadata_path: metadata_path.to_string_lossy().into_owned(),
        process_id: target.process_id,
        process_name: target.name,
        session_token,
        requested_start_seconds: request.start_seconds,
        requested_end_seconds: request.end_seconds,
        actual_pre_roll_seconds: actual_pre_roll,
        sample_rate: cropped.sample_rate,
        channels: 1,
        bits_per_sample: 16,
        frames: cropped.samples.len() as u64,
        discontinuities: native.discontinuities,
        boundary_uncertainty_ms: call_roundtrip.as_secs_f64() * 500.0 + 10.0,
        sha256,
        metrics,
    };
    if let Err(error) = write_json_new(&metadata_path, &result) {
        cleanup_capture_files(&[&output_path, &metadata_path]);
        return Err(error);
    }
    Ok(result)
}

fn cleanup_capture_files(paths: &[&Path]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

pub fn compare_clips(request: CompareClipsRequest) -> Result<AbComparison, String> {
    if !request.max_lag_ms.is_finite() || !(0.0..=1000.0).contains(&request.max_lag_ms) {
        return Err("最大对齐偏移必须在 0–1000 ms 之间。".to_string());
    }
    let baseline_path = validate_wav_path(&request.baseline_path, "A")?;
    let candidate_path = validate_wav_path(&request.candidate_path, "B")?;
    let baseline = read_wave(&baseline_path)?;
    let candidate = read_wave(&candidate_path)?;
    if baseline.sample_rate != candidate.sample_rate {
        return Err("A/B 采样率不同；请使用同一捕获后端重新生成两个片段。".to_string());
    }
    if baseline.samples.len() < 480 || candidate.samples.len() < 480 {
        return Err("A/B 片段过短，至少需要 10 ms 音频。".to_string());
    }

    let max_lag_frames =
        ((request.max_lag_ms / 1000.0) * baseline.sample_rate as f64).round() as isize;
    let lag = estimate_lag(&baseline.samples, &candidate.samples, max_lag_frames);
    let (a_start, b_start, overlap) =
        aligned_overlap(baseline.samples.len(), candidate.samples.len(), lag);
    if overlap < (baseline.sample_rate as usize / 10) {
        return Err("A/B 对齐后的有效重叠不足 100 ms。".to_string());
    }
    let a = &baseline.samples[a_start..a_start + overlap];
    let b = &candidate.samples[b_start..b_start + overlap];
    let correlation = normalized_correlation(a, b);
    let delta_rms = rms_difference(a, b);
    let a_rms = rms(a);
    let b_rms = rms(b);
    let a_peak = peak(a);
    let b_peak = peak(b);
    let baseline_metrics = metrics(&baseline);
    let candidate_metrics = metrics(&candidate);
    let delta_rms_db = amplitude_db(delta_rms);
    let loudness_delta_db = amplitude_db(b_rms) - amplitude_db(a_rms);
    let peak_delta_db = amplitude_db(b_peak) - amplitude_db(a_peak);
    let clipping_delta_percent =
        (candidate_metrics.clipped_sample_ratio - baseline_metrics.clipped_sample_ratio) * 100.0;
    let high_frequency_delta_db =
        candidate_metrics.high_frequency_proxy_db - baseline_metrics.high_frequency_proxy_db;
    let similarity_percent = ((correlation + 1.0) * 50.0).clamp(0.0, 100.0);
    let classification = if correlation >= 0.999 && loudness_delta_db.abs() < 0.1 {
        "near-identical"
    } else if correlation >= 0.98 {
        "subtle-change"
    } else if correlation >= 0.8 {
        "material-change"
    } else {
        "large-change-or-misalignment"
    };

    Ok(AbComparison {
        baseline_path: baseline_path.to_string_lossy().into_owned(),
        candidate_path: candidate_path.to_string_lossy().into_owned(),
        sample_rate: baseline.sample_rate,
        aligned_lag_ms: lag as f64 * 1000.0 / baseline.sample_rate as f64,
        overlap_seconds: overlap as f64 / baseline.sample_rate as f64,
        correlation,
        delta_rms_db,
        loudness_delta_db,
        peak_delta_db,
        clipping_delta_percent,
        high_frequency_delta_db,
        similarity_percent,
        classification: classification.to_string(),
        baseline: baseline_metrics,
        candidate: candidate_metrics,
    })
}

pub struct ToolboxAudioToolExecutor {
    mcp: McpToolExecutor,
    manager: Arc<McpManager>,
    runtime: Handle,
    bridge_dir: PathBuf,
    resource_dir: PathBuf,
    components_dir: PathBuf,
    downloads: Arc<ComponentDownloadManager>,
    media_tasks: Arc<MediaTaskManager>,
    file_approvals: Arc<FileApprovalManager>,
    conversation_id: String,
    work_mode: AgentWorkMode,
    mode_state: std::sync::Mutex<ModeExecutionState>,
}

pub struct ToolboxAudioToolContext {
    pub(crate) manager: Arc<McpManager>,
    pub(crate) runtime: Handle,
    pub(crate) bridge_dir: PathBuf,
    pub(crate) resource_dir: PathBuf,
    pub(crate) components_dir: PathBuf,
    pub(crate) downloads: Arc<ComponentDownloadManager>,
    pub(crate) media_tasks: Arc<MediaTaskManager>,
    pub(crate) file_approvals: Arc<FileApprovalManager>,
    pub(crate) conversation_id: String,
    pub(crate) work_mode: AgentWorkMode,
}

#[derive(Default)]
struct ModeExecutionState {
    checkpoint_created: bool,
    project_mutations: u8,
}

impl ToolboxAudioToolExecutor {
    pub fn new(mcp: McpToolExecutor, context: ToolboxAudioToolContext) -> Self {
        Self {
            mcp,
            manager: context.manager,
            runtime: context.runtime,
            bridge_dir: context.bridge_dir,
            resource_dir: context.resource_dir,
            components_dir: context.components_dir,
            downloads: context.downloads,
            media_tasks: context.media_tasks,
            file_approvals: context.file_approvals,
            conversation_id: context.conversation_id,
            work_mode: context.work_mode,
            mode_state: std::sync::Mutex::new(ModeExecutionState::default()),
        }
    }

    fn local_tools(&self) -> Vec<ToolDefinition> {
        let mut tools = vec![ToolDefinition { name: "agent_file_list".to_string(), description: "List only path, type, size and decision for a directory. Never reads file content.".to_string(), input_schema_json: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}).to_string() }, ToolDefinition { name: "agent_file_access".to_string(), description: "Request access to one file. pass is immediate; ordinary Edit files require UI approval and cannot be approved by model arguments.".to_string(), input_schema_json: json!({"type":"object","properties":{"path":{"type":"string"},"purpose":{"type":"string"}},"required":["path","purpose"],"additionalProperties":false}).to_string() }, ToolDefinition {
            name: "compare_audio_clips".to_string(),
            description: "Fast local A/B comparison for two WAV clips. Aligns capture latency and returns only structured difference metrics; it never uploads or embeds audio.".to_string(),
            input_schema_json: json!({
                "type": "object",
                "properties": {
                    "baselinePath": { "type": "string", "description": "Absolute path to baseline A WAV." },
                    "candidatePath": { "type": "string", "description": "Absolute path to candidate B WAV." },
                    "maxLagMs": { "type": "number", "minimum": 0, "maximum": 1000, "default": 250 }
                },
                "required": ["baselinePath", "candidatePath"],
                "additionalProperties": false
            }).to_string(),
        }];
        tools.extend([
            ToolDefinition {
                name: "preview_media_source".to_string(),
                description: "Preview one explicit Bilibili/YouTube URL or BV identifier using the managed media-fetcher. It is read-only and never uses browser cookies or playlists.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "source": { "type": "string" } },
                    "required": ["source"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "import_media_audio".to_string(),
                description: "Queue one explicitly supplied Bilibili/YouTube source for a cancellable managed WAV import. rightsConfirmed must be true. Returns a persisted media task.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "source": { "type": "string" },
                        "rightsConfirmed": { "type": "boolean" }
                    },
                    "required": ["source", "rightsConfirmed"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "list_media_tasks".to_string(),
                description: "List persisted media import and processing tasks.".to_string(),
                input_schema_json: json!({ "type": "object", "additionalProperties": false }).to_string(),
            },
            ToolDefinition {
                name: "cancel_media_task".to_string(),
                description: "Cancel a queued or running media task. Running child process trees are terminated.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "taskId": { "type": "string", "format": "uuid" } },
                    "required": ["taskId"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "retry_media_task".to_string(),
                description: "Retry one failed or cancelled media task from its persisted request.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "taskId": { "type": "string", "format": "uuid" } },
                    "required": ["taskId"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "create_cover_from_source".to_string(),
                description: "Queue the full cancellable Cover pipeline for one Bilibili BV/URL or YouTube URL: managed audio import, vocal/instrumental separation, melody MIDI extraction, optional lyric mapping, automatic F13 Bridge connection, and import into the current SynthV project. The requested voice name is recorded and reported, but SynthV's official scripting API cannot assign singer identity.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "source": { "type": "string" },
                        "lyrics": { "type": ["string", "null"] },
                        "voiceName": { "type": "string" },
                        "processId": { "type": ["integer", "null"], "minimum": 1 },
                        "trackIndex": { "type": "integer", "minimum": 1, "maximum": 10000, "default": 1 },
                        "groupName": { "type": "string", "maxLength": 200, "default": "Toolbox Cover" },
                        "rightsConfirmed": { "type": "boolean" },
                        "tolerance": { "type": "number", "minimum": 0.02, "maximum": 0.25, "default": 0.08 },
                        "advanced": { "type": "boolean", "default": true }
                    },
                    "required": ["source", "voiceName", "trackIndex", "groupName", "rightsConfirmed", "tolerance", "advanced"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "create_cover_from_audio".to_string(),
                description: "Queue the same cancellable Cover pipeline from an existing audio file inside the Toolbox managed data directory. Use this after an explicitly authorized platform download has already produced local audio.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "audioPath": { "type": "string" },
                        "lyrics": { "type": ["string", "null"] },
                        "voiceName": { "type": "string" },
                        "processId": { "type": ["integer", "null"], "minimum": 1 },
                        "trackIndex": { "type": "integer", "minimum": 1, "maximum": 10000, "default": 1 },
                        "groupName": { "type": "string", "maxLength": 200, "default": "Toolbox Cover" },
                        "rightsConfirmed": { "type": "boolean" },
                        "tolerance": { "type": "number", "minimum": 0.02, "maximum": 0.25, "default": 0.08 },
                        "advanced": { "type": "boolean", "default": true }
                    },
                    "required": ["audioPath", "voiceName", "trackIndex", "groupName", "rightsConfirmed", "tolerance", "advanced"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "create_project_checkpoint".to_string(),
                description: "Create a recoverable managed copy of one saved .svp project before autonomous mutations.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "projectPath": { "type": "string" },
                        "label": { "type": "string", "maxLength": 100 }
                    },
                    "required": ["projectPath", "label"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "learn_tuning_from_source".to_string(),
                description: "Analyze one local reference vocal offline and update the isolated tuning profile for an exact voice-library name.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "audioPath": { "type": "string" },
                        "voiceName": { "type": "string", "maxLength": 200 }
                    },
                    "required": ["audioPath", "voiceName"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "list_tuning_profiles".to_string(),
                description: "List every local per-voice tuning profile and its source/A-B sample counts.".to_string(),
                input_schema_json: json!({ "type": "object", "additionalProperties": false }).to_string(),
            },
            ToolDefinition {
                name: "record_tuning_outcome".to_string(),
                description: "Update one voice-specific profile from a bounded A/B improvement score after comparing a candidate.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "voiceName": { "type": "string" },
                        "candidate": { "type": "object", "properties": {
                            "loudness": { "type": "number", "minimum": -48, "maximum": 12 },
                            "tension": { "type": "number", "minimum": -1, "maximum": 1 },
                            "breathiness": { "type": "number", "minimum": -1, "maximum": 1 },
                            "gender": { "type": "number", "minimum": -1, "maximum": 1 },
                            "toneShift": { "type": "number", "minimum": -1, "maximum": 1 },
                            "vibratoStrength": { "type": "number", "minimum": 0, "maximum": 2 }
                        }, "required": ["loudness", "tension", "breathiness", "gender", "toneShift", "vibratoStrength"], "additionalProperties": false },
                        "improvement": { "type": "number", "minimum": -1, "maximum": 1 }
                    },
                    "required": ["voiceName", "candidate", "improvement"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "apply_learned_tuning".to_string(),
                description: "Apply one voice-specific learned Group Voice profile to a fingerprint-guarded SynthV group. This changes parameters, never singer identity.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "voiceName": { "type": "string" },
                        "trackIndex": { "type": "integer", "minimum": 1 },
                        "groupIndex": { "type": "integer", "minimum": 1, "default": 1 }
                    },
                    "required": ["voiceName", "trackIndex", "groupIndex"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "run_solo_tuning".to_string(),
                description: "Run one bounded Solo tuning round: checkpoint, baseline capture, learned profile application, candidate capture, source-feature scoring, save on improvement or verified Undo on regression. Windows process loopback or macOS 14.2+ Process Tap capture is required.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "referenceAudioPath": { "type": "string" },
                        "voiceName": { "type": "string" },
                        "projectPath": { "type": "string" },
                        "processId": { "type": "integer", "minimum": 1 },
                        "trackIndex": { "type": "integer", "minimum": 1 },
                        "groupIndex": { "type": "integer", "minimum": 1 },
                        "startSeconds": { "type": "number", "minimum": 0 },
                        "endSeconds": { "type": "number", "exclusiveMinimum": 0 }
                    },
                    "required": ["referenceAudioPath", "voiceName", "projectPath", "processId", "trackIndex", "groupIndex", "startSeconds", "endSeconds"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "separate_vocals_and_instrumental".to_string(),
                description: "Queue a cancellable managed Demucs separation for one local audio file. Returns a persisted media task; use list_media_tasks to observe vocals.wav and instrumental.wav outputs.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "audioPath": { "type": "string" } },
                    "required": ["audioPath"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "list_managed_components".to_string(),
                description: "List managed local components and their installation status.".to_string(),
                input_schema_json: json!({ "type": "object", "additionalProperties": false }).to_string(),
            },
            ToolDefinition {
                name: "list_component_tasks".to_string(),
                description: "List persisted component installation tasks and their current status.".to_string(),
                input_schema_json: json!({ "type": "object", "additionalProperties": false }).to_string(),
            },
            ToolDefinition {
                name: "queue_component_install".to_string(),
                description: "Queue one allowlisted managed component for serial installation.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "componentId": { "type": "string", "enum": ["ffmpeg", "pi-audio", "cvrs", "media-fetcher", "vocal-separation", "sandboxie"] } },
                    "required": ["componentId"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "cancel_component_task".to_string(),
                description: "Cancel a component task only while it is still queued and has not started changing files.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "taskId": { "type": "string", "format": "uuid" } },
                    "required": ["taskId"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "retry_component_task".to_string(),
                description: "Retry one failed or cancelled persisted component task.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "taskId": { "type": "string", "format": "uuid" } },
                    "required": ["taskId"],
                    "additionalProperties": false
                }).to_string(),
            },
        ]);
        tools.extend(synthv_unified::definitions());
        if capability().supported {
            tools.push(ToolDefinition {
                name: "capture_synthv_clip".to_string(),
                description: "Capture a short range from the connected SynthV standalone instance through process-only loopback. The tool atomically seeks, plays, stops, restores the playhead, validates capture continuity, and returns a managed WAV path plus fast metrics.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "processId": { "type": "integer", "minimum": 1, "description": "Required only when multiple SynthV instances are running." },
                        "startSeconds": { "type": "number", "minimum": 0 },
                        "endSeconds": { "type": "number", "exclusiveMinimum": 0 },
                        "preRollSeconds": { "type": "number", "minimum": 0, "maximum": 2, "default": 0.4 },
                        "postRollSeconds": { "type": "number", "minimum": 0, "maximum": 2, "default": 0.25 },
                        "label": { "type": "string", "maxLength": 40 }
                    },
                    "required": ["startSeconds", "endSeconds"],
                    "additionalProperties": false
                }).to_string(),
            });
        }
        tools
    }

    fn execute_local(&self, call: &ToolCall) -> Option<ToolResult> {
        let result = match call.tool_name.as_str() {
            "agent_file_list" => Some(
                serde_json::from_str::<AgentFileListRequest>(&call.arguments_json)
                    .map_err(|e| e.to_string())
                    .and_then(|r| self.file_approvals.list(&r.path, self.work_mode))
                    .and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string())),
            ),
            "agent_file_access" => Some(
                serde_json::from_str::<AgentFileAccessRequest>(&call.arguments_json)
                    .map_err(|e| e.to_string())
                    .and_then(|r| {
                        self.file_approvals.admit_or_request(
                            &r.path,
                            &r.purpose,
                            self.work_mode,
                            &self.conversation_id,
                        )
                    })
                    .and_then(|value| serde_json::to_string(&value).map_err(|e| e.to_string())),
            ),
            name if synthv_unified::is_tool(name) => Some((|| {
                if synthv_unified::is_mutation(name) {
                    self.admit_project_mutation()?;
                }
                let value = self.runtime.block_on(synthv_unified::execute(
                    name,
                    &call.arguments_json,
                    &self.manager,
                    &self.bridge_dir,
                ))?;
                serde_json::to_string(&value).map_err(|error| error.to_string())
            })()),
            "preview_media_source" => Some(
                serde_json::from_str::<MediaSourceToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("媒体来源参数无效：{error}"))
                    .and_then(|request| media_import::preview(&request.source))
                    .and_then(|value| {
                        serde_json::to_string(&value).map_err(|error| error.to_string())
                    }),
            ),
            "import_media_audio" => Some(
                serde_json::from_str::<MediaSourceToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("媒体导入参数无效：{error}"))
                    .and_then(|request| {
                        let (snapshot, start_worker) = self
                            .media_tasks
                            .enqueue_import(request.source, request.rights_confirmed)?;
                        self.start_media_worker(start_worker);
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "list_media_tasks" => Some(
                serde_json::to_string(&self.media_tasks.snapshot())
                    .map_err(|error| error.to_string()),
            ),
            "cancel_media_task" => Some(
                serde_json::from_str::<TaskIdRequest>(&call.arguments_json)
                    .map_err(|error| format!("媒体任务参数无效：{error}"))
                    .and_then(|request| self.media_tasks.cancel(&request.task_id))
                    .and_then(|snapshot| {
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "retry_media_task" => Some(
                serde_json::from_str::<TaskIdRequest>(&call.arguments_json)
                    .map_err(|error| format!("媒体任务参数无效：{error}"))
                    .and_then(|request| self.media_tasks.retry(&request.task_id))
                    .and_then(|(snapshot, start_worker)| {
                        self.start_media_worker(start_worker);
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "create_cover_from_source" => Some(
                serde_json::from_str::<CoverTaskRequest>(&call.arguments_json)
                    .map_err(|error| format!("Cover 任务参数无效：{error}"))
                    .and_then(|request| self.media_tasks.enqueue_cover(request))
                    .and_then(|(snapshot, start_worker)| {
                        self.start_media_worker(start_worker);
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "create_cover_from_audio" => Some(
                serde_json::from_str::<LocalCoverTaskRequest>(&call.arguments_json)
                    .map_err(|error| format!("本地 Cover 任务参数无效：{error}"))
                    .and_then(|request| self.media_tasks.enqueue_cover(request.into()))
                    .and_then(|(snapshot, start_worker)| {
                        self.start_media_worker(start_worker);
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "create_project_checkpoint" => Some(
                serde_json::from_str::<CheckpointToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("检查点参数无效：{error}"))
                    .and_then(|request| {
                        let checkpoint = creative_history::create_checkpoint(
                            &request.project_path,
                            &request.label,
                        )?;
                        if let Ok(mut state) = self.mode_state.lock() {
                            state.checkpoint_created = true;
                        }
                        serde_json::to_string(&checkpoint).map_err(|error| error.to_string())
                    }),
            ),
            "learn_tuning_from_source" => Some(
                serde_json::from_str::<LearnTuningToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("调声学习参数无效：{error}"))
                    .and_then(|request| {
                        let features =
                            workflows::source_style(request.audio_path, &self.resource_dir)?;
                        tuning_profiles::learn(&request.voice_name, features)
                    })
                    .and_then(|profile| {
                        serde_json::to_string(&profile).map_err(|error| error.to_string())
                    }),
            ),
            "list_tuning_profiles" => Some(tuning_profiles::list().and_then(|profiles| {
                serde_json::to_string(&profiles).map_err(|error| error.to_string())
            })),
            "record_tuning_outcome" => Some(
                serde_json::from_str::<TuningOutcomeToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("调声反馈参数无效：{error}"))
                    .and_then(|request| {
                        tuning_profiles::record_outcome(
                            &request.voice_name,
                            request.candidate,
                            request.improvement,
                        )
                    })
                    .and_then(|profile| {
                        serde_json::to_string(&profile).map_err(|error| error.to_string())
                    }),
            ),
            "apply_learned_tuning" => Some(
                serde_json::from_str::<ApplyTuningToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("调声应用参数无效：{error}"))
                    .and_then(|request| {
                        self.admit_project_mutation()?;
                        let connected_profiles = self.runtime.block_on(async {
                            let hosts = self.manager.connected_synthv_hosts().await;
                            let mut profiles = Vec::with_capacity(hosts.len());
                            for host_id in hosts.keys() {
                                if let Some(profile) =
                                    self.manager.synthv_connection_profile(host_id).await
                                {
                                    profiles.push(profile);
                                }
                            }
                            profiles
                        });
                        if !connected_profiles.is_empty()
                            && !connected_profiles
                                .contains(&SynthVConnectionProfile::OfficialBridge)
                        {
                            return Err("当前已连接的 SynthV 宿主不支持调校参数写入。".to_string());
                        }
                        let profile = tuning_profiles::get(&request.voice_name)?;
                        self.runtime
                            .block_on(bridge_workflows::apply_tuning_profile(
                                &self.manager,
                                &profile,
                                request.track_index,
                                request.group_index,
                            ))
                    })
                    .and_then(|result| {
                        serde_json::to_string(&result).map_err(|error| error.to_string())
                    }),
            ),
            "run_solo_tuning" => Some(
                serde_json::from_str::<SoloTuningRequest>(&call.arguments_json)
                    .map_err(|error| format!("Solo 调声参数无效：{error}"))
                    .and_then(|request| {
                        self.runtime.block_on(solo_tuning::run(
                            request,
                            self.work_mode,
                            &self.manager,
                            &self.resource_dir,
                        ))
                    })
                    .and_then(|result| {
                        serde_json::to_string(&result).map_err(|error| error.to_string())
                    }),
            ),
            "separate_vocals_and_instrumental" => Some(
                serde_json::from_str::<AudioPathToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("分离参数无效：{error}"))
                    .and_then(|request| {
                        let (snapshot, start_worker) =
                            self.media_tasks.enqueue_separation(request.audio_path)?;
                        self.start_media_worker(start_worker);
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "list_managed_components" => Some(
                serde_json::to_string(&component_list(&self.resource_dir))
                    .map_err(|error| error.to_string()),
            ),
            "list_component_tasks" => Some(
                serde_json::to_string(&self.downloads.snapshot())
                    .map_err(|error| error.to_string()),
            ),
            "queue_component_install" => Some(
                serde_json::from_str::<ComponentTaskRequest>(&call.arguments_json)
                    .map_err(|error| format!("组件任务参数无效：{error}"))
                    .and_then(|request| {
                        let (snapshot, start_worker) =
                            self.downloads.enqueue(&request.component_id)?;
                        self.start_component_worker(start_worker);
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "cancel_component_task" => Some(
                serde_json::from_str::<TaskIdRequest>(&call.arguments_json)
                    .map_err(|error| format!("组件任务参数无效：{error}"))
                    .and_then(|request| self.downloads.cancel_queued(&request.task_id))
                    .and_then(|snapshot| {
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "retry_component_task" => Some(
                serde_json::from_str::<TaskIdRequest>(&call.arguments_json)
                    .map_err(|error| format!("组件任务参数无效：{error}"))
                    .and_then(|request| self.downloads.retry(&request.task_id))
                    .and_then(|(snapshot, start_worker)| {
                        self.start_component_worker(start_worker);
                        serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                    }),
            ),
            "capture_synthv_clip" => Some(
                serde_json::from_str::<CaptureClipRequest>(&call.arguments_json)
                    .map_err(|error| format!("片段捕获参数无效：{error}"))
                    .and_then(|request| self.runtime.block_on(capture_clip(&self.manager, request)))
                    .and_then(|value| {
                        serde_json::to_string(&value).map_err(|error| error.to_string())
                    }),
            ),
            "compare_audio_clips" => Some(
                serde_json::from_str::<CompareClipsRequest>(&call.arguments_json)
                    .map_err(|error| format!("A/B 比较参数无效：{error}"))
                    .and_then(compare_clips)
                    .and_then(|value| {
                        serde_json::to_string(&value).map_err(|error| error.to_string())
                    }),
            ),
            _ => None,
        }?;
        Some(match result {
            Ok(result_json) => ToolResult {
                tool_call_id: call.id.clone(),
                result_json,
                is_error: false,
            },
            Err(error) => ToolResult {
                tool_call_id: call.id.clone(),
                result_json: json!({ "error": error }).to_string(),
                is_error: true,
            },
        })
    }

    fn start_component_worker(&self, start_worker: bool) {
        if !start_worker {
            return;
        }
        let manager = self.downloads.clone();
        let components_dir = self.components_dir.clone();
        let resource_dir = self.resource_dir.clone();
        self.runtime.spawn(async move {
            manager.run_worker(components_dir, resource_dir).await;
        });
    }

    fn start_media_worker(&self, start_worker: bool) {
        if !start_worker {
            return;
        }
        let manager = self.media_tasks.clone();
        self.runtime.spawn(async move {
            manager.run_worker().await;
        });
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaSourceToolRequest {
    source: String,
    #[serde(default)]
    rights_confirmed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalCoverTaskRequest {
    audio_path: String,
    lyrics: Option<String>,
    voice_name: String,
    process_id: Option<u32>,
    track_index: u32,
    group_name: String,
    rights_confirmed: bool,
    tolerance: f64,
    advanced: bool,
}

impl From<LocalCoverTaskRequest> for CoverTaskRequest {
    fn from(request: LocalCoverTaskRequest) -> Self {
        Self {
            source: request.audio_path,
            lyrics: request.lyrics,
            voice_name: request.voice_name,
            process_id: request.process_id,
            track_index: request.track_index,
            group_name: request.group_name,
            rights_confirmed: request.rights_confirmed,
            tolerance: request.tolerance,
            advanced: request.advanced,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioPathToolRequest {
    audio_path: String,
}

#[derive(Debug, Deserialize)]
struct AgentFileListRequest {
    path: String,
}
#[derive(Debug, Deserialize)]
struct AgentFileAccessRequest {
    path: String,
    purpose: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentTaskRequest {
    component_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdRequest {
    task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointToolRequest {
    project_path: String,
    label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LearnTuningToolRequest {
    audio_path: String,
    voice_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TuningOutcomeToolRequest {
    voice_name: String,
    candidate: TuningParameters,
    improvement: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyTuningToolRequest {
    voice_name: String,
    track_index: u32,
    group_index: u32,
}

impl ToolExecutor for ToolboxAudioToolExecutor {
    fn tools(&self) -> Vec<ToolDefinition> {
        let mut tools = self.mcp.tools();
        tools.extend(self.local_tools());
        tools
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, AgentError> {
        if !matches!(
            call.tool_name.as_str(),
            "agent_file_list" | "agent_file_access"
        ) {
            if let Ok(value) = serde_json::from_str::<Value>(&call.arguments_json) {
                if let Err(error) = admit_paths(
                    &value,
                    &self.file_approvals,
                    self.work_mode,
                    &self.conversation_id,
                    &call.tool_name,
                ) {
                    return Ok(ToolResult {
                        tool_call_id: call.id.clone(),
                        result_json: json!({"error":error}).to_string(),
                        is_error: true,
                    });
                }
            }
        }
        if let Some(result) = self.execute_local(call) {
            Ok(result)
        } else {
            if call.tool_name == "sv_command" {
                if let Err(error) = self.admit_project_mutation() {
                    return Ok(ToolResult {
                        tool_call_id: call.id.clone(),
                        result_json: json!({ "error": error }).to_string(),
                        is_error: true,
                    });
                }
            }
            self.mcp.execute(call)
        }
    }
}

fn admit_paths(
    value: &Value,
    approvals: &FileApprovalManager,
    mode: AgentWorkMode,
    conversation_id: &str,
    tool_name: &str,
) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                if crate::agent_files::is_path_key(key) {
                    if let Some(path) = item.as_str() {
                        let decision = approvals.admit_or_request(
                            path,
                            &format!("{tool_name} 工具访问文件"),
                            mode,
                            conversation_id,
                        )?;
                        if decision.decision != "pass" {
                            return Err(format!(
                                "文件需要人工批准；requestId={}",
                                decision.request_id.unwrap_or_default()
                            ));
                        }
                    }
                }
                admit_paths(item, approvals, mode, conversation_id, tool_name)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                admit_paths(item, approvals, mode, conversation_id, tool_name)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl ToolboxAudioToolExecutor {
    fn admit_project_mutation(&self) -> Result<(), String> {
        let mut state = self
            .mode_state
            .lock()
            .map_err(|_| "Agent 工作模式状态锁已损坏。".to_string())?;
        match self.work_mode {
            AgentWorkMode::Edit if state.project_mutations >= 1 => {
                return Err("Edit 模式每轮只允许一次 SynthV 项目修改。".to_string())
            }
            AgentWorkMode::Solo if !state.checkpoint_created => {
                return Err(
                    "Solo 模式修改 SynthV 前必须先调用 create_project_checkpoint。".to_string(),
                )
            }
            AgentWorkMode::Solo if state.project_mutations >= 8 => {
                return Err("Solo 模式每轮最多执行八次 SynthV 项目修改。".to_string())
            }
            _ => {}
        }
        state.project_mutations += 1;
        Ok(())
    }
}

fn validate_capture_request(request: &CaptureClipRequest) -> Result<(), String> {
    for (label, value) in [
        ("起点", request.start_seconds),
        ("终点", request.end_seconds),
        ("前置保护区", request.pre_roll_seconds),
        ("后置保护区", request.post_roll_seconds),
    ] {
        if !value.is_finite() {
            return Err(format!("{label}必须是有限数字。"));
        }
    }
    if request.start_seconds < 0.0 || request.end_seconds <= request.start_seconds {
        return Err("片段终点必须大于非负起点。".to_string());
    }
    if request.end_seconds - request.start_seconds > MAX_CLIP_SECONDS {
        return Err(format!("片段最长为 {MAX_CLIP_SECONDS:.0} 秒。"));
    }
    if !(0.0..=MAX_GUARD_SECONDS).contains(&request.pre_roll_seconds)
        || !(0.0..=MAX_GUARD_SECONDS).contains(&request.post_roll_seconds)
    {
        return Err(format!(
            "前后保护区必须在 0–{MAX_GUARD_SECONDS:.0} 秒之间。"
        ));
    }
    if request.label.chars().count() > 40 {
        return Err("片段标签不能超过 40 个字符。".to_string());
    }
    Ok(())
}

fn resolve_target(process_id: Option<u32>) -> Result<AudioCaptureTarget, String> {
    let targets = list_targets()?;
    if let Some(process_id) = process_id {
        return targets
            .into_iter()
            .find(|target| target.process_id == process_id)
            .ok_or_else(|| format!("没有找到 PID {process_id} 对应的 SynthV standalone 进程。"));
    }
    match targets.as_slice() {
        [] => Err("没有发现正在运行的 SynthV standalone 进程。".to_string()),
        [target] => Ok(target.clone()),
        _ => Err(format!(
            "发现多个 SynthV 实例，请明确选择 PID：{}",
            targets
                .iter()
                .map(|target| format!("{} ({})", target.process_id, target.name))
                .collect::<Vec<_>>()
                .join("、")
        )),
    }
}

async fn playback(
    manager: &McpManager,
    process_id: u32,
    operation: &str,
    time_seconds: Option<f64>,
) -> Result<Value, String> {
    synthv_unified::capture_playback(manager, process_id, operation, time_seconds).await
}

fn recursive_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    match value {
        Value::Object(object) => object.get(key).and_then(Value::as_str).or_else(|| {
            object
                .values()
                .find_map(|value| recursive_string(value, key))
        }),
        Value::Array(items) => items.iter().find_map(|value| recursive_string(value, key)),
        _ => None,
    }
}

fn recursive_f64(value: &Value, key: &str) -> Option<f64> {
    match value {
        Value::Object(object) => object
            .get(key)
            .and_then(Value::as_f64)
            .or_else(|| object.values().find_map(|value| recursive_f64(value, key))),
        Value::Array(items) => items.iter().find_map(|value| recursive_f64(value, key)),
        _ => None,
    }
}

fn capture_output_dir() -> Result<PathBuf, String> {
    let directory = crate::agent::output_dir().join("ab-captures");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建 A/B 片段输出目录：{error}"))?;
    Ok(directory)
}

fn unique_capture_stem(label: &str) -> String {
    let safe_label = label
        .trim()
        .chars()
        .take(40)
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let label = if safe_label.is_empty() {
        "clip".to_string()
    } else {
        safe_label
    };
    let unique = Uuid::new_v4().simple().to_string();
    format!(
        "{}-{}-{}",
        Utc::now().format("%Y%m%d-%H%M%S"),
        label,
        &unique[..8]
    )
}

fn validate_wav_path(value: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_file() {
        return Err(format!("{label} 片段不存在：{}", path.display()));
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"))
    {
        return Err(format!("{label} 片段必须是 WAV。"));
    }
    Ok(path)
}

#[derive(Debug, Clone)]
struct MonoWave {
    sample_rate: u32,
    samples: Vec<f32>,
}

fn read_wave(path: &Path) -> Result<MonoWave, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取 WAV 元数据：{error}"))?;
    if metadata.len() > MAX_WAV_BYTES {
        return Err("WAV 超过 128 MiB 快速比较限制。".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("无法读取 WAV：{error}"))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("输入不是有效的 RIFF/WAVE 文件。".to_string());
    }
    let mut cursor = 12usize;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data_range: Option<(usize, usize)> = None;
    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = u32::from_le_bytes(bytes[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
        let start = cursor + 8;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "WAV chunk 长度越界。".to_string())?;
        if id == b"fmt " {
            if size < 16 {
                return Err("WAV fmt chunk 过短。".to_string());
            }
            format = Some((
                u16::from_le_bytes(bytes[start..start + 2].try_into().unwrap()),
                u16::from_le_bytes(bytes[start + 2..start + 4].try_into().unwrap()),
                u32::from_le_bytes(bytes[start + 4..start + 8].try_into().unwrap()),
                u16::from_le_bytes(bytes[start + 14..start + 16].try_into().unwrap()),
            ));
        } else if id == b"data" {
            data_range = Some((start, end));
        }
        cursor = end + (size & 1);
    }
    let (format_tag, channels, sample_rate, bits) =
        format.ok_or_else(|| "WAV 缺少 fmt chunk。".to_string())?;
    let (data_start, data_end) = data_range.ok_or_else(|| "WAV 缺少 data chunk。".to_string())?;
    if channels == 0 || channels > 32 || !(8_000..=384_000).contains(&sample_rate) {
        return Err("WAV 声道数或采样率不受支持。".to_string());
    }
    let bytes_per_sample = match (format_tag, bits) {
        (WAVE_FORMAT_PCM, 16) => 2,
        (WAVE_FORMAT_IEEE_FLOAT, 32) => 4,
        _ => return Err("快速 A/B 当前支持 PCM16 或 IEEE float32 WAV。".to_string()),
    };
    let frame_bytes = channels as usize * bytes_per_sample;
    let frame_count = (data_end - data_start) / frame_bytes;
    if frame_count == 0 {
        return Err("WAV 没有音频帧。".to_string());
    }
    let mut samples = Vec::with_capacity(frame_count);
    for frame in 0..frame_count {
        let frame_start = data_start + frame * frame_bytes;
        let mut sum = 0.0f32;
        for channel in 0..channels as usize {
            let offset = frame_start + channel * bytes_per_sample;
            sum += if format_tag == WAVE_FORMAT_PCM {
                i16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) as f32 / 32768.0
            } else {
                f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
            };
        }
        samples.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
    Ok(MonoWave {
        sample_rate,
        samples,
    })
}

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

fn crop_wave(
    wave: &MonoWave,
    start_seconds: f64,
    duration_seconds: f64,
) -> Result<MonoWave, String> {
    let start = (start_seconds * wave.sample_rate as f64).round().max(0.0) as usize;
    let frames = (duration_seconds * wave.sample_rate as f64)
        .round()
        .max(1.0) as usize;
    let end = start.saturating_add(frames);
    if end > wave.samples.len() {
        return Err(format!(
            "捕获音频长度不足：需要到 {:.3} 秒，实际只有 {:.3} 秒。",
            end as f64 / wave.sample_rate as f64,
            wave.samples.len() as f64 / wave.sample_rate as f64
        ));
    }
    Ok(MonoWave {
        sample_rate: wave.sample_rate,
        samples: wave.samples[start..end].to_vec(),
    })
}

fn write_wave(path: &Path, wave: &MonoWave) -> Result<(), String> {
    let data_size = wave
        .samples
        .len()
        .checked_mul(2)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "WAV 数据超过 RIFF 限制。".to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("无法创建片段 WAV：{error}"))?;
    file.write_all(b"RIFF").map_err(|error| error.to_string())?;
    file.write_all(&(36 + data_size).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(b"WAVEfmt ")
        .map_err(|error| error.to_string())?;
    file.write_all(&16u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&WAVE_FORMAT_PCM.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&1u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&wave.sample_rate.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&(wave.sample_rate * 2).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&2u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&16u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(b"data").map_err(|error| error.to_string())?;
    file.write_all(&data_size.to_le_bytes())
        .map_err(|error| error.to_string())?;
    for sample in &wave.samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        file.write_all(&value.to_le_bytes())
            .map_err(|error| format!("无法写入片段 WAV：{error}"))?;
    }
    file.flush()
        .map_err(|error| format!("无法提交片段 WAV：{error}"))
}

fn write_json_new(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("无法创建片段元数据：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .map_err(|error| format!("无法写入片段元数据：{error}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn metrics(wave: &MonoWave) -> ClipMetrics {
    let peak_value = peak(&wave.samples);
    let rms_value = rms(&wave.samples);
    let clipped = wave
        .samples
        .iter()
        .filter(|sample| sample.abs() >= 0.999)
        .count();
    let silent = wave
        .samples
        .iter()
        .filter(|sample| sample.abs() <= 0.000_1)
        .count();
    let high_frequency = if wave.samples.len() > 1 {
        let energy = wave
            .samples
            .windows(2)
            .map(|window| {
                let difference = (window[1] - window[0]) as f64;
                difference * difference
            })
            .sum::<f64>()
            / (wave.samples.len() - 1) as f64;
        energy.sqrt()
    } else {
        0.0
    };
    ClipMetrics {
        duration_seconds: wave.samples.len() as f64 / wave.sample_rate as f64,
        peak_dbfs: amplitude_db(peak_value),
        rms_dbfs: amplitude_db(rms_value),
        clipped_sample_ratio: clipped as f64 / wave.samples.len() as f64,
        silent_sample_ratio: silent as f64 / wave.samples.len() as f64,
        high_frequency_proxy_db: amplitude_db(high_frequency),
    }
}

fn peak(samples: &[f32]) -> f64 {
    samples
        .iter()
        .map(|sample| sample.abs() as f64)
        .fold(0.0, f64::max)
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples
        .iter()
        .map(|sample| (*sample as f64) * (*sample as f64))
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt()
}

fn rms_difference(a: &[f32], b: &[f32]) -> f64 {
    (a.iter()
        .zip(b)
        .map(|(a, b)| {
            let difference = *a as f64 - *b as f64;
            difference * difference
        })
        .sum::<f64>()
        / a.len().max(1) as f64)
        .sqrt()
}

fn amplitude_db(value: f64) -> f64 {
    20.0 * value.max(1.0e-9).log10()
}

fn estimate_lag(a: &[f32], b: &[f32], max_lag: isize) -> isize {
    let available_limit = (a.len().min(b.len()) / 4).max(1) as isize;
    let max_lag = max_lag.abs().min(available_limit);
    let lag_step = 8isize;
    let mut best_coarse = 0isize;
    let mut best_score = f64::NEG_INFINITY;
    let mut lag = -max_lag;
    while lag <= max_lag {
        let score = fixed_lag_correlation(a, b, lag, max_lag as usize, 16);
        if score > best_score {
            best_score = score;
            best_coarse = lag;
        }
        lag += lag_step;
    }
    let mut best_lag = best_coarse;
    best_score = f64::NEG_INFINITY;
    for lag in (best_coarse - lag_step).max(-max_lag)..=(best_coarse + lag_step).min(max_lag) {
        let score = fixed_lag_correlation(a, b, lag, max_lag as usize, 2);
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    best_lag
}

fn fixed_lag_correlation(a: &[f32], b: &[f32], lag: isize, margin: usize, step: usize) -> f64 {
    let end = a.len().min(b.len()).saturating_sub(margin);
    if end <= margin + 16 {
        return f64::NEG_INFINITY;
    }
    let available = end - margin;
    let limit = available.min(5 * 48_000);
    let mut sum_a = 0.0;
    let mut sum_b = 0.0;
    let mut sum_aa = 0.0;
    let mut sum_bb = 0.0;
    let mut sum_ab = 0.0;
    let mut count = 0usize;
    for offset in (0..limit).step_by(step.max(1)) {
        let a_index = margin + offset;
        let b_index = (a_index as isize + lag) as usize;
        let left = a[a_index] as f64;
        let right = b[b_index] as f64;
        sum_a += left;
        sum_b += right;
        sum_aa += left * left;
        sum_bb += right * right;
        sum_ab += left * right;
        count += 1;
    }
    pearson_from_sums(sum_a, sum_b, sum_aa, sum_bb, sum_ab, count)
}

fn normalized_correlation(a: &[f32], b: &[f32]) -> f64 {
    let mut sum_a = 0.0;
    let mut sum_b = 0.0;
    let mut sum_aa = 0.0;
    let mut sum_bb = 0.0;
    let mut sum_ab = 0.0;
    for (left, right) in a.iter().zip(b) {
        let left = *left as f64;
        let right = *right as f64;
        sum_a += left;
        sum_b += right;
        sum_aa += left * left;
        sum_bb += right * right;
        sum_ab += left * right;
    }
    pearson_from_sums(sum_a, sum_b, sum_aa, sum_bb, sum_ab, a.len())
}

fn pearson_from_sums(
    sum_a: f64,
    sum_b: f64,
    sum_aa: f64,
    sum_bb: f64,
    sum_ab: f64,
    count: usize,
) -> f64 {
    if count == 0 {
        return 0.0;
    }
    let count = count as f64;
    let numerator = sum_ab - sum_a * sum_b / count;
    let denominator = ((sum_aa - sum_a * sum_a / count).max(0.0)
        * (sum_bb - sum_b * sum_b / count).max(0.0))
    .sqrt();
    if denominator <= 1.0e-12 {
        0.0
    } else {
        (numerator / denominator).clamp(-1.0, 1.0)
    }
}

fn aligned_overlap(a_len: usize, b_len: usize, lag: isize) -> (usize, usize, usize) {
    let (a_start, b_start) = if lag >= 0 {
        (0usize, lag as usize)
    } else {
        (lag.unsigned_abs(), 0usize)
    };
    let overlap = a_len
        .saturating_sub(a_start)
        .min(b_len.saturating_sub(b_start));
    (a_start, b_start, overlap)
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::thread::JoinHandle;

    use windows_sys::Win32::Foundation::{
        CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects};

    use super::AudioCaptureTarget;

    #[repr(C)]
    #[derive(Debug, Default)]
    struct NativeCaptureStats {
        hresult: i32,
        sample_rate: u32,
        channels: u32,
        bits_per_sample: u32,
        discontinuities: u32,
        frames_written: u64,
        first_qpc_100ns: u64,
        last_qpc_100ns: u64,
    }

    #[derive(Debug)]
    pub(super) struct NativeCaptureResult {
        pub(super) discontinuities: u32,
    }

    #[link(name = "synthv_process_loopback", kind = "static")]
    unsafe extern "C" {
        fn synthv_capture_process_loopback(
            process_id: u32,
            output_path: *const u16,
            ready_event: *mut c_void,
            failure_event: *mut c_void,
            stop_event: *mut c_void,
            stats: *mut NativeCaptureStats,
        ) -> i32;
    }

    struct OwnedHandle(usize);

    impl OwnedHandle {
        fn event() -> Result<Self, String> {
            let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if handle.is_null() {
                Err("无法创建音频捕获同步事件。".to_string())
            } else {
                Ok(Self(handle as usize))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0 as HANDLE
        }

        fn signal(&self) {
            unsafe { SetEvent(self.raw()) };
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe { CloseHandle(self.raw()) };
            }
        }
    }

    pub(super) struct NativeCapture {
        stop: OwnedHandle,
        join: Option<JoinHandle<(i32, NativeCaptureStats)>>,
    }

    impl NativeCapture {
        pub(super) fn start(process_id: u32, output_path: PathBuf) -> Result<Self, String> {
            let ready = OwnedHandle::event()?;
            let failure = OwnedHandle::event()?;
            let stop = OwnedHandle::event()?;
            let ready_raw = ready.0;
            let failure_raw = failure.0;
            let stop_raw = stop.0;
            let wide_path = output_path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let join = std::thread::spawn(move || {
                let mut stats = NativeCaptureStats::default();
                let code = unsafe {
                    synthv_capture_process_loopback(
                        process_id,
                        wide_path.as_ptr(),
                        ready_raw as HANDLE,
                        failure_raw as HANDLE,
                        stop_raw as HANDLE,
                        &mut stats,
                    )
                };
                (code, stats)
            });
            let handles = [ready.raw(), failure.raw()];
            let wait = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, 12_000) };
            if wait == WAIT_OBJECT_0 {
                Ok(Self {
                    stop,
                    join: Some(join),
                })
            } else {
                stop.signal();
                let (code, stats) = join
                    .join()
                    .map_err(|_| "Windows 音频捕获线程异常退出。".to_string())?;
                if wait == WAIT_TIMEOUT {
                    Err("初始化 Windows 进程音频捕获超时。".to_string())
                } else {
                    Err(format_hresult(if stats.hresult != 0 {
                        stats.hresult
                    } else {
                        code
                    }))
                }
            }
        }

        pub(super) fn stop(&mut self) {
            self.stop.signal();
        }

        pub(super) fn finish(mut self) -> Result<NativeCaptureResult, String> {
            self.stop.signal();
            let (code, stats) = self
                .join
                .take()
                .ok_or_else(|| "音频捕获任务已经结束。".to_string())?
                .join()
                .map_err(|_| "Windows 音频捕获线程异常退出。".to_string())?;
            if code < 0 || stats.hresult < 0 {
                return Err(format_hresult(if stats.hresult < 0 {
                    stats.hresult
                } else {
                    code
                }));
            }
            if stats.frames_written == 0 {
                return Err("Windows 回环没有返回任何音频帧。".to_string());
            }
            Ok(NativeCaptureResult {
                discontinuities: stats.discontinuities,
            })
        }
    }

    impl Drop for NativeCapture {
        fn drop(&mut self) {
            self.stop.signal();
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    pub(super) fn list_targets() -> Result<Vec<AudioCaptureTarget>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("无法枚举 Windows 进程。".to_string());
        }
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut targets = Vec::new();
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            let name = wide_text(&entry.szExeFile);
            if is_synthv_standalone(&name) {
                targets.push(AudioCaptureTarget {
                    process_id: entry.th32ProcessID,
                    name,
                });
            }
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        targets.sort_by_key(|target| target.process_id);
        Ok(targets)
    }

    fn is_synthv_standalone(name: &str) -> bool {
        [
            "synthv-studio.exe",
            "synthesizer v studio 2 pro.exe",
            "synthesizer v studio pro.exe",
            "synthesizer v studio.exe",
        ]
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
    }

    fn wide_text(value: &[u16]) -> String {
        let length = value
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(value.len());
        String::from_utf16_lossy(&value[..length])
    }

    fn format_hresult(code: i32) -> String {
        format!(
            "Windows 进程音频捕获失败（HRESULT 0x{:08X}）。请确认系统版本至少为 Windows 10 build 20348，且所选 PID 仍在运行。",
            code as u32
        )
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::path::PathBuf;

    use super::AudioCaptureTarget;

    #[repr(C)]
    #[derive(Debug, Default)]
    struct NativeCaptureStats {
        hresult: i32,
        sample_rate: u32,
        channels: u32,
        bits_per_sample: u32,
        discontinuities: u32,
        frames_written: u64,
        first_qpc_100ns: u64,
        last_qpc_100ns: u64,
    }

    #[link(name = "synthv_macos_process_tap", kind = "static")]
    unsafe extern "C" {
        fn synthv_macos_process_tap_start(
            process_id: u32,
            output_path: *const c_char,
            stats: *mut NativeCaptureStats,
            error: *mut c_char,
            error_capacity: usize,
        ) -> *mut c_void;
        fn synthv_macos_process_tap_stop(capture: *mut c_void) -> c_int;
        fn synthv_macos_process_tap_finish(capture: *mut c_void) -> c_int;
    }

    pub(super) struct NativeCaptureResult {
        pub(super) discontinuities: u32,
    }

    pub(super) struct NativeCapture {
        raw: *mut c_void,
        stats: Box<NativeCaptureStats>,
    }

    struct StartedCapture {
        raw: *mut c_void,
        stats: Box<NativeCaptureStats>,
        error: [i8; 512],
    }

    unsafe impl Send for StartedCapture {}

    impl Drop for StartedCapture {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                unsafe { synthv_macos_process_tap_finish(self.raw) };
                self.raw = std::ptr::null_mut();
            }
        }
    }

    unsafe impl Send for NativeCapture {}

    impl NativeCapture {
        pub(super) fn start(process_id: u32, output_path: PathBuf) -> Result<Self, String> {
            let output_path = CString::new(output_path.as_os_str().as_encoded_bytes())
                .map_err(|_| "音频输出路径包含不支持的 NUL 字符。".to_string())?;
            let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let cancelled_for_start = cancelled.clone();
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let mut stats = Box::<NativeCaptureStats>::default();
                let mut error = [0i8; 512];
                let raw = unsafe {
                    synthv_macos_process_tap_start(
                        process_id,
                        output_path.as_ptr(),
                        &mut *stats,
                        error.as_mut_ptr(),
                        error.len(),
                    )
                };
                let outcome = StartedCapture { raw, stats, error };
                if cancelled_for_start.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                let _ = sender.send(outcome);
            });
            let mut outcome = receiver
                .recv_timeout(std::time::Duration::from_secs(12))
                .map_err(|_| {
                    cancelled.store(true, std::sync::atomic::Ordering::Release);
                    "初始化 macOS Process Tap 超时；后台启动若随后完成会立即清理资源。".to_string()
                })?;
            if outcome.raw.is_null() {
                let detail = unsafe { std::ffi::CStr::from_ptr(outcome.error.as_ptr()) }
                    .to_string_lossy()
                    .trim()
                    .to_string();
                return Err(if detail.is_empty() {
                    "无法启动 macOS 指定进程音频捕获。请确认 macOS 14.2+、目标 PID 仍在运行，并在系统设置中允许此应用录制系统音频。".to_string()
                } else {
                    detail
                });
            }
            Ok(Self {
                raw: std::mem::replace(&mut outcome.raw, std::ptr::null_mut()),
                stats: std::mem::take(&mut outcome.stats),
            })
        }

        pub(super) fn stop(&mut self) {
            if !self.raw.is_null() {
                unsafe { synthv_macos_process_tap_stop(self.raw) };
            }
        }

        pub(super) fn finish(mut self) -> Result<NativeCaptureResult, String> {
            let status = unsafe { synthv_macos_process_tap_finish(self.raw) };
            self.raw = std::ptr::null_mut();
            if status != 0 || self.stats.hresult != 0 {
                return Err(format!(
                    "macOS Core Audio Process Tap 捕获失败（OSStatus {}）。请确认已允许系统音频录制且目标进程仍在输出音频。",
                    if self.stats.hresult != 0 { self.stats.hresult } else { status }
                ));
            }
            if self.stats.frames_written == 0 {
                return Err("macOS Process Tap 没有返回任何音频帧。请确认所选 SynthV 进程在捕获区间内确实播放音频。".to_string());
            }
            Ok(NativeCaptureResult {
                discontinuities: self.stats.discontinuities,
            })
        }
    }

    impl Drop for NativeCapture {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                unsafe { synthv_macos_process_tap_finish(self.raw) };
                self.raw = std::ptr::null_mut();
            }
        }
    }

    pub(super) fn list_targets() -> Result<Vec<AudioCaptureTarget>, String> {
        let output = std::process::Command::new("ps")
            .args(["-axo", "pid=,comm="])
            .output()
            .map_err(|error| format!("无法枚举 macOS 进程：{error}"))?;
        if !output.status.success() {
            return Err("macOS 进程枚举失败。".to_string());
        }
        let mut targets = std::str::from_utf8(&output.stdout)
            .map_err(|_| "macOS 进程列表不是 UTF-8。".to_string())?
            .lines()
            .filter_map(|line| {
                let (pid, command) = line.trim().split_once(char::is_whitespace)?;
                let process_id = pid.parse().ok()?;
                let name = command.rsplit('/').next()?.to_string();
                is_synthv_standalone(&name).then_some(AudioCaptureTarget { process_id, name })
            })
            .collect::<Vec<_>>();
        targets.sort_by_key(|target| target.process_id);
        Ok(targets)
    }

    fn is_synthv_standalone(name: &str) -> bool {
        [
            "synthv-studio",
            "synthesizer v flat",
            "synthesizer v studio 2 pro",
            "synthesizer v studio pro",
            "synthesizer v studio",
        ]
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use std::path::PathBuf;

    use super::AudioCaptureTarget;

    pub(super) struct NativeCaptureResult {
        pub(super) discontinuities: u32,
    }

    pub(super) struct NativeCapture;

    impl NativeCapture {
        pub(super) fn start(_process_id: u32, _output_path: PathBuf) -> Result<Self, String> {
            Err("当前平台没有可用的进程级音频捕获后端。".to_string())
        }
        pub(super) fn stop(&mut self) {}
        pub(super) fn finish(self) -> Result<NativeCaptureResult, String> {
            Err("当前平台没有可用的进程级音频捕获后端。".to_string())
        }
    }

    pub(super) fn list_targets() -> Result<Vec<AudioCaptureTarget>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave(samples: Vec<f32>) -> MonoWave {
        MonoWave {
            sample_rate: 48_000,
            samples,
        }
    }

    #[test]
    fn capture_request_is_bounded_for_fast_feedback() {
        let request = CaptureClipRequest {
            process_id: None,
            start_seconds: 1.0,
            end_seconds: 31.1,
            pre_roll_seconds: 0.4,
            post_roll_seconds: 0.25,
            label: String::new(),
        };
        assert!(validate_capture_request(&request).is_err());
    }

    #[test]
    fn lag_estimator_recovers_candidate_delay() {
        let mut a = vec![0.0f32; 8_000];
        for (index, sample) in a.iter_mut().enumerate() {
            *sample =
                ((index as f32 * 0.071).sin() * 0.6) + if index % 997 < 10 { 0.3 } else { 0.0 };
        }
        let delay = 173usize;
        let mut b = vec![0.0f32; a.len() + delay];
        b[delay..].copy_from_slice(&a);
        let estimated = estimate_lag(&a, &b, 500);
        assert!(
            (estimated - delay as isize).abs() <= 2,
            "estimated {estimated}"
        );
    }

    #[test]
    fn wav_round_trip_and_comparison_are_deterministic() {
        let root = std::env::temp_dir().join(format!("synthv-ab-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let a_path = root.join("a.wav");
        let b_path = root.join("b.wav");
        let samples = (0..48_000)
            .map(|index| (index as f32 * 0.017).sin() * 0.4)
            .collect::<Vec<_>>();
        write_wave(&a_path, &wave(samples.clone())).unwrap();
        write_wave(&b_path, &wave(samples)).unwrap();
        let result = compare_clips(CompareClipsRequest {
            baseline_path: a_path.to_string_lossy().into_owned(),
            candidate_path: b_path.to_string_lossy().into_owned(),
            max_lag_ms: 50.0,
        })
        .unwrap();
        assert!(result.correlation > 0.999_9);
        assert_eq!(result.classification, "near-identical");
        fs::remove_dir_all(root).unwrap();
    }
}
