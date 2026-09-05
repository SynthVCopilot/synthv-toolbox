#![cfg(windows)]

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use synthv_control_regression::synthv_control::{
    focus_instance, list_processes, terminate_instance, SynthVProcess,
};

struct Fixture {
    root: PathBuf,
    children: Vec<Child>,
}

impl Fixture {
    fn new() -> io::Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "synthv-control-regression-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("Synthesizer V Studio 2 Pro"))?;
        Ok(Self {
            root,
            children: Vec::new(),
        })
    }

    fn launch(&mut self, number: usize) -> io::Result<()> {
        let target = self
            .root
            .join("Synthesizer V Studio 2 Pro")
            .join(format!("instance-{number}"))
            .join("synthv-studio.exe");
        let parent = target.parent().expect("fixture executable parent");
        fs::create_dir_all(parent)?;
        fs::copy(env!("CARGO_BIN_EXE_synthv-control-helper"), &target)?;
        let mut command = Command::new(target);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        self.children.push(command.spawn()?);
        Ok(())
    }

    fn owns_path(&self, path: &Path) -> bool {
        path.starts_with(&self.root) && self.root.starts_with(std::env::temp_dir())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for child in &mut self.children {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if self.owns_path(&self.root) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn process_for_path(path: &Path) -> SynthVProcess {
    for _ in 0..40 {
        if let Ok(processes) = list_processes() {
            if let Some(process) = processes
                .into_iter()
                .find(|process| Path::new(&process.command) == path)
            {
                return process;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("fixture process was not enumerated: {}", path.display());
}

#[test]
fn controls_only_the_verified_fixture_instance() {
    let mut fixture = Fixture::new().expect("create random fixture");
    fixture.launch(1).expect("launch first helper");
    fixture.launch(2).expect("launch second helper");
    let first_path = fixture
        .root
        .join("Synthesizer V Studio 2 Pro")
        .join("instance-1")
        .join("synthv-studio.exe");
    let second_path = fixture
        .root
        .join("Synthesizer V Studio 2 Pro")
        .join("instance-2")
        .join("synthv-studio.exe");
    let first = process_for_path(&first_path);
    let second = process_for_path(&second_path);
    assert!(first.is_sv2 && second.is_sv2);
    assert!(!first.process_identity.is_empty());
    assert!(!second.process_identity.is_empty());
    assert_eq!(first.product_name, "SVStudio2 Pro");
    assert!(first.version.is_empty());

    assert!(terminate_instance(first.process_id, "stale-identity".to_string()).is_err());
    assert!(fixture.children[0]
        .try_wait()
        .expect("check first helper")
        .is_none());
    assert!(fixture.children[1]
        .try_wait()
        .expect("check second helper")
        .is_none());

    assert!(focus_instance(first.process_id, first.process_identity.clone()).is_err());
    assert!(fixture.children[0]
        .try_wait()
        .expect("check first helper")
        .is_none());

    terminate_instance(first.process_id, first.process_identity)
        .expect("terminate only first helper");
    assert!(fixture.children[0]
        .wait()
        .expect("wait first helper")
        .success());
    assert!(fixture.children[1]
        .try_wait()
        .expect("check second helper")
        .is_none());

    terminate_instance(second.process_id, second.process_identity)
        .expect("terminate second helper");
    assert!(fixture.children[1]
        .wait()
        .expect("wait second helper")
        .success());
}
