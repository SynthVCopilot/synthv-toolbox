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
use crate::components::component_list;
use crate::downloads::ComponentDownloadManager;
use crate::mcp::McpToolExecutor;
use crate::mcp::{extract_mcp_json, McpManager};
use crate::media_import;
use crate::synthv::{bridge_is_bundled, find_node};
use crate::synthv_control::{self, BridgeShortcutAction};
use crate::workflows;
use tokio::runtime::Handle;

const MAX_CLIP_SECONDS: f64 = 30.0;
const MAX_GUARD_SECONDS: f64 = 2.0;
const MAX_WAV_BYTES: u64 = 128 * 1024 * 1024;
const PLAYBACK_POLL_INTERVAL: Duration = Duration::from_millis(45);
const PLAYBACK_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

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
    #[cfg(not(windows))]
    {
        AudioCaptureCapability {
            supported: false,
            backend: "unavailable".to_string(),
            detail: "当前构建尚未包含此平台的进程级音频捕获后端。".to_string(),
            max_clip_seconds: MAX_CLIP_SECONDS,
        }
    }
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
    let session_before = bridge_status(manager).await?;
    let session_token = recursive_string(&session_before, "sessionToken").map(str::to_string);
    let playback_before = playback(manager, "status", None).await?;
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

    playback(manager, "seek", Some(play_from)).await?;
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
            let _ = playback(manager, "seek", Some(original_playhead)).await;
            cleanup_capture_files(&[&raw_path]);
            return Err(error);
        }
    };
    let capture_armed_at = Instant::now();

    let play_call_started = Instant::now();
    let play_result = playback(manager, "play", None).await;
    let play_call_finished = Instant::now();
    if let Err(error) = play_result {
        capture.stop();
        let _ = tauri::async_runtime::spawn_blocking(move || capture.finish()).await;
        let _ = playback(manager, "stop", None).await;
        let _ = playback(manager, "seek", Some(original_playhead)).await;
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
        match playback(manager, "status", None).await {
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

    let stop_result = playback(manager, "stop", None).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    capture.stop();
    let native_result = tauri::async_runtime::spawn_blocking(move || capture.finish())
        .await
        .map_err(|error| format!("等待音频捕获完成失败：{error}"))
        .and_then(|result| result);
    let restore_result = playback(manager, "seek", Some(original_playhead)).await;

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

    let session_after = match bridge_status(manager).await {
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
}

impl ToolboxAudioToolExecutor {
    pub fn new(
        mcp: McpToolExecutor,
        manager: Arc<McpManager>,
        runtime: Handle,
        bridge_dir: PathBuf,
        resource_dir: PathBuf,
        components_dir: PathBuf,
        downloads: Arc<ComponentDownloadManager>,
    ) -> Self {
        Self {
            mcp,
            manager,
            runtime,
            bridge_dir,
            resource_dir,
            components_dir,
            downloads,
        }
    }

    fn local_tools(&self) -> Vec<ToolDefinition> {
        let mut tools = vec![ToolDefinition {
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
                description: "Download one explicitly supplied Bilibili/YouTube source into a managed local WAV with metadata, manifest, and SHA-256. rightsConfirmed must be true.".to_string(),
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
                name: "separate_vocals_and_instrumental".to_string(),
                description: "Run the managed Demucs htdemucs component on one local audio file and return managed vocals.wav and instrumental.wav paths.".to_string(),
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
            ToolDefinition {
                name: "list_synthv_processes".to_string(),
                description: "List every running local SynthV process. This is read-only and returns PID, executable name, and command line.".to_string(),
                input_schema_json: json!({ "type": "object", "additionalProperties": false }).to_string(),
            },
            ToolDefinition {
                name: "read_synthv_bridge_shortcuts".to_string(),
                description: "Read the Toolbox Bridge shortcut profile. The defaults are F13 for start/reconnect and F14 for stop.".to_string(),
                input_schema_json: json!({ "type": "object", "additionalProperties": false }).to_string(),
            },
            ToolDefinition {
                name: "send_synthv_bridge_shortcut".to_string(),
                description: "Focus one listed SynthV PID and send its configured Bridge shortcut. Use start to send F13 or stop to send F14.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": {
                        "processId": { "type": "integer", "minimum": 1 },
                        "action": { "type": "string", "enum": ["start", "stop"] }
                    },
                    "required": ["processId", "action"],
                    "additionalProperties": false
                }).to_string(),
            },
            ToolDefinition {
                name: "auto_connect_synthv_bridge".to_string(),
                description: "Focus one listed SynthV PID, send F13 to start or reconnect its Bridge, then retry the local MCP connection for up to four seconds. Only one SynthV Bridge session can be connected at a time.".to_string(),
                input_schema_json: json!({
                    "type": "object",
                    "properties": { "processId": { "type": "integer", "minimum": 1 } },
                    "required": ["processId"],
                    "additionalProperties": false
                }).to_string(),
            },
        ]);
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
                        media_import::import_audio(
                            &request.source,
                            request.rights_confirmed,
                            &self.resource_dir,
                        )
                    })
                    .and_then(|value| {
                        serde_json::to_string(&value).map_err(|error| error.to_string())
                    }),
            ),
            "separate_vocals_and_instrumental" => Some(
                serde_json::from_str::<AudioPathToolRequest>(&call.arguments_json)
                    .map_err(|error| format!("分离参数无效：{error}"))
                    .and_then(|request| {
                        workflows::separate_audio(request.audio_path, &self.resource_dir)
                    })
                    .and_then(|value| {
                        serde_json::to_string(&value).map_err(|error| error.to_string())
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
            "list_synthv_processes" => Some(synthv_control::list_processes().and_then(|value| {
                serde_json::to_string(&value).map_err(|error| error.to_string())
            })),
            "read_synthv_bridge_shortcuts" => Some(
                serde_json::to_string(&synthv_control::shortcut_profile())
                    .map_err(|error| error.to_string()),
            ),
            "send_synthv_bridge_shortcut" => Some(
                serde_json::from_str::<SynthVShortcutRequest>(&call.arguments_json)
                    .map_err(|error| format!("快捷键参数无效：{error}"))
                    .and_then(|request| {
                        synthv_control::send_shortcut(request.process_id, request.action)
                    })
                    .and_then(|value| {
                        serde_json::to_string(&value).map_err(|error| error.to_string())
                    }),
            ),
            "auto_connect_synthv_bridge" => Some(
                serde_json::from_str::<SynthVProcessRequest>(&call.arguments_json)
                    .map_err(|error| format!("自动连接参数无效：{error}"))
                    .and_then(|request| {
                        if !bridge_is_bundled(&self.bridge_dir) {
                            return Err("当前构建未包含完整的 SynthV Bridge。".to_string());
                        }
                        let node =
                            find_node().ok_or_else(|| "未找到 Node.js 22.19+。".to_string())?;
                        self.runtime
                            .block_on(synthv_control::start_bridge_and_connect(
                                request.process_id,
                                &self.manager,
                                node,
                                self.bridge_dir.clone(),
                            ))
                    })
                    .and_then(|(process, tools)| {
                        serde_json::to_string(&json!({ "process": process, "tools": tools }))
                            .map_err(|error| error.to_string())
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthVProcessRequest {
    process_id: u32,
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
struct AudioPathToolRequest {
    audio_path: String,
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
struct SynthVShortcutRequest {
    process_id: u32,
    action: BridgeShortcutAction,
}

impl ToolExecutor for ToolboxAudioToolExecutor {
    fn tools(&self) -> Vec<ToolDefinition> {
        let mut tools = self.mcp.tools();
        tools.extend(self.local_tools());
        tools
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, AgentError> {
        if let Some(result) = self.execute_local(call) {
            Ok(result)
        } else {
            self.mcp.execute(call)
        }
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

async fn bridge_status(manager: &McpManager) -> Result<Value, String> {
    call_bridge(manager, "sv_status", json!({})).await
}

async fn playback(
    manager: &McpManager,
    operation: &str,
    time_seconds: Option<f64>,
) -> Result<Value, String> {
    let mut args = json!({ "operation": operation });
    if let Some(value) = time_seconds {
        args["timeSeconds"] = json!(value);
    }
    call_bridge(
        manager,
        "sv_ui",
        json!({ "action": "playback", "args": args }),
    )
    .await
}

async fn call_bridge(manager: &McpManager, tool: &str, args: Value) -> Result<Value, String> {
    let response = tokio::time::timeout(
        PLAYBACK_COMMAND_TIMEOUT,
        manager.call_bridge_tool(tool, args),
    )
    .await
    .map_err(|_| format!("{tool} 调用超时。"))??;
    extract_mcp_json(&response)
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

#[cfg(not(windows))]
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
