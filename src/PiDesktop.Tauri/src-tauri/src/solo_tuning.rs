use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::audio_capture::{self, CaptureClipRequest, CompareClipsRequest};
use crate::bridge_workflows;
use crate::config::AgentWorkMode;
use crate::creative_history;
use crate::mcp::McpManager;
use crate::synthv_control::{self, BridgeShortcutAction};
use crate::tuning_profiles::{self, SourceStyleFeatures, TuningProfile};
use crate::workflows;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoloTuningRequest {
    pub reference_audio_path: String,
    pub voice_name: String,
    pub project_path: String,
    pub process_id: u32,
    pub track_index: u32,
    pub group_index: u32,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoloTuningResult {
    pub accepted: bool,
    pub changed: bool,
    pub improvement: f64,
    pub reference_distance_before: f64,
    pub reference_distance_after: f64,
    pub baseline_path: String,
    pub candidate_path: Option<String>,
    pub rollback_path: Option<String>,
    pub rollback_verified: bool,
    pub checkpoint_path: String,
    pub project_path: String,
    pub profile: TuningProfile,
    pub bridge_result: Value,
}

pub async fn run(
    request: SoloTuningRequest,
    mode: AgentWorkMode,
    manager: &McpManager,
    resource_dir: &Path,
) -> Result<SoloTuningResult, String> {
    if mode != AgentWorkMode::Solo {
        return Err("自动 A/B 调声只允许在 Solo 模式运行。".to_string());
    }
    validate_request(&request)?;
    if !audio_capture::capability().supported {
        return Err(audio_capture::capability().detail);
    }
    let bridge_project = bridge_workflows::current_project_file(manager).await?;
    if canonical(&bridge_project)? != canonical(&request.project_path)? {
        return Err("请求工程与当前 Bridge 工程不一致，已停止 Solo 写入。".to_string());
    }
    let checkpoint = creative_history::create_checkpoint(
        &request.project_path,
        &format!("Solo 调声前检查点 {}", request.voice_name),
    )?;
    let profile = match tuning_profiles::get(&request.voice_name) {
        Ok(profile) => profile,
        Err(_) => {
            let features =
                workflows::source_style(request.reference_audio_path.clone(), resource_dir)?;
            tuning_profiles::learn(&request.voice_name, features)?
        }
    };
    let reference = workflows::source_style(request.reference_audio_path.clone(), resource_dir)?;
    let baseline =
        audio_capture::capture_clip(manager, capture_request(&request, "solo-baseline")).await?;
    let baseline_features = workflows::source_style(baseline.output_path.clone(), resource_dir)?;
    let before = feature_distance(&reference, &baseline_features);

    let bridge_result = bridge_workflows::apply_tuning_profile(
        manager,
        &profile,
        request.track_index,
        request.group_index,
    )
    .await?;
    let changed = recursive_u64(&bridge_result, "changedCount").unwrap_or(0) > 0;
    if !changed {
        return Ok(SoloTuningResult {
            accepted: false,
            changed: false,
            improvement: 0.0,
            reference_distance_before: before,
            reference_distance_after: before,
            baseline_path: baseline.output_path,
            candidate_path: None,
            rollback_path: None,
            rollback_verified: true,
            checkpoint_path: checkpoint.snapshot_path,
            project_path: request.project_path,
            profile,
            bridge_result,
        });
    }

    let candidate =
        audio_capture::capture_clip(manager, capture_request(&request, "solo-candidate")).await?;
    let candidate_features = workflows::source_style(candidate.output_path.clone(), resource_dir)?;
    let after = feature_distance(&reference, &candidate_features);
    let improvement = ((before - after) / before.max(0.001)).clamp(-1.0, 1.0);
    let accepted = improvement >= 0.02;
    let updated_profile = tuning_profiles::record_outcome(
        &request.voice_name,
        profile.parameters.clone(),
        improvement,
    )?;
    if accepted {
        synthv_control::send_shortcut(request.process_id, BridgeShortcutAction::Save)?;
        return Ok(SoloTuningResult {
            accepted: true,
            changed: true,
            improvement,
            reference_distance_before: before,
            reference_distance_after: after,
            baseline_path: baseline.output_path,
            candidate_path: Some(candidate.output_path),
            rollback_path: None,
            rollback_verified: true,
            checkpoint_path: checkpoint.snapshot_path,
            project_path: request.project_path,
            profile: updated_profile,
            bridge_result,
        });
    }

    synthv_control::send_shortcut(request.process_id, BridgeShortcutAction::Undo)?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let rollback =
        audio_capture::capture_clip(manager, capture_request(&request, "solo-rollback")).await?;
    let comparison = audio_capture::compare_clips(CompareClipsRequest {
        baseline_path: baseline.output_path.clone(),
        candidate_path: rollback.output_path.clone(),
        max_lag_ms: 250.0,
    })?;
    let rollback_verified =
        comparison.similarity_percent >= 98.0 && comparison.loudness_delta_db.abs() <= 0.5;
    if !rollback_verified {
        return Err(format!(
            "Solo 候选退化且 Undo 后未恢复到基线；请使用检查点 {}。",
            checkpoint.snapshot_path
        ));
    }
    Ok(SoloTuningResult {
        accepted: false,
        changed: true,
        improvement,
        reference_distance_before: before,
        reference_distance_after: after,
        baseline_path: baseline.output_path,
        candidate_path: Some(candidate.output_path),
        rollback_path: Some(rollback.output_path),
        rollback_verified,
        checkpoint_path: checkpoint.snapshot_path,
        project_path: request.project_path,
        profile: updated_profile,
        bridge_result,
    })
}

fn validate_request(request: &SoloTuningRequest) -> Result<(), String> {
    if request.process_id == 0 || request.track_index == 0 || request.group_index == 0 {
        return Err("进程、轨道与音符组编号必须从 1 开始。".to_string());
    }
    if !request.start_seconds.is_finite()
        || !request.end_seconds.is_finite()
        || request.start_seconds < 0.0
        || request.end_seconds <= request.start_seconds
        || request.end_seconds - request.start_seconds > 30.0
    {
        return Err("Solo A/B 片段必须是最长 30 秒的有效时间范围。".to_string());
    }
    if !Path::new(&request.reference_audio_path).is_file() {
        return Err("Solo 参考人声音频不存在。".to_string());
    }
    Ok(())
}

fn capture_request(request: &SoloTuningRequest, label: &str) -> CaptureClipRequest {
    CaptureClipRequest {
        process_id: Some(request.process_id),
        start_seconds: request.start_seconds,
        end_seconds: request.end_seconds,
        pre_roll_seconds: 0.4,
        post_roll_seconds: 0.25,
        label: label.to_string(),
    }
}

fn feature_distance(reference: &SourceStyleFeatures, rendered: &SourceStyleFeatures) -> f64 {
    let terms = [
        (reference.median_pitch_midi - rendered.median_pitch_midi).abs() / 12.0,
        (reference.pitch_range_semitones - rendered.pitch_range_semitones).abs() / 24.0,
        (reference.vibrato_rate_hz - rendered.vibrato_rate_hz).abs() / 6.0,
        (reference.vibrato_depth_cents - rendered.vibrato_depth_cents).abs() / 200.0,
        (reference.dynamic_range_db - rendered.dynamic_range_db).abs() / 30.0,
        (reference.breathiness_proxy - rendered.breathiness_proxy).abs() / 0.5,
        (reference.brightness_hz - rendered.brightness_hz).abs() / 4_000.0,
        (reference.voiced_ratio - rendered.voiced_ratio).abs(),
    ];
    terms.iter().sum::<f64>() / terms.len() as f64
}

fn recursive_u64(value: &Value, key: &str) -> Option<u64> {
    match value {
        Value::Object(object) => object
            .get(key)
            .and_then(Value::as_u64)
            .or_else(|| object.values().find_map(|value| recursive_u64(value, key))),
        Value::Array(items) => items.iter().find_map(|value| recursive_u64(value, key)),
        _ => None,
    }
}

fn canonical(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("无法解析工程路径：{error}"))
}
