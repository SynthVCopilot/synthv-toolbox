#![allow(dead_code)]

use std::{fs, path::PathBuf};

#[path = "../src/PiDesktop.Tauri/src-tauri/src/local_credential_store.rs"]
mod local_credential_store;
use local_credential_store::Store;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("credentials-{}", uuid::Uuid::new_v4()));
        Self(root)
    }
    fn store(&self) -> Store {
        Store::new(self.0.clone())
    }
    fn files(&self) -> Vec<PathBuf> {
        fn walk(root: &std::path::Path, result: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(root).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, result);
                } else {
                    result.push(path);
                }
            }
        }
        let mut result = vec![];
        walk(&self.0, &mut result);
        result
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reopen_overwrite_delete_and_isolate_credentials() {
    let fixture = Fixture::new();
    let store = fixture.store();
    assert!(store.read("oauth", "one").unwrap().is_none());
    store.delete("oauth", "one").unwrap();
    let token = b"refresh-secret-value-that-must-never-appear-on-disk";
    store.write("oauth", "one", token).unwrap();
    store
        .write("api-key", "one", b"different-provider")
        .unwrap();
    store.write("oauth", "two", b"different-account").unwrap();
    drop(store);
    let reopened = fixture.store();
    assert_eq!(
        &**reopened.read("oauth", "one").unwrap().as_ref().unwrap(),
        token
    );
    for path in fixture.files() {
        assert!(!fs::read(path)
            .unwrap()
            .windows(token.len())
            .any(|w| w == token));
    }
    reopened
        .write("oauth", "one", b"new-refresh-token")
        .unwrap();
    assert_eq!(
        &**fixture
            .store()
            .read("oauth", "one")
            .unwrap()
            .as_ref()
            .unwrap(),
        b"new-refresh-token"
    );
    reopened.delete("oauth", "one").unwrap();
    assert!(fixture.store().read("oauth", "one").unwrap().is_none());
    assert_eq!(
        &**reopened.read("api-key", "one").unwrap().as_ref().unwrap(),
        b"different-provider"
    );
    assert_eq!(
        &**reopened.read("oauth", "two").unwrap().as_ref().unwrap(),
        b"different-account"
    );
}

#[test]
fn writes_use_fresh_ciphertext_and_reject_tampering() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store.write("oauth", "one", b"same-secret").unwrap();
    let before: Vec<_> = fixture
        .files()
        .into_iter()
        .map(|p| {
            let b = fs::read(&p).unwrap();
            (p, b)
        })
        .collect();
    store.write("oauth", "one", b"same-secret").unwrap();
    let changed: Vec<_> = before
        .into_iter()
        .filter(|(p, b)| fs::read(p).unwrap() != *b)
        .collect();
    assert_eq!(changed.len(), 1);
    let (record, _) = &changed[0];
    let mut bytes = fs::read(record).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(record, bytes).unwrap();
    assert!(fixture.store().read("oauth", "one").is_err());
    fs::write(record, b"truncated").unwrap();
    assert!(fixture.store().read("oauth", "one").is_err());
}

#[test]
fn large_tokens_and_untrusted_identifiers_stay_inside_store() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let secret = vec![42; 100_000];
    store.write("../oauth", "../../escape", &secret).unwrap();
    assert_eq!(
        &**fixture
            .store()
            .read("../oauth", "../../escape")
            .unwrap()
            .as_ref()
            .unwrap(),
        secret.as_slice()
    );
    assert!(fixture.files().iter().all(|p| p.starts_with(&fixture.0)));
}

#[cfg(unix)]
#[test]
fn local_key_and_records_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.store().write("oauth", "one", b"private").unwrap();
    assert_eq!(
        fs::metadata(&fixture.0).unwrap().permissions().mode() & 0o077,
        0
    );
    for file in fixture.files() {
        assert_eq!(fs::metadata(file).unwrap().permissions().mode() & 0o077, 0);
    }
}

#[test]
fn missing_key_read_does_not_create_a_replacement_key() {
    let fixture = Fixture::new();
    fixture.store().write("oauth", "one", b"secret").unwrap();
    let key = fixture.0.join("key.bin");
    fs::remove_file(&key).unwrap();
    assert!(fixture.store().read("oauth", "one").is_err());
    assert!(!key.exists());
}

#[test]
fn concurrent_first_writes_remain_readable() {
    let fixture = Fixture::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|index| {
            let root = fixture.0.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Store::new(root)
                    .write("oauth", &index.to_string(), &[index])
                    .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    for index in 0..8u8 {
        assert_eq!(
            &**fixture
                .store()
                .read("oauth", &index.to_string())
                .unwrap()
                .as_ref()
                .unwrap(),
            &[index]
        );
    }
}

#[test]
fn swapped_ciphertext_cannot_be_loaded_as_another_account() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store.write("oauth", "one", b"account-one").unwrap();
    let first = fixture
        .files()
        .into_iter()
        .find(|p| p.file_name().unwrap() != "key.bin")
        .unwrap();
    store.write("oauth", "two", b"account-two").unwrap();
    let second = fixture
        .files()
        .into_iter()
        .find(|p| p.file_name().unwrap() != "key.bin" && *p != first)
        .unwrap();
    fs::copy(first, second).unwrap();
    assert!(store.read("oauth", "two").is_err());
}

mod agent {
    pub fn data_root() -> std::path::PathBuf {
        static ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        ROOT.get_or_init(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../.tmp")
                .join(format!("api-storage-{}", uuid::Uuid::new_v4()))
        })
        .clone()
    }
}
mod oauth {
    #[derive(Clone, Copy)]
    pub enum AiProviderId {
        Anthropic,
        OpenaiCodex,
        Workbuddy,
        Traecode,
    }
}
#[path = "../src/PiDesktop.Tauri/src-tauri/src/api_keys.rs"]
mod api_keys;

#[test]
fn api_key_save_replace_rollback_and_remove_use_local_store() {
    use oauth::AiProviderId::Anthropic;
    use zeroize::Zeroizing;
    let id = uuid::Uuid::new_v4().to_string();
    let first = Zeroizing::new("first-api-key".to_string());
    let second = Zeroizing::new("second-api-key".to_string());
    assert!(api_keys::load(Anthropic, &id).is_err());
    let empty_backup = api_keys::replace(Anthropic, &id, &first).unwrap();
    assert_eq!(&*api_keys::load(Anthropic, &id).unwrap(), &*first);
    let manager = agent_files::FileApprovalManager::default();
    let root = agent::data_root().join("credentials");
    for mode in [config::AgentWorkMode::Edit, config::AgentWorkMode::Solo] {
        assert!(manager.list(root.to_str().unwrap(), mode).is_err());
        for entry in fs::read_dir(&root).unwrap() {
            assert!(manager
                .admit_or_request(
                    entry.unwrap().path().to_str().unwrap(),
                    "read",
                    mode,
                    "test-session"
                )
                .is_err());
        }
    }

    let backup = api_keys::replace(Anthropic, &id, &second).unwrap();
    assert_eq!(&*api_keys::load(Anthropic, &id).unwrap(), &*second);
    api_keys::restore(Anthropic, &id, backup).unwrap();
    assert_eq!(&*api_keys::load(Anthropic, &id).unwrap(), &*first);
    let removed = api_keys::take(Anthropic, &id).unwrap();
    assert!(api_keys::load(Anthropic, &id).is_err());
    api_keys::restore(Anthropic, &id, removed).unwrap();
    assert_eq!(&*api_keys::load(Anthropic, &id).unwrap(), &*first);
    api_keys::restore(Anthropic, &id, empty_backup).unwrap();
    assert!(api_keys::load(Anthropic, &id).is_err());
    fs::remove_dir_all(agent::data_root()).unwrap();
}

mod config {
    #[derive(Clone, Copy, PartialEq)]
    pub enum AgentWorkMode {
        Edit,
        Solo,
    }
}
#[path = "../src/PiDesktop.Tauri/src-tauri/src/agent_files.rs"]
mod agent_files;
