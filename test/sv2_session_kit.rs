use std::fs;

use super::*;

fn synthetic_plaintext(products: &str) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(format!(
        "eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE4OTM0NTYwMDAsImV4cCI6MTg5MzQ1OTYwMH0.signature\neyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE4OTM0NTYwMDB9.signature\n2030-01-01T01:00:00Z\n2030-01-01T00:00:00Z\ndevice-synthetic\nuser-synthetic\n{products}"
    ).into_bytes())
}

fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("sv2-session-kit-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn parsed_extensions_preserve_unknown_fields() {
    let source =
        synthetic_plaintext("K1=db;K2=product;K3=Name;K4=Vendor;K5=Category;K6=1.0;K7=2;K8=0;K9=0");
    let parsed = SessionText::parse(source).unwrap();
    assert_eq!(parsed.products.len(), 1);
    assert_eq!(
        parsed.products[0].unknown_fields,
        [
            ("K7".to_string(), "2".to_string()),
            ("K8".to_string(), "0".to_string()),
            ("K9".to_string(), "0".to_string())
        ]
    );
    assert!(parsed.plaintext.ends_with("K7=2;K8=0;K9=0"));
}

#[test]
fn default_summary_redacts_credentials() {
    let parsed = SessionText::parse(synthetic_plaintext(
        "K1=db;K2=product;K3=Name;K4=Vendor;K5=Category;K6=1.0;K7=2;K8=0;K9=0",
    ))
    .unwrap();
    let summary = parsed.summary();
    assert!(summary.contains("access_jwt=redacted"));
    assert!(summary.contains("product_id=product"));
    assert!(!summary.contains("eyJhbGci"));
}

#[test]
fn source_hash_guard_refusal_preserves_destination() {
    let root = temp_root();
    let destination = root.join("session");
    fs::write(&destination, vec![1u8; 8]).unwrap();
    let before = fs::read(&destination).unwrap();
    let error = apply_verified(&destination, &destination, "wrong", &hash(&before)).unwrap_err();
    assert!(error.contains("source hash guard"));
    assert_eq!(fs::read(&destination).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn existing_backup_failure_preserves_destination() {
    let root = temp_root();
    let destination = root.join("session");
    let bytes = vec![8u8; 8];
    fs::write(&destination, &bytes).unwrap();
    let backup = backup_name(&destination).unwrap();
    fs::write(backup, b"occupied").unwrap();
    let error = create_verified_backup(&destination, &bytes, &hash(&bytes)).unwrap_err();
    assert!(error.contains("overwrite"));
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    fs::remove_dir_all(root).unwrap();
}
