#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use serde::Deserialize;

use sv2_regression::sv2_concurrent::{
    detect_provider, launch_slot, slot_running_pids, Sv2ConcurrentContentPreferences,
    Sv2ConcurrentDefaults,
};
use uuid::Uuid;

fn slot_root(vault: &Path, id: &str) -> PathBuf {
    vault.join("slots").join(id)
}

fn overlay(root: &Path) -> PathBuf {
    root.join("user/current/AppData/Roaming/Dreamtonics/Synthesizer V Studio 2")
}

#[derive(Deserialize)]
struct Report { actual: String, expected: String, matched: bool, error: Option<String> }

fn config(root: &Path, slot: &Path, nonce: &str) -> PathBuf {
    let path = root.join(format!("{nonce}.json"));
    let value = serde_json::json!({
        "expected_slot": slot,
        "report_path": slot.join(format!("{nonce}.report.json")),
        "nonce": nonce,
    });
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    path
}

fn report(slot: &Path, nonce: &str) -> Report {
    let path = slot.join(format!("{nonce}.report.json"));
    for _ in 0..30 {
        if path.is_file() { return serde_json::from_slice(&fs::read(path).unwrap()).unwrap(); }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    panic!("helper did not produce a fixture report");
}

fn cleanup_box(sbie_ini: &Path, root: &Path, slot: &str) {
    let marker: serde_json::Value = serde_json::from_slice(&fs::read(root.join(".synthv-toolbox-instance.json")).unwrap()).unwrap();
    let instance = marker["instanceId"].as_str().unwrap();
    let slot_compact = Uuid::parse_str(slot).unwrap().simple().to_string();
    let instance_compact = Uuid::parse_str(instance).unwrap().simple().to_string();
    let name = format!("SV2TB{}{}", &slot_compact[..12], &instance_compact[..12]);
    let expected = root.canonicalize().unwrap();
    let output = std::process::Command::new(sbie_ini).args(["queryex", &name, "FileRootPath"]).output().unwrap();
    assert!(output.status.success());
    let output_text = String::from_utf8_lossy(&output.stdout);
    let actual = output_text.lines().last().unwrap_or_default().trim().trim_start_matches("FileRootPath=").trim_start_matches(r"\??\");
    assert_eq!(PathBuf::from(actual).canonicalize().unwrap(), expected);
    let status = std::process::Command::new(sbie_ini).args(["set", &name, "*", ""]).status().unwrap();
    assert!(status.success());
}

fn sbie_ini() -> PathBuf {
    for name in ["Sandboxie", "Sandboxie-Plus"] {
        let path = PathBuf::from(std::env::var_os("ProgramFiles").unwrap()).join(name).join("SbieIni.exe");
        if path.is_file() { return path; }
    }
    panic!("Sandboxie SbieIni.exe was not found")
}

#[test]
#[ignore = "requires a local Sandboxie installation; run explicitly"]
fn sandboxie_routes_each_helper_to_its_own_slot() {
    let provider = detect_provider().expect("Sandboxie must be installed");
    let root = std::env::temp_dir().join(format!("sv2-sandbox-smoke-{}", Uuid::new_v4()));
    let vault = root.join("vault");
    let first = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    for id in [&first, &second] {
        fs::create_dir_all(slot_root(&vault, id)).unwrap();
        fs::write(
            slot_root(&vault, id).join(".synthv-toolbox-slot.json"),
            format!("{{\"schemaVersion\":1,\"slotId\":\"{id}\"}}"),
        )
        .unwrap();
    }
    let helper = PathBuf::from(env!("CARGO_BIN_EXE_sandboxie_smoke_helper"));
    let content = Sv2ConcurrentContentPreferences::default().resolve(Sv2ConcurrentDefaults::default());
    let first_a = config(&root, &slot_root(&vault, &first), "first-a");
    let first_b = config(&root, &slot_root(&vault, &first), "first-b");
    let second_config = config(&root, &slot_root(&vault, &second), "second");
    launch_slot(&provider, &vault, &first, &helper, Some(&first_a), &slot_root(&vault, &first), content).unwrap();
    launch_slot(&provider, &vault, &first, &helper, Some(&first_b), &slot_root(&vault, &first), content).unwrap();
    launch_slot(&provider, &vault, &second, &helper, Some(&second_config), &slot_root(&vault, &second), content).unwrap();
    let first_pids = slot_running_pids(&provider, &vault, &first).unwrap();
    let second_pids = slot_running_pids(&provider, &vault, &second).unwrap();
    assert!(first_pids.len() >= 2, "two same-slot helpers must overlap");
    assert!(!second_pids.is_empty());
    assert!(first_pids.iter().all(|pid| !second_pids.contains(pid)));
    let first_overlay = vault.join("instances").join(Uuid::parse_str(&first).unwrap().simple().to_string()[..16].to_string());
    let second_overlay = vault.join("instances").join(Uuid::parse_str(&second).unwrap().simple().to_string()[..16].to_string());
    assert_eq!(fs::read_dir(&first_overlay).unwrap().count(), 1, "same account must reuse one Sandboxie instance root");
    let first_instance = fs::read_dir(&first_overlay).unwrap().next().unwrap().unwrap().path();
    let second_instance = fs::read_dir(&second_overlay).unwrap().next().unwrap().unwrap().path();
    assert_eq!(overlay(&first_instance).canonicalize().unwrap(), slot_root(&vault, &first).canonicalize().unwrap());
    assert_eq!(overlay(&second_instance).canonicalize().unwrap(), slot_root(&vault, &second).canonicalize().unwrap());
    for nonce in ["first-a", "first-b", "second"] {
        let slot = if nonce == "second" { slot_root(&vault, &second) } else { slot_root(&vault, &first) };
        let report = report(&slot, nonce);
        assert!(report.matched, "{} != {}: {:?}", report.actual, report.expected, report.error);
    }
    for nonce in ["first-a", "first-b"] {
        assert_eq!(fs::read(slot_root(&vault, &first).join(format!("sandboxie-smoke-{nonce}.txt"))).unwrap(), nonce.as_bytes());
        assert!(!slot_root(&vault, &second).join(format!("sandboxie-smoke-{nonce}.txt")).exists());
    }
    assert_eq!(fs::read(slot_root(&vault, &second).join("sandboxie-smoke-second.txt")).unwrap(), b"second");
    for _ in 0..75 {
        if slot_running_pids(&provider, &vault, &first).unwrap().is_empty()
            && slot_running_pids(&provider, &vault, &second).unwrap().is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    assert!(slot_running_pids(&provider, &vault, &first).unwrap().is_empty());
    assert!(slot_running_pids(&provider, &vault, &second).unwrap().is_empty());
    let sbie_ini = sbie_ini();
    for entry in fs::read_dir(&first_overlay).unwrap().chain(fs::read_dir(&second_overlay).unwrap()) {
        let instance = entry.unwrap().path();
        let slot = if instance.starts_with(&first_overlay) { &first } else { &second };
        cleanup_box(&sbie_ini, &instance, slot);
    }
    let _ = fs::remove_dir_all(root);
}
