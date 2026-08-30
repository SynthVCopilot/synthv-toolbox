//! Safe, deliberately small FFmpeg audio-preparation runtime.
//!
//! This module owns no Tauri commands.  `AppState` is expected to keep an
//! `Arc<AudioPreparationService>` and commands should only expose the typed
//! methods below.  In particular, callers never pass FFmpeg arguments or an
//! output pathname: both are built here from a reviewed request.

use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::agent::data_root;
use crate::components::{component_usage_guard, find_ffmpeg_pair, managed_ffmpeg_runtime};
use crate::process_tree::{attach_child, prepare_command};

const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_LUFS: f64 = -16.0;
const DEFAULT_TRUE_PEAK: f64 = -1.5;
const DEFAULT_LRA: f64 = 11.0;
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const LOUDNESS_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const CAPTURE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegRuntimeStatus {
    pub available: bool,
    pub source: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub version: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub path: String,
    pub container: Option<String>,
    pub codec: Option<String>,
    pub duration_seconds: Option<f64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub channel_layout: Option<String>,
    pub bit_depth: Option<u16>,
    pub bit_rate: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPrepareRequest {
    pub input_path: String,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub channels: Option<u16>,
    #[serde(default = "default_sample_format")]
    pub sample_format: String,
    #[serde(default)]
    pub start_seconds: Option<f64>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
}

fn default_sample_format() -> String {
    "s24".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessNormalizeRequest {
    pub input_path: String,
    #[serde(default = "default_lufs")]
    pub integrated_lufs: f64,
    #[serde(default = "default_true_peak")]
    pub true_peak_dbtp: f64,
    #[serde(default = "default_lra")]
    pub loudness_range: f64,
}

fn default_lufs() -> f64 {
    DEFAULT_LUFS
}
fn default_true_peak() -> f64 {
    DEFAULT_TRUE_PEAK
}
fn default_lra() -> f64 {
    DEFAULT_LRA
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWritePlan {
    pub plan_id: String,
    pub token: String,
    pub expires_at: String,
    pub request_digest: String,
    pub operation: String,
    pub input_path: String,
    pub output_path: String,
    pub parameters: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioJobSnapshot {
    pub id: String,
    pub operation: String,
    pub status: String,
    pub progress_percent: Option<f64>,
    pub output_path: Option<String>,
    pub artifact_id: Option<String>,
    pub loudness_report: Option<LoudnessReport>,
    pub error: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessReport {
    pub path: String,
    pub integrated_lufs: Option<f64>,
    pub true_peak_dbtp: Option<f64>,
    pub loudness_range: Option<f64>,
    pub threshold: Option<f64>,
    pub raw: Value,
}

#[derive(Debug, Clone)]
struct Runtime {
    source: &'static str,
    ffmpeg: OsString,
    ffprobe: OsString,
}

struct CapturedCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug, Clone)]
enum PlannedRequest {
    Prepare(AudioPrepareRequest),
    Normalize(LoudnessNormalizeRequest),
}

#[derive(Debug, Clone)]
struct StoredPlan {
    plan: AudioWritePlan,
    request: PlannedRequest,
    canonical_output_root: PathBuf,
    expires_at: SystemTime,
    used: bool,
}

#[derive(Debug, Clone)]
struct ConsumedPlan {
    plan: AudioWritePlan,
    request: PlannedRequest,
    canonical_output_root: PathBuf,
}

#[derive(Debug)]
struct JobRecord {
    snapshot: AudioJobSnapshot,
    cancelled: Arc<AtomicBool>,
}

/// Shared state for plans and jobs.  Construct it once per application.
pub struct AudioPreparationService {
    resource_dir: PathBuf,
    output_root: PathBuf,
    #[cfg(test)]
    runtime_override: Option<Runtime>,
    plans: Mutex<HashMap<String, StoredPlan>>,
    jobs: Mutex<HashMap<String, JobRecord>>,
    write_active: AtomicBool,
}

impl AudioPreparationService {
    pub fn new(resource_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            resource_dir,
            output_root: default_output_root(),
            #[cfg(test)]
            runtime_override: None,
            plans: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            write_active: AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    fn new_for_test(resource_dir: PathBuf, output_root: PathBuf) -> Arc<Self> {
        let (ffmpeg, ffprobe) = find_ffmpeg_pair(&resource_dir.join("ffmpeg"))
            .expect("test runtime must contain an FFmpeg pair");
        Arc::new(Self {
            resource_dir,
            output_root,
            runtime_override: Some(Runtime {
                source: "bundled",
                ffmpeg: ffmpeg.into_os_string(),
                ffprobe: ffprobe.into_os_string(),
            }),
            plans: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            write_active: AtomicBool::new(false),
        })
    }

    pub async fn status(&self) -> FfmpegRuntimeStatus {
        match component_usage_guard() {
            Ok(_usage_guard) => ffmpeg_status(self.runtime()).await,
            Err(error) => FfmpegRuntimeStatus {
                available: false,
                source: None,
                ffmpeg_path: None,
                ffprobe_path: None,
                version: None,
                detail: error,
            },
        }
    }

    pub async fn probe_media(&self, path: String) -> Result<MediaProbe, String> {
        let _usage_guard = component_usage_guard()?;
        probe_media_with_runtime(&self.runtime()?, path).await
    }

    pub async fn analyze_loudness(&self, path: String) -> Result<LoudnessReport, String> {
        let _usage_guard = component_usage_guard()?;
        analyze_loudness_with_runtime(&self.runtime()?, path).await
    }

    fn runtime(&self) -> Result<Runtime, String> {
        #[cfg(test)]
        if let Some(runtime) = &self.runtime_override {
            return Ok(runtime.clone());
        }
        resolve_runtime(&self.resource_dir)
    }

    pub async fn plan_audio_prepare(
        &self,
        request: AudioPrepareRequest,
    ) -> Result<AudioWritePlan, String> {
        validate_prepare(&request)?;
        let input = canonical_input(&request.input_path)?;
        let probe = self
            .probe_media(input.to_string_lossy().into_owned())
            .await?;
        let output = self.new_output(&input, "prepared")?;
        let mut effective = request;
        effective.input_path = input.to_string_lossy().into_owned();
        let mut parameters = vec![
            "PCM WAV".to_string(),
            format!("{}-bit", sample_bits(&effective.sample_format)?),
        ];
        parameters.push(format!(
            "sample rate: {}",
            effective
                .sample_rate
                .map(|v| v.to_string())
                .unwrap_or_else(|| probe
                    .sample_rate
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "preserve".to_string()))
        ));
        parameters.push(format!(
            "channels: {}",
            effective
                .channels
                .map(|v| v.to_string())
                .unwrap_or_else(|| probe
                    .channels
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "preserve".to_string()))
        ));
        if let Some(start) = effective.start_seconds {
            parameters.push(format!("start: {start:.3}s"));
        }
        if let Some(duration) = effective.duration_seconds {
            parameters.push(format!("duration: {duration:.3}s"));
        }
        self.store_plan(
            "prepare",
            PlannedRequest::Prepare(effective),
            output,
            parameters,
            Vec::new(),
        )
    }

    pub fn plan_loudness_normalize(
        &self,
        request: LoudnessNormalizeRequest,
    ) -> Result<AudioWritePlan, String> {
        validate_normalize(&request)?;
        let input = canonical_input(&request.input_path)?;
        let output = self.new_output(&input, "normalized")?;
        let mut effective = request;
        effective.input_path = input.to_string_lossy().into_owned();
        self.store_plan(
            "loudness-normalize",
            PlannedRequest::Normalize(effective.clone()),
            output,
            vec![format!(
                "EBU R128: {:.1} LUFS / {:.1} dBTP / {:.1} LRA",
                effective.integrated_lufs, effective.true_peak_dbtp, effective.loudness_range
            )],
            vec!["The result is measured again after normalization.".to_string()],
        )
    }

    pub fn start_audio_prepare(
        self: &Arc<Self>,
        request: AudioPrepareRequest,
        token: String,
    ) -> Result<AudioJobSnapshot, String> {
        self.start(PlannedRequest::Prepare(request), token)
    }

    pub fn start_loudness_normalize(
        self: &Arc<Self>,
        request: LoudnessNormalizeRequest,
        token: String,
    ) -> Result<AudioJobSnapshot, String> {
        self.start(PlannedRequest::Normalize(request), token)
    }

    pub fn audio_job_snapshot(&self, id: &str) -> Result<AudioJobSnapshot, String> {
        self.jobs
            .lock()
            .map_err(|_| "Audio job state is unavailable.".to_string())?
            .get(id)
            .map(|record| record.snapshot.clone())
            .ok_or_else(|| "Audio job was not found.".to_string())
    }

    pub fn cancel_audio_job(&self, id: &str) -> Result<AudioJobSnapshot, String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Audio job state is unavailable.".to_string())?;
        let record = jobs
            .get_mut(id)
            .ok_or_else(|| "Audio job was not found.".to_string())?;
        if matches!(record.snapshot.status.as_str(), "queued" | "running") {
            record.cancelled.store(true, Ordering::SeqCst);
            record.snapshot.status = "cancelling".to_string();
        }
        Ok(record.snapshot.clone())
    }

    fn store_plan(
        &self,
        operation: &str,
        request: PlannedRequest,
        output: PathBuf,
        parameters: Vec<String>,
        warnings: Vec<String>,
    ) -> Result<AudioWritePlan, String> {
        ensure_output_root(&self.output_root)?;
        let canonical_output_root = fs::canonicalize(&self.output_root)
            .map_err(|error| format!("Unable to pin the audio output directory: {error}"))?;
        let (input, digest) = match &request {
            PlannedRequest::Prepare(value) => (&value.input_path, digest_request(value)?),
            PlannedRequest::Normalize(value) => (&value.input_path, digest_request(value)?),
        };
        let plan_id = Uuid::new_v4().to_string();
        let token = Uuid::new_v4().to_string();
        let expiry = SystemTime::now() + TOKEN_TTL;
        let plan = AudioWritePlan {
            plan_id: plan_id.clone(),
            token,
            expires_at: DateTime::<Utc>::from(expiry).to_rfc3339(),
            request_digest: digest,
            operation: operation.to_string(),
            input_path: input.clone(),
            output_path: output.to_string_lossy().into_owned(),
            parameters,
            warnings,
        };
        self.plans
            .lock()
            .map_err(|_| "Audio plan state is unavailable.".to_string())?
            .insert(
                plan_id,
                StoredPlan {
                    plan: plan.clone(),
                    request,
                    canonical_output_root,
                    expires_at: expiry,
                    used: false,
                },
            );
        Ok(plan)
    }

    fn start(
        self: &Arc<Self>,
        request: PlannedRequest,
        token: String,
    ) -> Result<AudioJobSnapshot, String> {
        let request = normalize_start_request(request)?;
        let digest = match &request {
            PlannedRequest::Prepare(value) => digest_request(value)?,
            PlannedRequest::Normalize(value) => digest_request(value)?,
        };
        if self
            .write_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Another audio write job is already running.".to_string());
        }
        let stored = {
            let mut plans = match self.plans.lock() {
                Ok(plans) => plans,
                Err(_) => {
                    self.write_active.store(false, Ordering::SeqCst);
                    return Err("Audio plan state is unavailable.".to_string());
                }
            };
            match consume_plan(&mut plans, &token, &request, &digest, SystemTime::now()) {
                Ok(plan) => plan,
                Err(error) => {
                    self.write_active.store(false, Ordering::SeqCst);
                    return Err(error);
                }
            }
        };
        let id = Uuid::new_v4().to_string();
        let snapshot = AudioJobSnapshot {
            id: id.clone(),
            operation: stored.plan.operation.clone(),
            status: "queued".to_string(),
            progress_percent: Some(0.0),
            output_path: Some(stored.plan.output_path.clone()),
            artifact_id: None,
            loudness_report: None,
            error: None,
            started_at: Utc::now().to_rfc3339(),
            completed_at: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Err(error) = self
            .jobs
            .lock()
            .map_err(|_| "Audio job state is unavailable.".to_string())
            .map(|mut jobs| {
                jobs.insert(
                    id.clone(),
                    JobRecord {
                        snapshot: snapshot.clone(),
                        cancelled: cancelled.clone(),
                    },
                )
            })
        {
            self.write_active.store(false, Ordering::SeqCst);
            return Err(error);
        }
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service.execute(id, stored, cancelled).await;
        });
        Ok(snapshot)
    }

    async fn execute(
        self: Arc<Self>,
        id: String,
        consumed: ConsumedPlan,
        cancelled: Arc<AtomicBool>,
    ) {
        let ConsumedPlan {
            plan,
            request,
            canonical_output_root,
        } = consumed;
        self.update_job(&id, |snapshot| {
            if snapshot.status == "queued" {
                snapshot.status = "running".to_string();
            }
        });
        let result = async {
            let _usage_guard = component_usage_guard()?;
            if cancelled.load(Ordering::SeqCst) {
                return Err("Audio operation was cancelled before it started.".to_string());
            }
            let input_path = match &request {
                PlannedRequest::Prepare(request) => request.input_path.as_str(),
                PlannedRequest::Normalize(request) => request.input_path.as_str(),
            };
            revalidate_planned_output(
                &self.output_root,
                &canonical_output_root,
                Path::new(&plan.output_path),
                input_path,
            )?;
            let runtime = self.runtime()?;
            let report = match request {
                PlannedRequest::Prepare(request) => {
                    self.run_prepare(&runtime, &id, &plan.output_path, request, &cancelled)
                        .await?;
                    None
                }
                PlannedRequest::Normalize(request) => Some(
                    self.run_normalize(&runtime, &id, &plan.output_path, request, &cancelled)
                        .await?,
                ),
            };
            Ok::<Option<LoudnessReport>, String>(report)
        }
        .await;
        let was_cancelled = cancelled.load(Ordering::SeqCst);
        if was_cancelled || result.is_err() {
            let _ = remove_generated_output(&self.output_root, Path::new(&plan.output_path));
        }
        self.update_job(&id, |snapshot| {
            snapshot.completed_at = Some(Utc::now().to_rfc3339());
            if was_cancelled {
                snapshot.status = "cancelled".to_string();
                snapshot.error = None;
            } else {
                match result {
                    Err(error) => {
                        snapshot.status = "failed".to_string();
                        snapshot.error = Some(error);
                    }
                    Ok(report) => {
                        snapshot.status = "completed".to_string();
                        snapshot.progress_percent = Some(100.0);
                        snapshot.artifact_id = Some(id.clone());
                        snapshot.loudness_report = report;
                    }
                }
            }
        });
        self.write_active.store(false, Ordering::SeqCst);
    }

    async fn run_prepare(
        &self,
        runtime: &Runtime,
        id: &str,
        output: &str,
        request: AudioPrepareRequest,
        cancelled: &AtomicBool,
    ) -> Result<(), String> {
        let source_duration =
            probe_media_with_runtime_for_job(runtime, request.input_path.clone(), cancelled)
                .await?
                .duration_seconds;
        let output_duration = request.duration_seconds.or_else(|| {
            source_duration
                .map(|duration| (duration - request.start_seconds.unwrap_or(0.0)).max(0.0))
        });
        let mut args = Vec::<OsString>::new();
        args.extend(
            ["-hide_banner", "-nostdin", "-n"]
                .into_iter()
                .map(OsString::from),
        );
        if let Some(start) = request.start_seconds {
            args.extend([OsString::from("-ss"), OsString::from(format!("{start:.6}"))]);
        }
        args.extend([OsString::from("-i"), OsString::from(request.input_path)]);
        if let Some(duration) = request.duration_seconds {
            args.extend([
                OsString::from("-t"),
                OsString::from(format!("{duration:.6}")),
            ]);
        }
        if let Some(rate) = request.sample_rate {
            args.extend([OsString::from("-ar"), OsString::from(rate.to_string())]);
        }
        if let Some(channels) = request.channels {
            args.extend([OsString::from("-ac"), OsString::from(channels.to_string())]);
        }
        args.extend([
            OsString::from("-c:a"),
            OsString::from(sample_codec(&request.sample_format)?),
            OsString::from("-progress"),
            OsString::from("pipe:1"),
            OsString::from(output),
        ]);
        self.run_ffmpeg(runtime, id, args, output_duration, cancelled)
            .await?;
        validate_completed_output(&self.output_root, Path::new(output))
    }

    async fn run_normalize(
        &self,
        runtime: &Runtime,
        id: &str,
        output: &str,
        request: LoudnessNormalizeRequest,
        cancelled: &AtomicBool,
    ) -> Result<LoudnessReport, String> {
        let probe =
            probe_media_with_runtime_for_job(runtime, request.input_path.clone(), cancelled)
                .await?;
        let source_duration = probe.duration_seconds;
        let report = analyze_loudness_with_runtime_for_job(
            runtime,
            request.input_path.clone(),
            request.integrated_lufs,
            request.true_peak_dbtp,
            request.loudness_range,
            cancelled,
        )
        .await?;
        let measured = loudnorm_measurements(&report.raw)?;
        let filter = format!("loudnorm=I={}:TP={}:LRA={}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true:print_format=summary", request.integrated_lufs, request.true_peak_dbtp, request.loudness_range, measured.i, measured.tp, measured.lra, measured.thresh, measured.offset);
        let mut args = vec![
            "-hide_banner",
            "-nostdin",
            "-n",
            "-i",
            &request.input_path,
            "-af",
            &filter,
            "-c:a",
            "pcm_s24le",
        ]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
        if let Some(sample_rate) = probe.sample_rate {
            args.extend([
                OsString::from("-ar"),
                OsString::from(sample_rate.to_string()),
            ]);
        }
        if let Some(channels) = probe.channels {
            args.extend([OsString::from("-ac"), OsString::from(channels.to_string())]);
        }
        args.extend([
            OsString::from("-progress"),
            OsString::from("pipe:1"),
            OsString::from(output),
        ]);
        self.run_ffmpeg(runtime, id, args, source_duration, cancelled)
            .await?;
        validate_completed_output(&self.output_root, Path::new(output))?;
        let report = analyze_loudness_with_runtime_for_job(
            runtime,
            output.to_string(),
            request.integrated_lufs,
            request.true_peak_dbtp,
            request.loudness_range,
            cancelled,
        )
        .await?;
        Ok(report)
    }

    async fn run_ffmpeg(
        &self,
        runtime: &Runtime,
        id: &str,
        args: Vec<OsString>,
        duration: Option<f64>,
        cancelled: &AtomicBool,
    ) -> Result<(), String> {
        let mut command = Command::new(&runtime.ffmpeg);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_command(&mut command)?;
        let mut child = command
            .spawn()
            .map_err(|error| format!("Unable to start FFmpeg: {error}"))?;
        let process_tree = match attach_child(&child) {
            Ok(process_tree) => process_tree,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "FFmpeg progress stream is unavailable.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "FFmpeg diagnostics stream is unavailable.".to_string())?;
        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(value) = line
                    .strip_prefix("out_time_ms=")
                    .and_then(|value| value.parse::<f64>().ok())
                {
                    let _ = progress_tx.send(value);
                }
            }
        });
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut tail = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > 4_096 {
                    let mut boundary = tail.len() - 4_096;
                    while !tail.is_char_boundary(boundary) {
                        boundary += 1;
                    }
                    tail.drain(..boundary);
                }
            }
            tail
        });
        loop {
            tokio::select! {
                Some(value) = progress_rx.recv() => {
                    if let Some(total) = duration.filter(|value| *value > 0.0) {
                        self.update_job(id, |snapshot| snapshot.progress_percent = Some((value / 1_000_000.0 / total * 100.0).clamp(0.0, 99.0)));
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    if cancelled.load(Ordering::SeqCst) {
                        if let Err(error) = process_tree.terminate(&mut child).await {
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                            return Err(format!("Audio operation was cancelled; cleanup failed: {error}"));
                        }
                        return Err("Audio operation was cancelled.".to_string());
                    }
                    if let Some(status) = child.try_wait().map_err(|error| format!("FFmpeg did not finish: {error}"))? {
                        process_tree.release();
                        let diagnostics = match tokio::time::timeout(Duration::from_secs(2), stderr_task).await {
                            Ok(Ok(tail)) => tail,
                            Ok(Err(error)) => format!("diagnostic reader failed: {error}"),
                            Err(_) => "diagnostic reader timed out".to_string(),
                        };
                        if !status.success() { return Err(format!("FFmpeg exited with {status}: {}", diagnostics.trim())); }
                        return Ok(());
                    }
                }
            }
        }
    }

    fn update_job(&self, id: &str, update: impl FnOnce(&mut AudioJobSnapshot)) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.get_mut(id) {
                update(&mut job.snapshot);
            }
        }
    }

    fn new_output(&self, input: &Path, suffix: &str) -> Result<PathBuf, String> {
        ensure_output_root(&self.output_root)?;
        let stem = input
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("audio");
        let safe: String = stem
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
            .take(48)
            .collect();
        let output = self.output_root.join(format!(
            "{}-{}-{}.wav",
            if safe.is_empty() { "audio" } else { &safe },
            suffix,
            Uuid::new_v4()
        ));
        validate_generated_output(&self.output_root, &output, input)?;
        Ok(output)
    }
}

async fn ffmpeg_status(runtime: Result<Runtime, String>) -> FfmpegRuntimeStatus {
    match runtime {
        Ok(runtime) => {
            let ffmpeg_path = PathBuf::from(&runtime.ffmpeg)
                .to_string_lossy()
                .into_owned();
            let ffprobe_path = PathBuf::from(&runtime.ffprobe)
                .to_string_lossy()
                .into_owned();
            let version_args = vec![OsString::from("-version")];
            let ffmpeg_version = run_captured_process(
                &runtime.ffmpeg,
                version_args.clone(),
                Duration::from_secs(5),
                None,
                "FFmpeg version check",
            )
            .await;
            let ffprobe_version = run_captured_process(
                &runtime.ffprobe,
                version_args,
                Duration::from_secs(5),
                None,
                "ffprobe version check",
            )
            .await;
            let version = match (&ffmpeg_version, &ffprobe_version) {
                (Ok(ffmpeg), Ok(ffprobe))
                    if ffmpeg.status.success() && ffprobe.status.success() =>
                {
                    String::from_utf8(ffmpeg.stdout.clone())
                        .ok()
                        .and_then(|text| text.lines().next().map(str::to_string))
                        .filter(|line| !line.trim().is_empty())
                }
                _ => None,
            };
            let failure = match (ffmpeg_version, ffprobe_version, version.as_ref()) {
                (Err(error), _, _) => Some(error),
                (_, Err(error), _) => Some(error),
                (Ok(output), _, _) if !output.status.success() => Some(format!(
                    "FFmpeg version check exited with {}: {}",
                    output.status,
                    diagnostic_tail(&output.stderr)
                )),
                (_, Ok(output), _) if !output.status.success() => Some(format!(
                    "ffprobe version check exited with {}: {}",
                    output.status,
                    diagnostic_tail(&output.stderr)
                )),
                (_, _, None) => Some("FFmpeg returned no parseable version line.".to_string()),
                _ => None,
            };
            FfmpegRuntimeStatus {
                available: failure.is_none(),
                source: Some(runtime.source.to_string()),
                ffmpeg_path: Some(ffmpeg_path),
                ffprobe_path: Some(ffprobe_path),
                version,
                detail: failure
                    .unwrap_or_else(|| format!("FFmpeg resolved from {}.", runtime.source)),
            }
        }
        Err(error) => FfmpegRuntimeStatus {
            available: false,
            source: None,
            ffmpeg_path: None,
            ffprobe_path: None,
            version: None,
            detail: error,
        },
    }
}

async fn probe_media_with_runtime(runtime: &Runtime, path: String) -> Result<MediaProbe, String> {
    probe_media_with_runtime_inner(runtime, path, None).await
}

async fn probe_media_with_runtime_for_job(
    runtime: &Runtime,
    path: String,
    cancelled: &AtomicBool,
) -> Result<MediaProbe, String> {
    probe_media_with_runtime_inner(runtime, path, Some(cancelled)).await
}

async fn probe_media_with_runtime_inner(
    runtime: &Runtime,
    path: String,
    cancelled: Option<&AtomicBool>,
) -> Result<MediaProbe, String> {
    let input = canonical_input(&path)?;
    let args = [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
    ]
    .into_iter()
    .map(OsString::from)
    .chain(std::iter::once(input.clone().into_os_string()))
    .collect();
    let output =
        run_captured_process(&runtime.ffprobe, args, PROBE_TIMEOUT, cancelled, "ffprobe").await?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe could not read this media file: {}",
            diagnostic_tail(&output.stderr)
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid ffprobe response: {error}"))?;
    media_probe_from_json(input.to_string_lossy().into_owned(), &value)
}

fn media_probe_from_json(path: String, value: &Value) -> Result<MediaProbe, String> {
    let audio = value
        .get("streams")
        .and_then(Value::as_array)
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        })
        .ok_or_else(|| "The file contains no audio stream.".to_string())?;
    let format = value.get("format").unwrap_or(&Value::Null);
    Ok(MediaProbe {
        path,
        container: format
            .get("format_name")
            .and_then(Value::as_str)
            .map(str::to_string),
        codec: audio
            .get("codec_name")
            .and_then(Value::as_str)
            .map(str::to_string),
        duration_seconds: parse_number(format.get("duration"))
            .or_else(|| parse_number(audio.get("duration"))),
        sample_rate: parse_number(audio.get("sample_rate")).map(|value| value as u32),
        channels: parse_number(audio.get("channels")).map(|value| value as u16),
        channel_layout: audio
            .get("channel_layout")
            .and_then(Value::as_str)
            .map(str::to_string),
        bit_depth: parse_number(audio.get("bits_per_sample"))
            .or_else(|| parse_number(audio.get("bits_per_raw_sample")))
            .map(|value| value as u16),
        bit_rate: parse_number(audio.get("bit_rate"))
            .or_else(|| parse_number(format.get("bit_rate")))
            .map(|value| value as u64),
    })
}

async fn analyze_loudness_with_runtime(
    runtime: &Runtime,
    path: String,
) -> Result<LoudnessReport, String> {
    analyze_loudness_with_targets(
        runtime,
        path,
        DEFAULT_LUFS,
        DEFAULT_TRUE_PEAK,
        DEFAULT_LRA,
        None,
    )
    .await
}

async fn analyze_loudness_with_runtime_for_job(
    runtime: &Runtime,
    path: String,
    integrated_lufs: f64,
    true_peak_dbtp: f64,
    loudness_range: f64,
    cancelled: &AtomicBool,
) -> Result<LoudnessReport, String> {
    analyze_loudness_with_targets(
        runtime,
        path,
        integrated_lufs,
        true_peak_dbtp,
        loudness_range,
        Some(cancelled),
    )
    .await
}

async fn analyze_loudness_with_targets(
    runtime: &Runtime,
    path: String,
    integrated_lufs: f64,
    true_peak_dbtp: f64,
    loudness_range: f64,
    cancelled: Option<&AtomicBool>,
) -> Result<LoudnessReport, String> {
    let input = canonical_input(&path)?;
    let filter = format!(
        "loudnorm=I={integrated_lufs}:TP={true_peak_dbtp}:LRA={loudness_range}:print_format=json"
    );
    let args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        input.clone().into_os_string(),
        OsString::from("-af"),
        OsString::from(filter),
        OsString::from("-f"),
        OsString::from("null"),
        OsString::from("-"),
    ];
    let output = run_captured_process(
        &runtime.ffmpeg,
        args,
        LOUDNESS_TIMEOUT,
        cancelled,
        "FFmpeg loudness analysis",
    )
    .await?;
    if !output.status.success() {
        return Err(format!(
            "FFmpeg could not analyze loudness for this file: {}",
            diagnostic_tail(&output.stderr)
        ));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let raw = extract_last_json(&stderr)
        .ok_or_else(|| "FFmpeg did not return EBU R128 measurements.".to_string())?;
    Ok(LoudnessReport {
        path: input.to_string_lossy().into_owned(),
        integrated_lufs: json_number(&raw, "input_i"),
        true_peak_dbtp: json_number(&raw, "input_tp"),
        loudness_range: json_number(&raw, "input_lra"),
        threshold: json_number(&raw, "input_thresh"),
        raw,
    })
}

async fn run_captured_process(
    program: &OsStr,
    args: Vec<OsString>,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
    label: &str,
) -> Result<CapturedCommandOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepare_command(&mut command)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start {label}: {error}"))?;
    let process_tree = match attach_child(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = process_tree.terminate(&mut child).await;
            return Err(format!("{label} stdout is unavailable."));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = process_tree.terminate(&mut child).await;
            return Err(format!("{label} stderr is unavailable."));
        }
    };
    let stdout_task = tokio::spawn(collect_bounded(stdout, CAPTURE_LIMIT, "stdout"));
    let stderr_task = tokio::spawn(collect_bounded(stderr, CAPTURE_LIMIT, "stderr"));
    let deadline = tokio::time::Instant::now() + timeout;
    let status = loop {
        if cancelled.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            if let Err(error) = process_tree.terminate(&mut child).await {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(format!(
                    "Audio operation was cancelled; cleanup failed: {error}"
                ));
            }
            return Err("Audio operation was cancelled.".to_string());
        }
        if tokio::time::Instant::now() >= deadline {
            if let Err(error) = process_tree.terminate(&mut child).await {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(format!("{label} timed out and cleanup failed: {error}"));
            }
            return Err(format!("{label} timed out."));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Unable to wait for {label}: {error}"))?
        {
            process_tree.release();
            break status;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let stdout = stdout_task
        .await
        .map_err(|error| format!("{label} stdout reader failed: {error}"))??;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("{label} stderr reader failed: {error}"))??;
    Ok(CapturedCommandOutput {
        status,
        stdout,
        stderr,
    })
}

async fn collect_bounded<R>(
    mut reader: R,
    limit: usize,
    stream_name: &str,
) -> Result<Vec<u8>, String>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|error| format!("Unable to read process {stream_name}: {error}"))?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > limit {
            return Err(format!(
                "Process {stream_name} exceeded the {limit}-byte limit."
            ));
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

fn diagnostic_tail(value: &[u8]) -> String {
    let text = String::from_utf8_lossy(value);
    let mut tail = text.chars().rev().take(1_600).collect::<String>();
    tail = tail.chars().rev().collect();
    let tail = tail.trim();
    if tail.is_empty() {
        "no diagnostics".to_string()
    } else {
        tail.to_string()
    }
}

fn resolve_runtime(resource_dir: &Path) -> Result<Runtime, String> {
    let explicit = env::var_os("SYNTHV_TOOLBOX_FFMPEG_DIR").map(PathBuf::from);
    let path_directories = env::var_os("PATH")
        .into_iter()
        .flat_map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .collect();
    resolve_runtime_from_candidates(
        explicit,
        managed_ffmpeg_runtime(),
        resource_dir.join("ffmpeg"),
        path_directories,
    )
}

fn resolve_runtime_from_candidates(
    explicit: Option<PathBuf>,
    managed: Option<(PathBuf, PathBuf)>,
    bundled: PathBuf,
    path_directories: Vec<PathBuf>,
) -> Result<Runtime, String> {
    if let Some(explicit) = explicit {
        if let Some((ffmpeg, ffprobe)) = find_ffmpeg_pair(&explicit) {
            return Ok(Runtime {
                source: "explicit",
                ffmpeg: ffmpeg.into_os_string(),
                ffprobe: ffprobe.into_os_string(),
            });
        }
    }
    if let Some((ffmpeg, ffprobe)) = managed {
        return Ok(Runtime {
            source: "managed",
            ffmpeg: ffmpeg.into_os_string(),
            ffprobe: ffprobe.into_os_string(),
        });
    }
    if let Some((ffmpeg, ffprobe)) = find_ffmpeg_pair(&bundled) {
        return Ok(Runtime {
            source: "bundled",
            ffmpeg: ffmpeg.into_os_string(),
            ffprobe: ffprobe.into_os_string(),
        });
    }
    if let Some((ffmpeg, ffprobe)) = path_directories
        .into_iter()
        .find_map(|directory| find_ffmpeg_pair(&directory))
    {
        return Ok(Runtime {
            source: "path",
            ffmpeg: ffmpeg.into_os_string(),
            ffprobe: ffprobe.into_os_string(),
        });
    }
    Err("FFmpeg and ffprobe were not found. Configure SYNTHV_TOOLBOX_FFMPEG_DIR, install the Toolbox-managed component, or add both binaries to PATH.".to_string())
}

pub(crate) fn configure_ffmpeg_environment(
    command: &mut std::process::Command,
    resource_dir: &Path,
) -> Result<(), String> {
    let runtime = resolve_runtime(resource_dir)?;
    if runtime.source == "path" {
        return Ok(());
    }
    let ffmpeg = PathBuf::from(runtime.ffmpeg);
    let directory = ffmpeg
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "Resolved FFmpeg has no parent directory.".to_string())?;
    let mut paths = vec![directory.to_path_buf()];
    if let Some(existing) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing));
    }
    let joined = env::join_paths(paths)
        .map_err(|error| format!("Unable to construct FFmpeg PATH: {error}"))?;
    command.env("PATH", joined);
    Ok(())
}

fn parse_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    })
}
fn json_number(value: &Value, key: &str) -> Option<f64> {
    parse_number(value.get(key))
}
fn extract_last_json(text: &str) -> Option<Value> {
    let start = text.rfind('{')?;
    serde_json::from_str(&text[start..]).ok()
}
fn digest_request<T: Serialize>(request: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn same_operation(left: &PlannedRequest, right: &PlannedRequest) -> bool {
    matches!(
        (left, right),
        (PlannedRequest::Prepare(_), PlannedRequest::Prepare(_))
            | (PlannedRequest::Normalize(_), PlannedRequest::Normalize(_))
    )
}
fn consume_plan(
    plans: &mut HashMap<String, StoredPlan>,
    token: &str,
    request: &PlannedRequest,
    digest: &str,
    now: SystemTime,
) -> Result<ConsumedPlan, String> {
    let (_, plan) = plans
        .iter_mut()
        .find(|(_, plan)| plan.plan.token == token)
        .ok_or_else(|| "Confirmation token is missing or invalid.".to_string())?;
    if plan.used {
        return Err("This confirmation token has already been used.".to_string());
    }
    if now > plan.expires_at {
        return Err("This confirmation token has expired. Create a new plan.".to_string());
    }
    if plan.plan.request_digest != digest || !same_operation(&plan.request, request) {
        return Err("The request changed after confirmation. Create a new plan.".to_string());
    }
    plan.used = true;
    Ok(ConsumedPlan {
        plan: plan.plan.clone(),
        request: plan.request.clone(),
        canonical_output_root: plan.canonical_output_root.clone(),
    })
}
fn normalize_start_request(request: PlannedRequest) -> Result<PlannedRequest, String> {
    match request {
        PlannedRequest::Prepare(mut request) => {
            validate_prepare(&request)?;
            request.input_path = canonical_input(&request.input_path)?
                .to_string_lossy()
                .into_owned();
            Ok(PlannedRequest::Prepare(request))
        }
        PlannedRequest::Normalize(mut request) => {
            validate_normalize(&request)?;
            request.input_path = canonical_input(&request.input_path)?
                .to_string_lossy()
                .into_owned();
            Ok(PlannedRequest::Normalize(request))
        }
    }
}
fn sample_codec(format: &str) -> Result<&'static str, String> {
    match format {
        "s16" => Ok("pcm_s16le"),
        "s24" => Ok("pcm_s24le"),
        "f32" => Ok("pcm_f32le"),
        _ => Err("sampleFormat must be s16, s24, or f32.".to_string()),
    }
}
fn sample_bits(format: &str) -> Result<u8, String> {
    match format {
        "s16" => Ok(16),
        "s24" => Ok(24),
        "f32" => Ok(32),
        _ => Err("sampleFormat must be s16, s24, or f32.".to_string()),
    }
}
fn validate_prepare(request: &AudioPrepareRequest) -> Result<(), String> {
    sample_codec(&request.sample_format)?;
    if let Some(rate) = request.sample_rate {
        if !(8_000..=192_000).contains(&rate) {
            return Err("sampleRate must be between 8000 and 192000.".to_string());
        }
    }
    if let Some(channels) = request.channels {
        if !matches!(channels, 1 | 2) {
            return Err("channels must be 1 or 2.".to_string());
        }
    }
    validate_trim(request.start_seconds, request.duration_seconds)
}
fn validate_normalize(request: &LoudnessNormalizeRequest) -> Result<(), String> {
    if !(-70.0..=-5.0).contains(&request.integrated_lufs)
        || !(-9.0..=0.0).contains(&request.true_peak_dbtp)
        || !(1.0..=20.0).contains(&request.loudness_range)
    {
        return Err("Loudness targets are outside safe EBU R128 ranges.".to_string());
    }
    Ok(())
}
fn validate_trim(start: Option<f64>, duration: Option<f64>) -> Result<(), String> {
    if start.is_some_and(|value| !value.is_finite() || value < 0.0)
        || duration.is_some_and(|value| !value.is_finite() || value <= 0.0)
    {
        return Err(
            "startSeconds must be non-negative and durationSeconds must be positive.".to_string(),
        );
    }
    Ok(())
}
fn canonical_input(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty()
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Input path must be absolute and must not contain '..'.".to_string());
    }
    reject_linked_ancestors(&path, "Input path")?;
    let canonical = fs::canonicalize(&path)
        .map_err(|_| "Input file does not exist or cannot be accessed.".to_string())?;
    if !canonical.is_file() {
        return Err("Input path must be a file.".to_string());
    }
    Ok(canonical)
}
fn default_output_root() -> PathBuf {
    data_root().join("output").join("ffmpeg")
}
fn ensure_output_root(root: &Path) -> Result<(), String> {
    reject_linked_ancestors(root, "Audio output directory")?;
    fs::create_dir_all(root)
        .map_err(|error| format!("Unable to create audio output directory: {error}"))?;
    reject_linked_ancestors(root, "Audio output directory")?;
    let canonical = fs::canonicalize(root)
        .map_err(|error| format!("Unable to validate audio output directory: {error}"))?;
    let _ = canonical;
    Ok(())
}

fn revalidate_planned_output(
    root: &Path,
    canonical_root_at_plan: &Path,
    output: &Path,
    input: &str,
) -> Result<(), String> {
    ensure_output_root(root)?;
    let current_root = fs::canonicalize(root)
        .map_err(|error| format!("Unable to revalidate audio output directory: {error}"))?;
    if current_root != canonical_root_at_plan {
        return Err("The audio output directory changed after confirmation.".to_string());
    }
    let current_input = canonical_input(input)?;
    if current_input != Path::new(input) {
        return Err("The input path changed after confirmation.".to_string());
    }
    validate_generated_output(root, output, &current_input)
}

fn validate_generated_output(root: &Path, output: &Path, input: &Path) -> Result<(), String> {
    if output
        .components()
        .any(|component| matches!(component, Component::ParentDir))
        || output == input
        || fs::symlink_metadata(output).is_ok()
    {
        return Err("Unsafe or conflicting audio output path.".to_string());
    }
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let parent = output
        .parent()
        .ok_or_else(|| "Output has no parent directory.".to_string())?;
    let parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if parent != root || is_link_or_reparse(&parent)? {
        return Err("Audio output escaped the Toolbox output directory.".to_string());
    }
    Ok(())
}

fn validate_completed_output(root: &Path, output: &Path) -> Result<(), String> {
    reject_linked_ancestors(root, "Audio output directory")?;
    reject_linked_ancestors(output, "FFmpeg output")?;
    let metadata = fs::symlink_metadata(output)
        .map_err(|error| format!("FFmpeg did not create the planned output: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("FFmpeg output is not a regular file.".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("FFmpeg output is a reparse point.".to_string());
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let canonical_parent = fs::canonicalize(
        output
            .parent()
            .ok_or_else(|| "FFmpeg output has no parent directory.".to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if canonical_parent != canonical_root {
        return Err("FFmpeg output escaped the Toolbox output directory.".to_string());
    }
    Ok(())
}

fn remove_generated_output(root: &Path, output: &Path) -> Result<(), String> {
    reject_linked_ancestors(root, "Audio output directory")?;
    reject_linked_ancestors(output, "FFmpeg output")?;
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let parent = output
        .parent()
        .ok_or_else(|| "FFmpeg output has no parent directory.".to_string())?;
    if fs::canonicalize(parent).map_err(|error| error.to_string())? != canonical_root {
        return Err("Refused to clean an output outside the Toolbox directory.".to_string());
    }
    match fs::remove_file(output) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Unable to clean incomplete FFmpeg output: {error}")),
    }
}
fn is_link_or_reparse(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

fn reject_linked_ancestors(path: &Path, label: &str) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(_) if is_link_or_reparse(candidate)? => {
                return Err(format!(
                    "{label} contains a symbolic link or reparse point: {}",
                    candidate.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Unable to inspect {label}: {error}"));
            }
        }
        current = candidate.parent();
    }
    Ok(())
}

struct LoudnormMeasurements {
    i: f64,
    tp: f64,
    lra: f64,
    thresh: f64,
    offset: f64,
}
fn loudnorm_measurements(value: &Value) -> Result<LoudnormMeasurements, String> {
    Ok(LoudnormMeasurements {
        i: json_number(value, "input_i")
            .ok_or_else(|| "Missing input_i loudness measurement.".to_string())?,
        tp: json_number(value, "input_tp")
            .ok_or_else(|| "Missing input_tp loudness measurement.".to_string())?,
        lra: json_number(value, "input_lra")
            .ok_or_else(|| "Missing input_lra loudness measurement.".to_string())?,
        thresh: json_number(value, "input_thresh")
            .ok_or_else(|| "Missing input_thresh loudness measurement.".to_string())?,
        offset: json_number(value, "target_offset")
            .ok_or_else(|| "Missing target_offset loudness measurement.".to_string())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn fake_runtime_root() -> &'static PathBuf {
        static ROOT: OnceLock<PathBuf> = OnceLock::new();
        ROOT.get_or_init(|| {
            let root = std::env::temp_dir().join(format!(
                "synthv-toolbox-fake-ffmpeg-{}",
                Uuid::new_v4()
            ));
            let bin = root.join("ffmpeg");
            fs::create_dir_all(&bin).unwrap();
            let source = root.join("fake_ffmpeg.rs");
            fs::write(
                &source,
                r###"
use std::{env, fs, process::Command, thread, time::Duration};

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("--descendant") {
        thread::sleep(Duration::from_secs(60));
        return;
    }
    if args.iter().any(|arg| arg == "-version") {
        if env::current_exe().unwrap().parent().unwrap().join("fail-version").exists() {
            eprintln!("intentional version failure");
            std::process::exit(19);
        }
        println!("ffmpeg version fake-1.0 LGPL");
        return;
    }
    let is_probe = args.iter().any(|arg| arg == "-show_format");
    let input = args
        .iter()
        .position(|arg| arg == "-i")
        .and_then(|index| args.get(index + 1))
        .or_else(|| is_probe.then(|| args.last()).flatten());
    if let Some(input) = input {
        let is_analysis = args.iter().any(|arg| arg.contains("print_format=json"));
        let slow_probe = input.contains("slow-probe") && is_probe;
        let probe_marker = format!("{input}.probe-seen");
        let should_wait = (slow_probe && fs::metadata(&probe_marker).is_ok())
            || (input.contains("slow-analysis") && is_analysis);
        if slow_probe && fs::metadata(&probe_marker).is_err() {
            fs::write(&probe_marker, b"seen").unwrap();
        }
        if should_wait {
            thread::sleep(Duration::from_millis(250));
            let child = Command::new(env::current_exe().unwrap()).arg("--descendant").spawn().unwrap();
            fs::write(format!("{input}.childpid"), child.id().to_string()).unwrap();
            thread::sleep(Duration::from_secs(60));
        }
    }
    if args.iter().any(|arg| arg == "-show_format") {
        println!(r#"{"format":{"format_name":"wav","duration":"2.0","bit_rate":"2304000"},"streams":[{"codec_type":"audio","codec_name":"pcm_s24le","sample_rate":"48000","channels":2,"channel_layout":"stereo","bits_per_sample":24}]}"#);
        return;
    }
    if let Some(input) = input {
        if input.contains("fail") {
            eprintln!("intentional fake FFmpeg failure");
            std::process::exit(23);
        }
    }
    if args.iter().any(|arg| arg.contains("print_format=json")) {
        eprintln!(r#"{"input_i":"-21.0","input_tp":"-3.0","input_lra":"4.0","input_thresh":"-31.0","target_offset":"0.2"}"#);
        return;
    }
    if let Some(input) = input {
        if input.contains("slow") {
            thread::sleep(Duration::from_millis(250));
            let child = Command::new(env::current_exe().unwrap()).arg("--descendant").spawn().unwrap();
            fs::write(format!("{input}.childpid"), child.id().to_string()).unwrap();
            thread::sleep(Duration::from_secs(60));
        }
    }
    if args.iter().any(|arg| arg == "-progress") {
        if let Some(input) = input {
            fs::write(format!("{input}.args"), args.join("\n")).unwrap();
        }
        let output = args.last().unwrap();
        fs::write(output, b"RIFF-fake-pcm").unwrap();
        println!("out_time_ms=1000000");
        println!("progress=continue");
        println!("out_time_ms=2000000");
        println!("progress=end");
    }
}
"###,
            )
            .unwrap();
            let ffmpeg_name = if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            };
            let ffprobe_name = if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            };
            let ffmpeg = bin.join(ffmpeg_name);
            let compiled = std::process::Command::new("rustc")
                .arg(&source)
                .args(["--edition", "2021", "-O", "-o"])
                .arg(&ffmpeg)
                .status()
                .unwrap();
            assert!(compiled.success());
            fs::copy(&ffmpeg, bin.join(ffprobe_name)).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&ffmpeg, fs::Permissions::from_mode(0o755)).unwrap();
                fs::set_permissions(bin.join(ffprobe_name), fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
            root
        })
    }

    fn fake_service(label: &str) -> (Arc<AudioPreparationService>, PathBuf) {
        let case_root = std::env::temp_dir().join(format!(
            "synthv-toolbox-audio-case-{label}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&case_root).unwrap();
        let output = case_root.join("output");
        (
            AudioPreparationService::new_for_test(fake_runtime_root().clone(), output),
            case_root,
        )
    }

    fn copy_fake_pair(destination: &Path) -> (PathBuf, PathBuf) {
        fs::create_dir_all(destination).unwrap();
        let source = fake_runtime_root().join("ffmpeg");
        let ffmpeg_name = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let ffprobe_name = if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        };
        let ffmpeg = destination.join(ffmpeg_name);
        let ffprobe = destination.join(ffprobe_name);
        fs::copy(source.join(ffmpeg_name), &ffmpeg).unwrap();
        fs::copy(source.join(ffprobe_name), &ffprobe).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&ffmpeg, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&ffprobe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        (ffmpeg, ffprobe)
    }

    async fn wait_for_terminal(service: &AudioPreparationService, id: &str) -> AudioJobSnapshot {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let snapshot = service.audio_job_snapshot(id).unwrap();
                if matches!(
                    snapshot.status.as_str(),
                    "completed" | "failed" | "cancelled"
                ) {
                    return snapshot;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("fake FFmpeg job timed out")
    }

    fn is_process_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            use std::mem::MaybeUninit;
            use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };

            let process: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if process.is_null() {
                return false;
            }
            let mut exit_code = MaybeUninit::uninit();
            let queried = unsafe { GetExitCodeProcess(process, exit_code.as_mut_ptr()) != 0 };
            // `STILL_ACTIVE` is the Win32 process exit code constant. It is
            // not exposed by every windows-sys feature set.
            let alive = queried && unsafe { exit_code.assume_init() == 259 };
            unsafe {
                CloseHandle(process);
            }
            alive
        }
        #[cfg(unix)]
        {
            // kill(pid, 0) only probes process existence; it never signals or
            // modifies the descendant. EPERM still means the process exists.
            let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
            result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = pid;
            false
        }
    }

    async fn wait_for_process_exit(pid: u32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !is_process_alive(pid) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("fake FFmpeg descendant process remained after cancellation");
    }

    async fn cancel_after_descendant_starts(
        service: &AudioPreparationService,
        job_id: &str,
        input: &Path,
    ) -> AudioJobSnapshot {
        let child_pid_path = PathBuf::from(format!("{}.childpid", input.to_string_lossy()));
        tokio::time::timeout(Duration::from_secs(5), async {
            while !child_pid_path.is_file() {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("fake FFmpeg did not create its descendant");
        let descendant_pid: u32 = fs::read_to_string(&child_pid_path)
            .unwrap()
            .trim()
            .parse()
            .expect("fake FFmpeg wrote an invalid descendant PID");
        assert!(is_process_alive(descendant_pid));
        service.cancel_audio_job(job_id).unwrap();
        let cancelled = wait_for_terminal(service, job_id).await;
        assert_eq!(cancelled.status, "cancelled");
        wait_for_process_exit(descendant_pid).await;
        assert!(!is_process_alive(descendant_pid));
        cancelled
    }
    #[test]
    fn pcm_formats_are_closed() {
        assert_eq!(sample_codec("s24").unwrap(), "pcm_s24le");
        assert!(sample_codec("flac").is_err());
    }
    #[test]
    fn rejects_unsafe_trim_and_rate() {
        let mut request = AudioPrepareRequest {
            input_path: "a.wav".to_string(),
            sample_rate: Some(4_000),
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        assert!(validate_prepare(&request).is_err());
        request.sample_rate = None;
        request.duration_seconds = Some(0.0);
        assert!(validate_prepare(&request).is_err());
    }
    #[test]
    fn parses_loudnorm_json_at_end_of_stderr() {
        let raw = extract_last_json("noise\n{\"input_i\":\"-21.3\",\"input_tp\":\"-2.0\",\"input_lra\":\"4.0\",\"input_thresh\":\"-31\",\"target_offset\":\"0.4\"}\n").unwrap();
        assert_eq!(loudnorm_measurements(&raw).unwrap().i, -21.3);
    }
    #[test]
    fn accepts_fake_ffprobe_fixture() {
        let fixture: Value = serde_json::json!({
            "format": {"format_name": "wav", "duration": "12.5", "bit_rate": "2304000"},
            "streams": [{"codec_type": "audio", "codec_name": "pcm_s24le", "sample_rate": "48000", "channels": 2, "bits_per_sample": 24}]
        });
        let probe = media_probe_from_json("fake.wav".to_string(), &fixture).unwrap();
        assert_eq!(probe.codec.as_deref(), Some("pcm_s24le"));
        assert_eq!(probe.sample_rate, Some(48_000));
        assert_eq!(probe.bit_depth, Some(24));
    }
    #[test]
    fn request_digest_changes_with_request() {
        let a = AudioPrepareRequest {
            input_path: "a.wav".to_string(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let mut b = a.clone();
        b.channels = Some(1);
        assert_ne!(digest_request(&a).unwrap(), digest_request(&b).unwrap());
    }
    fn stored_plan(request: AudioPrepareRequest, expires_at: SystemTime) -> StoredPlan {
        StoredPlan {
            plan: AudioWritePlan {
                plan_id: "plan".to_string(),
                token: "token".to_string(),
                expires_at: String::new(),
                request_digest: digest_request(&request).unwrap(),
                operation: "prepare".to_string(),
                input_path: request.input_path.clone(),
                output_path: "out.wav".to_string(),
                parameters: vec![],
                warnings: vec![],
            },
            request: PlannedRequest::Prepare(request),
            canonical_output_root: PathBuf::from("output-root"),
            expires_at,
            used: false,
        }
    }
    #[test]
    fn token_is_one_time_and_request_bound() {
        let request = AudioPrepareRequest {
            input_path: "input.wav".to_string(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let mut plans = HashMap::from([(
            "plan".to_string(),
            stored_plan(request.clone(), SystemTime::now() + Duration::from_secs(1)),
        )]);
        let digest = digest_request(&request).unwrap();
        assert!(consume_plan(
            &mut plans,
            "missing-token",
            &PlannedRequest::Prepare(request.clone()),
            &digest,
            SystemTime::now()
        )
        .unwrap_err()
        .contains("missing or invalid"));
        assert!(consume_plan(
            &mut plans,
            "token",
            &PlannedRequest::Prepare(request.clone()),
            &digest,
            SystemTime::now()
        )
        .is_ok());
        assert!(consume_plan(
            &mut plans,
            "token",
            &PlannedRequest::Prepare(request.clone()),
            &digest,
            SystemTime::now()
        )
        .unwrap_err()
        .contains("already"));
        let altered = AudioPrepareRequest {
            channels: Some(1),
            ..request
        };
        let mut plans = HashMap::from([(
            "plan".to_string(),
            stored_plan(altered.clone(), SystemTime::now() + Duration::from_secs(1)),
        )]);
        assert!(consume_plan(
            &mut plans,
            "token",
            &PlannedRequest::Prepare(altered),
            &digest,
            SystemTime::now()
        )
        .unwrap_err()
        .contains("changed"));
    }
    #[test]
    fn expired_token_is_refused() {
        let request = AudioPrepareRequest {
            input_path: "input.wav".to_string(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let digest = digest_request(&request).unwrap();
        let mut plans = HashMap::from([(
            "plan".to_string(),
            stored_plan(request.clone(), SystemTime::now() - Duration::from_secs(1)),
        )]);
        assert!(consume_plan(
            &mut plans,
            "token",
            &PlannedRequest::Prepare(request),
            &digest,
            SystemTime::now()
        )
        .unwrap_err()
        .contains("expired"));
    }
    #[test]
    fn path_parent_components_are_rejected() {
        assert!(canonical_input("one/../two.wav")
            .unwrap_err()
            .contains(".."));
    }

    #[test]
    fn generated_outputs_reject_source_identity_and_conflicts() {
        let root =
            std::env::temp_dir().join(format!("synthv-toolbox-output-safety-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.wav");
        fs::write(&source, b"source").unwrap();
        assert!(validate_generated_output(&root, &source, &source).is_err());
        let conflict = root.join("existing.wav");
        fs::write(&conflict, b"existing").unwrap();
        assert!(validate_generated_output(&root, &conflict, &source).is_err());
        let traversal = root.join("..").join("escaped.wav");
        assert!(validate_generated_output(&root, &traversal, &source).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_output_roots_are_rejected_before_creation() {
        use std::os::unix::fs::symlink;

        let base =
            std::env::temp_dir().join(format!("synthv-toolbox-output-link-{}", Uuid::new_v4()));
        let external = base.join("external");
        let linked = base.join("linked-output");
        fs::create_dir_all(&external).unwrap();
        symlink(&external, &linked).unwrap();
        assert!(ensure_output_root(&linked).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_inputs_are_rejected() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("synthv-toolbox-input-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.wav");
        let linked = root.join("linked.wav");
        fs::write(&source, b"source").unwrap();
        symlink(&source, &linked).unwrap();
        assert!(canonical_input(linked.to_string_lossy().as_ref())
            .unwrap_err()
            .contains("symbolic link"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn reparse_point_inputs_are_rejected_when_links_are_available() {
        use std::os::windows::fs::symlink_file;

        let root =
            std::env::temp_dir().join(format!("synthv-toolbox-input-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.wav");
        let linked = root.join("linked.wav");
        fs::write(&source, b"source").unwrap();
        if symlink_file(&source, &linked).is_ok() {
            assert!(canonical_input(linked.to_string_lossy().as_ref()).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn fake_runtime_status_checks_both_binaries_and_parses_version() {
        let (service, case_root) = fake_service("status");
        let status = service.status().await;
        assert!(status.available, "{}", status.detail);
        assert_eq!(status.source.as_deref(), Some("bundled"));
        assert_eq!(
            status.version.as_deref(),
            Some("ffmpeg version fake-1.0 LGPL")
        );
        fs::remove_dir_all(case_root).unwrap();
    }

    #[tokio::test]
    async fn runtime_status_is_unavailable_when_version_execution_fails() {
        let case_root =
            std::env::temp_dir().join(format!("synthv-toolbox-status-failure-{}", Uuid::new_v4()));
        let resource = case_root.join("resource");
        let bin = resource.join("ffmpeg");
        copy_fake_pair(&bin);
        fs::write(bin.join("fail-version"), b"fail").unwrap();
        let service = AudioPreparationService::new_for_test(resource, case_root.join("output"));
        let status = service.status().await;
        assert!(!status.available);
        assert!(status.version.is_none());
        assert!(status.detail.contains("version check exited"));
        fs::remove_dir_all(case_root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replacing_output_root_with_a_link_after_plan_never_writes_externally() {
        use std::os::unix::fs::symlink;

        let (service, case_root) = fake_service("output-swap");
        let input = case_root.join("input.wav");
        let external = case_root.join("external");
        fs::write(&input, b"input").unwrap();
        let request = AudioPrepareRequest {
            input_path: input.to_string_lossy().into_owned(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let plan = service.plan_audio_prepare(request.clone()).await.unwrap();
        fs::remove_dir_all(&service.output_root).unwrap();
        fs::create_dir_all(&external).unwrap();
        symlink(&external, &service.output_root).unwrap();
        let started = service.start_audio_prepare(request, plan.token).unwrap();
        let failed = wait_for_terminal(&service, &started.id).await;
        assert_eq!(failed.status, "failed");
        assert!(fs::read_dir(&external).unwrap().next().is_none());
        fs::remove_file(&service.output_root).unwrap();
        fs::remove_dir_all(case_root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn replacing_output_root_with_a_reparse_point_is_rejected_when_available() {
        use std::os::windows::fs::symlink_dir;

        let (service, case_root) = fake_service("output-swap");
        let input = case_root.join("input.wav");
        let external = case_root.join("external");
        fs::write(&input, b"input").unwrap();
        let request = AudioPrepareRequest {
            input_path: input.to_string_lossy().into_owned(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let plan = service.plan_audio_prepare(request.clone()).await.unwrap();
        fs::remove_dir_all(&service.output_root).unwrap();
        fs::create_dir_all(&external).unwrap();
        if symlink_dir(&external, &service.output_root).is_ok() {
            let started = service.start_audio_prepare(request, plan.token).unwrap();
            let failed = wait_for_terminal(&service, &started.id).await;
            assert_eq!(failed.status, "failed");
            assert!(fs::read_dir(&external).unwrap().next().is_none());
            fs::remove_dir(&service.output_root).unwrap();
        }
        fs::remove_dir_all(case_root).unwrap();
    }

    #[test]
    fn runtime_source_priority_is_explicit_managed_bundled_then_path() {
        let root = std::env::temp_dir().join(format!(
            "synthv-toolbox-runtime-priority-{}",
            Uuid::new_v4()
        ));
        let explicit = root.join("explicit");
        let managed_dir = root.join("managed");
        let bundled = root.join("bundled");
        let path = root.join("path");
        copy_fake_pair(&explicit);
        let managed = copy_fake_pair(&managed_dir);
        copy_fake_pair(&bundled);
        copy_fake_pair(&path);

        let runtime = resolve_runtime_from_candidates(
            Some(explicit.clone()),
            Some(managed.clone()),
            bundled.clone(),
            vec![path.clone()],
        )
        .unwrap();
        assert_eq!(runtime.source, "explicit");

        let runtime = resolve_runtime_from_candidates(
            Some(root.join("missing")),
            Some(managed),
            bundled.clone(),
            vec![path.clone()],
        )
        .unwrap();
        assert_eq!(runtime.source, "managed");

        let runtime =
            resolve_runtime_from_candidates(None, None, bundled, vec![path.clone()]).unwrap();
        assert_eq!(runtime.source, "bundled");

        let runtime =
            resolve_runtime_from_candidates(None, None, root.join("missing-bundle"), vec![path])
                .unwrap();
        assert_eq!(runtime.source, "path");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn fake_ffmpeg_probes_prepares_and_reports_progress() {
        let (service, case_root) = fake_service("prepare");
        let input = case_root.join("input.wav");
        fs::write(&input, b"input").unwrap();
        let request = AudioPrepareRequest {
            input_path: input.to_string_lossy().into_owned(),
            sample_rate: Some(44_100),
            channels: Some(1),
            sample_format: "s24".to_string(),
            start_seconds: Some(0.25),
            duration_seconds: Some(1.0),
        };
        let probe = service
            .probe_media(request.input_path.clone())
            .await
            .unwrap();
        assert_eq!(probe.codec.as_deref(), Some("pcm_s24le"));
        let plan = service.plan_audio_prepare(request.clone()).await.unwrap();
        let started = service
            .start_audio_prepare(request, plan.token.clone())
            .unwrap();
        let completed = wait_for_terminal(&service, &started.id).await;
        assert_eq!(completed.status, "completed", "{:?}", completed.error);
        assert_eq!(completed.progress_percent, Some(100.0));
        assert!(completed.artifact_id.is_some());
        assert!(Path::new(completed.output_path.as_deref().unwrap()).is_file());
        assert_eq!(fs::read(&input).unwrap(), b"input");
        let invocation = fs::read_to_string(format!("{}.args", input.to_string_lossy())).unwrap();
        assert!(invocation.contains("-ar\n44100"));
        assert!(invocation.contains("-ac\n1"));
        assert!(invocation.contains("pcm_s24le"));
        assert!(service
            .start_audio_prepare(
                AudioPrepareRequest {
                    input_path: input.to_string_lossy().into_owned(),
                    sample_rate: Some(44_100),
                    channels: Some(1),
                    sample_format: "s24".to_string(),
                    start_seconds: Some(0.25),
                    duration_seconds: Some(1.0),
                },
                plan.token,
            )
            .is_err());
        fs::remove_dir_all(case_root).unwrap();
    }

    #[tokio::test]
    async fn fake_ffmpeg_normalizes_and_keeps_post_measurement() {
        let (service, case_root) = fake_service("normalize");
        let input = case_root.join("input.wav");
        fs::write(&input, b"input").unwrap();
        let request = LoudnessNormalizeRequest {
            input_path: input.to_string_lossy().into_owned(),
            integrated_lufs: DEFAULT_LUFS,
            true_peak_dbtp: DEFAULT_TRUE_PEAK,
            loudness_range: DEFAULT_LRA,
        };
        let before = service
            .analyze_loudness(request.input_path.clone())
            .await
            .unwrap();
        assert_eq!(before.integrated_lufs, Some(-21.0));
        let plan = service.plan_loudness_normalize(request.clone()).unwrap();
        let started = service
            .start_loudness_normalize(request, plan.token)
            .unwrap();
        let completed = wait_for_terminal(&service, &started.id).await;
        assert_eq!(completed.status, "completed", "{:?}", completed.error);
        assert_eq!(
            completed
                .loudness_report
                .as_ref()
                .and_then(|report| report.integrated_lufs),
            Some(-21.0)
        );
        assert_eq!(fs::read(&input).unwrap(), b"input");
        let invocation = fs::read_to_string(format!("{}.args", input.to_string_lossy())).unwrap();
        assert!(invocation.contains("loudnorm=I=-16:TP=-1.5:LRA=11"));
        assert!(invocation.contains("-ar\n48000"));
        assert!(invocation.contains("-ac\n2"));
        fs::remove_dir_all(case_root).unwrap();
    }

    #[tokio::test]
    async fn fake_ffmpeg_failure_is_structured_and_never_changes_source() {
        let (service, case_root) = fake_service("failure");
        let input = case_root.join("fail.wav");
        fs::write(&input, b"untouched source").unwrap();
        let request = AudioPrepareRequest {
            input_path: input.to_string_lossy().into_owned(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let plan = service.plan_audio_prepare(request.clone()).await.unwrap();
        let started = service.start_audio_prepare(request, plan.token).unwrap();
        let failed = wait_for_terminal(&service, &started.id).await;
        assert_eq!(failed.status, "failed");
        assert!(failed
            .error
            .as_deref()
            .is_some_and(|error| error.contains("intentional fake FFmpeg failure")));
        assert_eq!(fs::read(&input).unwrap(), b"untouched source");
        assert!(!Path::new(failed.output_path.as_deref().unwrap()).exists());
        fs::remove_dir_all(case_root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_removes_partial_output_and_reaches_terminal_state() {
        let (service, case_root) = fake_service("cancel");
        let input = case_root.join("slow.wav");
        fs::write(&input, b"input").unwrap();
        let request = AudioPrepareRequest {
            input_path: input.to_string_lossy().into_owned(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let plan = service.plan_audio_prepare(request.clone()).await.unwrap();
        let started = service.start_audio_prepare(request, plan.token).unwrap();
        let cancelled = cancel_after_descendant_starts(&service, &started.id, &input).await;
        assert!(!Path::new(cancelled.output_path.as_deref().unwrap()).exists());
        fs::remove_dir_all(case_root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_job_probe_and_cleans_its_process_tree() {
        let (service, case_root) = fake_service("cancel-probe");
        let input = case_root.join("slow-probe.wav");
        fs::write(&input, b"input").unwrap();
        let request = AudioPrepareRequest {
            input_path: input.to_string_lossy().into_owned(),
            sample_rate: None,
            channels: None,
            sample_format: "s24".to_string(),
            start_seconds: None,
            duration_seconds: None,
        };
        let plan = service.plan_audio_prepare(request.clone()).await.unwrap();
        let started = service.start_audio_prepare(request, plan.token).unwrap();
        let cancelled = cancel_after_descendant_starts(&service, &started.id, &input).await;
        assert!(!Path::new(cancelled.output_path.as_deref().unwrap()).exists());
        assert_eq!(fs::read(&input).unwrap(), b"input");
        fs::remove_dir_all(case_root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_loudness_analysis_and_cleans_its_process_tree() {
        let (service, case_root) = fake_service("cancel-analysis");
        let input = case_root.join("slow-analysis.wav");
        fs::write(&input, b"input").unwrap();
        let request = LoudnessNormalizeRequest {
            input_path: input.to_string_lossy().into_owned(),
            integrated_lufs: DEFAULT_LUFS,
            true_peak_dbtp: DEFAULT_TRUE_PEAK,
            loudness_range: DEFAULT_LRA,
        };
        let plan = service.plan_loudness_normalize(request.clone()).unwrap();
        let started = service
            .start_loudness_normalize(request, plan.token)
            .unwrap();
        let cancelled = cancel_after_descendant_starts(&service, &started.id, &input).await;
        assert!(!Path::new(cancelled.output_path.as_deref().unwrap()).exists());
        assert_eq!(fs::read(&input).unwrap(), b"input");
        fs::remove_dir_all(case_root).unwrap();
    }
}
