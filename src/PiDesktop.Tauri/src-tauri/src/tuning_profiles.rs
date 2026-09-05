use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent::data_root;

static PROFILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStyleFeatures {
    pub duration_sec: f64,
    pub median_pitch_midi: f64,
    pub pitch_range_semitones: f64,
    pub vibrato_rate_hz: f64,
    pub vibrato_depth_cents: f64,
    pub dynamic_range_db: f64,
    pub breathiness_proxy: f64,
    pub brightness_hz: f64,
    pub voiced_ratio: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningParameters {
    pub loudness: f64,
    pub tension: f64,
    pub breathiness: f64,
    pub gender: f64,
    pub tone_shift: f64,
    pub vibrato_strength: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningProfile {
    pub voice_name: String,
    pub normalized_voice_name: String,
    pub source_samples: u32,
    pub outcome_samples: u32,
    pub average_features: SourceStyleFeatures,
    pub parameters: TuningParameters,
    pub updated_at_utc: String,
}

pub fn learn(voice_name: &str, features: SourceStyleFeatures) -> Result<TuningProfile, String> {
    validate_features(&features)?;
    let (voice_name, normalized) = validate_voice_name(voice_name)?;
    let _guard = profile_lock()
        .lock()
        .map_err(|_| "调声档案写入锁已损坏。".to_string())?;
    let path = profile_path(&normalized);
    let suggested = parameters_from_features(&features);
    let profile = match read_profile(&path)? {
        Some(mut profile) => {
            let samples = profile.source_samples.saturating_add(1);
            let weight = 1.0 / f64::from(samples.min(32));
            blend_features(&mut profile.average_features, &features, weight);
            blend_parameters(&mut profile.parameters, &suggested, weight);
            profile.source_samples = samples;
            profile.voice_name = voice_name;
            profile.updated_at_utc = Utc::now().to_rfc3339();
            profile
        }
        None => TuningProfile {
            voice_name,
            normalized_voice_name: normalized,
            source_samples: 1,
            outcome_samples: 0,
            average_features: features,
            parameters: suggested,
            updated_at_utc: Utc::now().to_rfc3339(),
        },
    };
    write_profile(&path, &profile)?;
    Ok(profile)
}

pub fn get(voice_name: &str) -> Result<TuningProfile, String> {
    let (_, normalized) = validate_voice_name(voice_name)?;
    read_profile(&profile_path(&normalized))?
        .ok_or_else(|| format!("尚未为声库 {voice_name} 建立调声档案。"))
}

pub fn list() -> Result<Vec<TuningProfile>, String> {
    let root = profiles_root();
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut profiles = fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| read_profile(&entry.path()).ok().flatten())
        .collect::<Vec<_>>();
    profiles.sort_by(|left, right| left.voice_name.cmp(&right.voice_name));
    Ok(profiles)
}

pub fn record_outcome(
    voice_name: &str,
    candidate: TuningParameters,
    improvement: f64,
) -> Result<TuningProfile, String> {
    validate_parameters(&candidate)?;
    if !improvement.is_finite() || !(-1.0..=1.0).contains(&improvement) {
        return Err("A/B 改善分数必须在 -1 到 1 之间。".to_string());
    }
    let (_, normalized) = validate_voice_name(voice_name)?;
    let _guard = profile_lock()
        .lock()
        .map_err(|_| "调声档案写入锁已损坏。".to_string())?;
    let path = profile_path(&normalized);
    let mut profile =
        read_profile(&path)?.ok_or_else(|| format!("尚未为声库 {voice_name} 建立调声档案。"))?;
    let weight = improvement.abs() * 0.25;
    if improvement >= 0.0 {
        blend_parameters(&mut profile.parameters, &candidate, weight);
    } else {
        move_parameters_away(&mut profile.parameters, &candidate, weight);
    }
    profile.outcome_samples = profile.outcome_samples.saturating_add(1);
    profile.updated_at_utc = Utc::now().to_rfc3339();
    write_profile(&path, &profile)?;
    Ok(profile)
}

fn parameters_from_features(features: &SourceStyleFeatures) -> TuningParameters {
    TuningParameters {
        loudness: ((features.dynamic_range_db - 18.0) * 0.12).clamp(-3.0, 3.0),
        tension: (((features.brightness_hz - 2_000.0) / 4_000.0)
            + ((features.pitch_range_semitones - 12.0) / 48.0))
            .clamp(-0.6, 0.6),
        breathiness: ((features.breathiness_proxy - 0.18) * 2.0).clamp(-0.5, 0.7),
        gender: 0.0,
        tone_shift: ((features.median_pitch_midi - 64.0) / 64.0).clamp(-0.25, 0.25),
        vibrato_strength: ((features.vibrato_depth_cents / 100.0)
            * (features.vibrato_rate_hz / 6.0))
            .clamp(0.0, 1.5),
    }
}

fn validate_voice_name(value: &str) -> Result<(String, String), String> {
    let display = value.trim();
    if display.is_empty() || display.chars().count() > 200 {
        return Err("声库名称不能为空且不能超过 200 个字符。".to_string());
    }
    let normalized = display.to_lowercase();
    Ok((display.to_string(), normalized))
}

fn validate_features(value: &SourceStyleFeatures) -> Result<(), String> {
    let values = [
        value.duration_sec,
        value.median_pitch_midi,
        value.pitch_range_semitones,
        value.vibrato_rate_hz,
        value.vibrato_depth_cents,
        value.dynamic_range_db,
        value.breathiness_proxy,
        value.brightness_hz,
        value.voiced_ratio,
    ];
    if values.iter().any(|value| !value.is_finite()) || value.duration_sec <= 0.0 {
        return Err("参考人声特征包含无效数值。".to_string());
    }
    Ok(())
}

fn validate_parameters(value: &TuningParameters) -> Result<(), String> {
    let bounded = [
        (value.loudness, -48.0, 12.0),
        (value.tension, -1.0, 1.0),
        (value.breathiness, -1.0, 1.0),
        (value.gender, -1.0, 1.0),
        (value.tone_shift, -1.0, 1.0),
        (value.vibrato_strength, 0.0, 2.0),
    ];
    if bounded
        .iter()
        .any(|(value, minimum, maximum)| !value.is_finite() || value < minimum || value > maximum)
    {
        return Err("调声参数超出 SynthV 安全范围。".to_string());
    }
    Ok(())
}

fn blend_features(target: &mut SourceStyleFeatures, sample: &SourceStyleFeatures, weight: f64) {
    target.duration_sec = blend(target.duration_sec, sample.duration_sec, weight);
    target.median_pitch_midi = blend(target.median_pitch_midi, sample.median_pitch_midi, weight);
    target.pitch_range_semitones = blend(
        target.pitch_range_semitones,
        sample.pitch_range_semitones,
        weight,
    );
    target.vibrato_rate_hz = blend(target.vibrato_rate_hz, sample.vibrato_rate_hz, weight);
    target.vibrato_depth_cents = blend(
        target.vibrato_depth_cents,
        sample.vibrato_depth_cents,
        weight,
    );
    target.dynamic_range_db = blend(target.dynamic_range_db, sample.dynamic_range_db, weight);
    target.breathiness_proxy = blend(target.breathiness_proxy, sample.breathiness_proxy, weight);
    target.brightness_hz = blend(target.brightness_hz, sample.brightness_hz, weight);
    target.voiced_ratio = blend(target.voiced_ratio, sample.voiced_ratio, weight);
}

fn blend_parameters(target: &mut TuningParameters, sample: &TuningParameters, weight: f64) {
    target.loudness = blend(target.loudness, sample.loudness, weight).clamp(-48.0, 12.0);
    target.tension = blend(target.tension, sample.tension, weight).clamp(-1.0, 1.0);
    target.breathiness = blend(target.breathiness, sample.breathiness, weight).clamp(-1.0, 1.0);
    target.gender = blend(target.gender, sample.gender, weight).clamp(-1.0, 1.0);
    target.tone_shift = blend(target.tone_shift, sample.tone_shift, weight).clamp(-1.0, 1.0);
    target.vibrato_strength =
        blend(target.vibrato_strength, sample.vibrato_strength, weight).clamp(0.0, 2.0);
}

fn move_parameters_away(target: &mut TuningParameters, rejected: &TuningParameters, weight: f64) {
    let opposite = TuningParameters {
        loudness: target.loudness + (target.loudness - rejected.loudness),
        tension: target.tension + (target.tension - rejected.tension),
        breathiness: target.breathiness + (target.breathiness - rejected.breathiness),
        gender: target.gender + (target.gender - rejected.gender),
        tone_shift: target.tone_shift + (target.tone_shift - rejected.tone_shift),
        vibrato_strength: target.vibrato_strength
            + (target.vibrato_strength - rejected.vibrato_strength),
    };
    blend_parameters(target, &opposite, weight);
}

fn blend(current: f64, sample: f64, weight: f64) -> f64 {
    current + (sample - current) * weight.clamp(0.0, 1.0)
}

fn profile_lock() -> &'static Mutex<()> {
    PROFILE_LOCK.get_or_init(|| Mutex::new(()))
}

fn profiles_root() -> PathBuf {
    data_root().join("tuning-profiles")
}

fn profile_path(normalized_voice_name: &str) -> PathBuf {
    let digest = Sha256::digest(normalized_voice_name.as_bytes());
    profiles_root().join(format!("{:x}.json", digest))
}

fn read_profile(path: &Path) -> Result<Option<TuningProfile>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("调声档案无法解析：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_profile(path: &Path, profile: &TuningProfile) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "调声档案路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if fs::symlink_metadata(parent).is_ok_and(|metadata| metadata.file_type().is_symlink())
        || fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("调声档案目录或文件不能是符号链接。".to_string());
    }
    let temporary = parent.join(format!(".profile-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(profile).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    replace_profile_file(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

#[cfg(windows)]
fn replace_profile_file(source: &Path, target: &Path) -> std::io::Result<()> {
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
fn replace_profile_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}
