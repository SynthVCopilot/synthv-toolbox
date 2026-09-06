use super::*;
use std::sync::OnceLock;

fn temporary_test_base() -> PathBuf {
    let root = std::env::temp_dir();
    #[cfg(target_os = "macos")]
    {
        fs::canonicalize(root).expect("macOS test temp root must be canonicalizable")
    }
    #[cfg(not(target_os = "macos"))]
    {
        root
    }
}

fn fake_runtime_root() -> &'static PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = temporary_test_base().join(format!(
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
    println!("{}", r#"{"format":{"format_name":"wav","duration":"2.0","bit_rate":"2304000"},"streams":[{"codec_type":"audio","codec_name":"pcm_s24le","sample_rate":"48000","channels":2,"channel_layout":"stereo","bits_per_sample":24}]}"#);
    return;
}
if let Some(input) = input {
    if input.contains("fail") {
        eprintln!("intentional fake FFmpeg failure");
        std::process::exit(23);
    }
}
if args.iter().any(|arg| arg.contains("print_format=json")) {
    eprintln!("{}", r#"{"input_i":"-21.0","input_tp":"-3.0","input_lra":"4.0","input_thresh":"-31.0","target_offset":"0.2"}"#);
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
    let case_root = temporary_test_base().join(format!(
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
        temporary_test_base().join(format!("synthv-toolbox-output-safety-{}", Uuid::new_v4()));
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

    let base = temporary_test_base().join(format!("synthv-toolbox-output-link-{}", Uuid::new_v4()));
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

    let root = temporary_test_base().join(format!("synthv-toolbox-input-link-{}", Uuid::new_v4()));
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

    let root = temporary_test_base().join(format!("synthv-toolbox-input-link-{}", Uuid::new_v4()));
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
        temporary_test_base().join(format!("synthv-toolbox-status-failure-{}", Uuid::new_v4()));
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
    assert!(failed.artifact_id.is_none());
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
    let root = temporary_test_base().join(format!(
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
        None,
        Some(managed.clone()),
        bundled.clone(),
        vec![path.clone()],
    )
    .unwrap();
    assert_eq!(runtime.source, "managed");

    let error = resolve_runtime_from_candidates(
        Some(root.join("missing")),
        Some(managed),
        bundled.clone(),
        vec![path.clone()],
    )
    .unwrap_err();
    assert!(error.contains("已选择的 FFmpeg 目录"));

    let runtime = resolve_runtime_from_candidates(None, None, bundled, vec![path.clone()]).unwrap();
    assert_eq!(runtime.source, "bundled");

    let runtime =
        resolve_runtime_from_candidates(None, None, root.join("missing-bundle"), vec![path])
            .unwrap();
    assert_eq!(runtime.source, "path");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn selected_ffmpeg_directory_requires_executable_pair_and_returns_an_absolute_path() {
    let directory = fake_runtime_root().join("ffmpeg");
    let selected = crate::components::validate_ffmpeg_directory(&directory.to_string_lossy())
        .await
        .unwrap();
    assert!(selected.is_absolute());

    let root =
        temporary_test_base().join(format!("synthv-toolbox-nonexecutable-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let (ffmpeg_name, ffprobe_name) = if cfg!(windows) {
        ("ffmpeg.exe", "ffprobe.exe")
    } else {
        ("ffmpeg", "ffprobe")
    };
    fs::write(root.join(ffmpeg_name), b"not an executable").unwrap();
    fs::write(root.join(ffprobe_name), b"not an executable").unwrap();
    assert!(
        crate::components::validate_ffmpeg_directory(&root.to_string_lossy())
            .await
            .is_err()
    );
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
    assert!(cancelled.artifact_id.is_none());
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

fn registered_output_service(label: &str) -> (Arc<AudioPreparationService>, PathBuf, String) {
    let (service, case_root) = fake_service(label);
    fs::create_dir_all(&service.output_root).unwrap();
    let output = service.output_root.join("prepared.wav");
    fs::write(&output, b"0123456789").unwrap();
    let root = fs::canonicalize(&service.output_root).unwrap();
    let artifact = service
        .register_completed_artifact(&output.to_string_lossy(), &root, "pcm-prepare")
        .unwrap();
    (service, case_root, artifact)
}

#[test]
fn artifact_ids_and_ranges_are_strict_and_bounded() {
    let id = Uuid::new_v4().to_string();
    assert_eq!(parse_artifact_id(&id).unwrap(), id);
    assert!(parse_artifact_id(&id.to_uppercase()).is_err());
    assert!(parse_artifact_id("not-a-uuid").is_err());
    assert_eq!(parse_single_range("bytes=2-5", 10), Some(2..6));
    assert_eq!(parse_single_range("bytes=-3", 10), Some(7..10));
    assert_eq!(parse_single_range("bytes=8-", 10), Some(8..10));
    assert!(parse_single_range("bytes=0-1,3-4", 10).is_none());
    assert!(parse_single_range("bytes=11-12", 10).is_none());
}

#[test]
fn protocol_only_serves_registered_uuid_paths_and_range_requests() {
    let (service, case_root, artifact) = registered_output_service("artifact-protocol");
    let request = http::Request::builder()
        .method("GET")
        .uri(format!("toolbox-audio://localhost/{artifact}"))
        .header("range", "bytes=2-5")
        .body(Vec::new())
        .unwrap();
    let response = service.serve_audio_artifact_request(&request);
    assert_eq!(response.status(), http::StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
    assert_eq!(response.body(), b"2345");
    assert_eq!(response.headers()["content-type"], "audio/wav");
    for uri in [
        format!("toolbox-audio://localhost/{artifact}?x=1"),
        format!("toolbox-audio://localhost/{artifact}/extra"),
        "toolbox-audio://localhost/not-a-uuid".to_string(),
        format!("toolbox-audio://example.test/{artifact}"),
    ] {
        let request = http::Request::builder().uri(uri).body(Vec::new()).unwrap();
        assert_eq!(
            service.serve_audio_artifact_request(&request).status(),
            http::StatusCode::BAD_REQUEST
        );
    }
    let mapped = http::Request::builder()
        .method("HEAD")
        .uri(format!("http://toolbox-audio.localhost/{artifact}"))
        .body(Vec::new())
        .unwrap();
    let mapped_response = service.serve_audio_artifact_request(&mapped);
    assert_eq!(mapped_response.status(), http::StatusCode::OK);
    assert_eq!(mapped_response.headers()["content-length"], "10");
    assert!(mapped_response.body().is_empty());
    fs::remove_dir_all(case_root).unwrap();
}

#[test]
fn protocol_get_without_range_returns_the_complete_large_representation() {
    let (service, case_root, _) = registered_output_service("artifact-full-get");
    let output = service.output_root.join("full-get.wav");
    let expected_length = MAX_PROTOCOL_RESPONSE_BYTES + 1;
    let file = fs::File::create(&output).unwrap();
    file.set_len(expected_length).unwrap();
    drop(file);
    let root = fs::canonicalize(&service.output_root).unwrap();
    let artifact = service
        .register_completed_artifact(&output.to_string_lossy(), &root, "pcm-prepare")
        .unwrap();

    let request = http::Request::builder()
        .method("GET")
        .uri(format!("toolbox-audio://localhost/{artifact}"))
        .body(Vec::new())
        .unwrap();
    let response = service.serve_audio_artifact_request(&request);
    assert_eq!(response.status(), http::StatusCode::OK);
    assert_eq!(
        response.headers()["content-length"],
        expected_length.to_string()
    );
    assert!(response.headers().get("content-range").is_none());
    assert_eq!(response.headers()["accept-ranges"], "bytes");
    assert_eq!(response.body().len(), expected_length as usize);

    let range_request = http::Request::builder()
        .method("GET")
        .uri(format!("toolbox-audio://localhost/{artifact}"))
        .header("range", "bytes=0-")
        .body(Vec::new())
        .unwrap();
    let range_response = service.serve_audio_artifact_request(&range_request);
    assert_eq!(range_response.status(), http::StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        range_response.headers()["content-length"],
        MAX_PROTOCOL_RESPONSE_BYTES.to_string()
    );
    assert_eq!(
        range_response.headers()["content-range"],
        format!(
            "bytes 0-{}/{}",
            MAX_PROTOCOL_RESPONSE_BYTES - 1,
            expected_length
        )
    );
    assert_eq!(
        range_response.body().len(),
        MAX_PROTOCOL_RESPONSE_BYTES as usize
    );

    let range_head_request = http::Request::builder()
        .method("HEAD")
        .uri(format!("toolbox-audio://localhost/{artifact}"))
        .header("range", "bytes=0-")
        .body(Vec::new())
        .unwrap();
    let range_head_response = service.serve_audio_artifact_request(&range_head_request);
    assert_eq!(
        range_head_response.status(),
        http::StatusCode::PARTIAL_CONTENT
    );
    assert_eq!(
        range_head_response.headers()["content-length"],
        MAX_PROTOCOL_RESPONSE_BYTES.to_string()
    );
    assert_eq!(
        range_head_response.headers()["content-range"],
        format!(
            "bytes 0-{}/{}",
            MAX_PROTOCOL_RESPONSE_BYTES - 1,
            expected_length
        )
    );
    assert!(range_head_response.body().is_empty());

    let head_request = http::Request::builder()
        .method("HEAD")
        .uri(format!("toolbox-audio://localhost/{artifact}"))
        .body(Vec::new())
        .unwrap();
    let head_response = service.serve_audio_artifact_request(&head_request);
    assert_eq!(head_response.status(), http::StatusCode::OK);
    assert_eq!(
        head_response.headers()["content-length"],
        expected_length.to_string()
    );
    assert!(head_response.headers().get("content-range").is_none());
    assert_eq!(head_response.headers()["accept-ranges"], "bytes");
    assert!(head_response.body().is_empty());
    fs::remove_dir_all(case_root).unwrap();
}

#[test]
fn protocol_enforces_the_unranged_full_response_limit() {
    let (service, case_root, _) = registered_output_service("artifact-full-limit");
    let root = fs::canonicalize(&service.output_root).unwrap();
    let exact_output = service.output_root.join("at-full-limit.wav");
    let exact_file = fs::File::create(&exact_output).unwrap();
    exact_file
        .set_len(MAX_PROTOCOL_FULL_RESPONSE_BYTES)
        .unwrap();
    drop(exact_file);
    let exact_artifact = service
        .register_completed_artifact(&exact_output.to_string_lossy(), &root, "pcm-prepare")
        .unwrap();
    let exact_request = http::Request::builder()
        .method("GET")
        .uri(format!("toolbox-audio://localhost/{exact_artifact}"))
        .body(Vec::new())
        .unwrap();
    let exact_response = service.serve_audio_artifact_request(&exact_request);
    assert_eq!(exact_response.status(), http::StatusCode::OK);
    assert_eq!(
        exact_response.headers()["content-length"],
        MAX_PROTOCOL_FULL_RESPONSE_BYTES.to_string()
    );
    assert!(exact_response.headers().get("content-range").is_none());
    assert_eq!(
        exact_response.body().len(),
        MAX_PROTOCOL_FULL_RESPONSE_BYTES as usize
    );
    drop(exact_response);

    let oversized_output = service.output_root.join("over-full-limit.wav");
    let oversized_file = fs::File::create(&oversized_output).unwrap();
    oversized_file
        .set_len(MAX_PROTOCOL_FULL_RESPONSE_BYTES + 1)
        .unwrap();
    drop(oversized_file);
    let oversized_artifact = service
        .register_completed_artifact(&oversized_output.to_string_lossy(), &root, "pcm-prepare")
        .unwrap();
    for method in [http::Method::GET, http::Method::HEAD] {
        let request = http::Request::builder()
            .method(method)
            .uri(format!("toolbox-audio://localhost/{oversized_artifact}"))
            .body(Vec::new())
            .unwrap();
        let response = service.serve_audio_artifact_request(&request);
        assert_eq!(response.status(), http::StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            response.headers()["x-toolbox-audio-size"],
            (MAX_PROTOCOL_FULL_RESPONSE_BYTES + 1).to_string()
        );
        assert_eq!(
            response.headers()["x-toolbox-audio-limit"],
            MAX_PROTOCOL_FULL_RESPONSE_BYTES.to_string()
        );
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert!(response.headers().get("content-range").is_none());
        assert!(response.body().is_empty());
    }
    fs::remove_dir_all(case_root).unwrap();
}

#[test]
fn artifacts_only_exist_after_completed_regular_output_and_revalidate_links() {
    let (service, case_root) = fake_service("artifact-completion");
    fs::create_dir_all(&service.output_root).unwrap();
    let root = fs::canonicalize(&service.output_root).unwrap();
    let missing = service.output_root.join("missing.wav");
    assert!(service
        .register_completed_artifact(&missing.to_string_lossy(), &root, "pcm-prepare")
        .is_err());
    assert!(service.artifacts.lock().unwrap().is_empty());

    let output = service.output_root.join("complete.wav");
    fs::write(&output, b"audio").unwrap();
    let artifact = service
        .register_completed_artifact(&output.to_string_lossy(), &root, "pcm-prepare")
        .unwrap();
    assert!(service.audio_artifact_info(&artifact).is_ok());
    fs::write(&output, b"replacement audio payload").unwrap();
    assert!(service.audio_artifact_info(&artifact).is_err());
    assert!(service.validated_generated_artifact(&artifact).is_err());
    let request = http::Request::builder()
        .uri(format!("toolbox-audio://localhost/{artifact}"))
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        service.serve_audio_artifact_request(&request).status(),
        http::StatusCode::NOT_FOUND
    );
    #[cfg(unix)]
    {
        let outside = case_root.join("outside.wav");
        fs::write(&outside, b"outside").unwrap();
        fs::remove_file(&output).unwrap();
        std::os::unix::fs::symlink(&outside, &output).unwrap();
        assert!(service.audio_artifact_info(&artifact).is_err());
    }
    fs::remove_dir_all(case_root).unwrap();
}

#[test]
fn source_artifacts_remain_opaque_and_use_allowlisted_mime_types() {
    let (service, case_root) = fake_service("artifact-source");
    let aiff_probe = MediaProbe {
        path: "voice.aiff".to_string(),
        source_artifact_id: None,
        source_mime_type: None,
        container: Some("aiff".to_string()),
        codec: Some("pcm_s24be".to_string()),
        duration_seconds: None,
        sample_rate: None,
        channels: None,
        channel_layout: None,
        bit_depth: None,
        bit_rate: None,
    };
    assert_eq!(audio_mime_for_probe(&aiff_probe), Some("audio/aiff"));
    let source = case_root.join("original.mp3");
    fs::write(&source, b"source").unwrap();
    let artifact = service
        .register_source_artifact(&source, Some("audio/mpeg".to_string()))
        .unwrap();
    let info = service.audio_artifact_info(&artifact).unwrap();
    assert_eq!(info.mime_type.as_deref(), Some("audio/mpeg"));
    assert!(service.validated_generated_artifact(&artifact).is_err());
    #[cfg(windows)]
    assert_eq!(
        info.media_url,
        format!("http://toolbox-audio.localhost/{artifact}")
    );
    #[cfg(not(windows))]
    assert_eq!(
        info.media_url,
        format!("toolbox-audio://localhost/{artifact}")
    );
    assert!(!serde_json::to_string(&info)
        .unwrap()
        .contains(&source.to_string_lossy().to_string()));
    fs::remove_dir_all(case_root).unwrap();
}

#[test]
fn safe_copy_never_overwrites_and_reveal_uses_argument_arrays() {
    let root = temporary_test_base().join(format!("toolbox-copy-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.wav");
    let destination = root.join("saved.wav");
    fs::write(&source, b"result").unwrap();
    safe_copy_artifact(&source, &destination).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"result");
    fs::write(&source, b"replacement").unwrap();
    assert!(safe_copy_artifact(&source, &destination).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"result");
    #[cfg(unix)]
    {
        let real_parent = root.join("real-parent");
        let normal_child = real_parent.join("normal-child");
        fs::create_dir_all(&normal_child).unwrap();
        let linked_parent = root.join("linked-parent");
        std::os::unix::fs::symlink(&real_parent, &linked_parent).unwrap();
        let escaped_destination = linked_parent.join("normal-child").join("escaped.wav");
        assert!(safe_copy_artifact(&source, &escaped_destination).is_err());
        assert!(!escaped_destination.exists());
    }
    #[cfg(windows)]
    {
        let (program, args) = reveal_command_for_path(&source).unwrap();
        assert_eq!(program, OsStr::new("explorer.exe"));
        assert_eq!(args[0], OsStr::new("/select,"));
        assert_eq!(args[1], source.as_os_str());
    }
    #[cfg(target_os = "macos")]
    {
        let (program, args) = reveal_command_for_path(&source).unwrap();
        assert_eq!(program, OsStr::new("/usr/bin/open"));
        assert_eq!(args[0], OsStr::new("-R"));
        assert_eq!(args[1], source.as_os_str());
    }
    fs::remove_dir_all(root).unwrap();
}

#[cfg(not(windows))]
#[test]
fn portable_no_replace_fallback_copies_new_files_without_touching_existing_ones() {
    let root = temporary_test_base().join(format!("toolbox-copy-fallback-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let temporary = root.join("new.tmp");
    let destination = root.join("saved.wav");
    fs::write(&temporary, b"saved-result").unwrap();
    commit_temporary_copy_new(&temporary, &destination).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"saved-result");
    assert!(!temporary.exists());

    let replacement = root.join("replacement.tmp");
    fs::write(&replacement, b"replacement-result").unwrap();
    assert!(commit_temporary_copy_new(&replacement, &destination).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"saved-result");
    assert!(replacement.exists());
    fs::remove_dir_all(root).unwrap();
}
