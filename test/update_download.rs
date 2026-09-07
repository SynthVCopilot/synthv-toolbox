use super::*;
use std::io::Cursor;

fn isolated_manager() -> Manager {
    Manager {
        state: Mutex::new(ToolboxUpdateDownload {
            status: "downloading".into(),
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            file_name: None,
        }),
        cancel: AtomicBool::new(false),
        file: Mutex::new(None),
    }
}
fn fixture(bytes: &[u8]) -> ToolboxUpdateAsset {
    ToolboxUpdateAsset { name: "SynthV.Toolbox_0.1.7_dev.abcdef0_x64-setup.exe".into(), url: "https://github.com/SynthVCopilot/synthv-toolbox/releases/download/v0.1.7-nightly/SynthV.Toolbox_0.1.7_dev.abcdef0_x64-setup.exe".into(), size: bytes.len() as u64, sha256: format!("{:x}", Sha256::digest(bytes)) }
}
struct TestDirectory(PathBuf);
impl TestDirectory {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(&self.0) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
        let _ = fs::remove_dir(&self.0);
    }
}
fn root() -> TestDirectory {
    let path = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("toolbox-update-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    TestDirectory(path)
}

#[test]
fn verified_download_is_saved_and_tampering_is_rejected() {
    let dir = root();
    let manager = isolated_manager();
    let data = b"test installer payload";
    let asset = fixture(data);
    receive_update(&manager, asset.clone(), dir.path(), Cursor::new(data)).unwrap();
    assert_eq!(manager.state.lock().unwrap().status, "ready");
    assert_eq!(
        manager.state.lock().unwrap().downloaded_bytes,
        data.len() as u64
    );
    let path = dir.path().join(&asset.name);
    assert_eq!(fs::read(&path).unwrap(), data);
    verify_installer(&path, &asset).unwrap();
    fs::write(&path, b"modified").unwrap();
    assert!(verify_installer(&path, &asset).is_err());
}

#[test]
fn wrong_checksum_short_and_oversized_streams_never_become_ready() {
    for data in [b"xxxx".as_slice(), b"abc".as_slice(), b"abcde".as_slice()] {
        let dir = root();
        let manager = isolated_manager();
        assert!(receive_update(&manager, fixture(b"abcd"), dir.path(), Cursor::new(data)).is_err());
        assert!(manager.file.lock().unwrap().is_none());
        assert_ne!(manager.state.lock().unwrap().status, "ready");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[test]
fn cancellation_and_read_errors_clean_partial_files_and_allow_retry() {
    struct Failing;
    impl Read for Failing {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("interrupted connection"))
        }
    }
    let dir = root();
    let manager = isolated_manager();
    let asset = fixture(b"abcd");
    manager.cancel.store(true, Ordering::SeqCst);
    assert!(receive_update(&manager, asset.clone(), dir.path(), Cursor::new(b"abcd")).is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    manager.cancel.store(false, Ordering::SeqCst);
    assert!(receive_update(&manager, asset.clone(), dir.path(), Failing).is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    receive_update(&manager, asset, dir.path(), Cursor::new(b"abcd")).unwrap();
    assert_eq!(manager.state.lock().unwrap().status, "ready");
}

#[test]
fn invalid_metadata_is_rejected_before_writing() {
    let dir = root();
    let manager = isolated_manager();
    let mut asset = fixture(b"abcd");
    asset.name = "../escape.exe".into();
    assert!(receive_update(&manager, asset, dir.path(), Cursor::new(b"abcd")).is_err());
    let mut asset = fixture(b"abcd");
    asset.url = "https://example.test/update.exe".into();
    assert!(receive_update(&manager, asset, dir.path(), Cursor::new(b"abcd")).is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn symlink_destination_is_rejected() {
    let dir = root();
    let outside = root();
    let linked = dir.path().join("updates");
    std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
    assert!(receive_update(
        &isolated_manager(),
        fixture(b"abcd"),
        &linked,
        Cursor::new(b"abcd")
    )
    .is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
