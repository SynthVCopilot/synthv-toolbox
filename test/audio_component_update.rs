use super::audio_component_payload_current;
use std::fs;

#[test]
fn detects_old_scripts_and_dependency_manifests_before_reusing_audio_runtime() {
    let root = std::env::temp_dir().join(format!("audio-component-{}", uuid::Uuid::new_v4()));
    let installed = root.join("installed");
    let bundled = root.join("bundled");
    fs::create_dir_all(&installed).unwrap();
    fs::create_dir_all(&bundled).unwrap();
    let script = installed.join("pi_audio.py");
    assert!(!audio_component_payload_current(&script, &bundled));
    for directory in [&installed, &bundled] {
        fs::write(directory.join("pi_audio.py"), "transcribe").unwrap();
        fs::write(directory.join("requirements.txt"), "faster-whisper").unwrap();
    }
    assert!(audio_component_payload_current(&script, &bundled));
    fs::write(&script, "old-script").unwrap();
    assert!(!audio_component_payload_current(&script, &bundled));
    fs::write(&script, "transcribe").unwrap();
    fs::write(installed.join("requirements.txt"), "basic-pitch").unwrap();
    assert!(!audio_component_payload_current(&script, &bundled));
    fs::remove_dir_all(root).unwrap();
}
