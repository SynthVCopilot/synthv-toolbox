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
fn encryption_round_trip_preserves_extensions() {
    let source =
        synthetic_plaintext("K1=db;K2=product;K3=Name;K4=Vendor;K5=Category;K6=1.0;K7=2;K8=0;K9=0");
    let encrypted = encrypt_session(&source, b"test-key").unwrap();
    let decrypted = decrypt_session(encrypted, b"test-key").unwrap();
    let parsed = SessionText::parse(decrypted).unwrap();
    assert!(parsed.plaintext.ends_with("K7=2;K8=0;K9=0"));
}

#[test]
fn empty_credential_placeholder_is_preserved() {
    let parsed = SessionText::parse(Zeroizing::new(
        b"\n\n2030-01-01T01:00:00Z\n2030-01-01T00:00:00Z\ndevice".to_vec(),
    ))
    .unwrap();
    assert!(parsed.header(0).is_empty());
    assert!(parsed.header(1).is_empty());
}

#[test]
fn source_and_destination_hash_guards_are_independent() {
    assert!(verify_hash(b"candidate", "wrong", "source")
        .unwrap_err()
        .contains("source"));
    assert!(verify_hash(b"destination", "wrong", "destination")
        .unwrap_err()
        .contains("destination"));
}

#[test]
fn verified_backup_matches_original_content() {
    let root = temp_root();
    let destination = root.join("session");
    let bytes = b"synthetic encrypted bytes";
    fs::write(&destination, bytes).unwrap();
    let backup = create_verified_backup(&destination, bytes, &hash(bytes)).unwrap();
    assert_eq!(hash(&fs::read(backup).unwrap()), hash(bytes));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacement_helper_writes_synthetic_candidate() {
    let root = temp_root();
    let destination = root.join("session");
    let backup = root.join("backup");
    let original = vec![1u8; 8];
    let candidate = vec![2u8; 8];
    fs::write(&destination, &original).unwrap();
    fs::write(&backup, &original).unwrap();
    replace_with_recovery(
        &destination,
        &candidate,
        &original,
        &hash(&candidate),
        &hash(&original),
    )
    .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), candidate);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_preserves_original_even_if_backup_file_changed() {
    let root = temp_root();
    let destination = root.join("session");
    let backup = root.join("backup");
    let original = vec![1u8; 8];
    let candidate = vec![2u8; 8];
    fs::write(&destination, &original).unwrap();
    fs::write(&backup, vec![3u8; 8]).unwrap();
    let error = replace_with_recovery(
        &destination,
        &candidate,
        &original,
        "wrong",
        &hash(&original),
    )
    .unwrap_err();
    assert!(error.contains("restored"));
    assert_eq!(fs::read(&destination).unwrap(), original);
    assert_eq!(fs::read(&backup).unwrap(), vec![3u8; 8]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_replacement_verification_restores_exact_original() {
    let root = temp_root();
    let destination = root.join("session");
    let backup = root.join("backup");
    let key = [7u8; 8];
    let original = encrypt_session(
        &synthetic_plaintext("K1=db;K2=product;K3=Old;K4=Vendor;K5=Category;K6=1;K7=2;K8=0;K9=0"),
        &key,
    )
    .unwrap();
    let candidate = encrypt_session(
        &synthetic_plaintext("K1=db;K2=product;K3=New;K4=Vendor;K5=Category;K6=1;K7=2;K8=0;K9=0"),
        &key,
    )
    .unwrap();
    fs::write(&destination, &original).unwrap();
    fs::write(&backup, &original).unwrap();
    let error = replace_with_recovery(
        &destination,
        &candidate,
        &original,
        "force-verification-failure",
        &hash(&original),
    )
    .unwrap_err();
    assert!(error.contains("verified backup was restored"));
    assert_eq!(&*original, &fs::read(&destination).unwrap());
    assert_eq!(&*original, &fs::read(&backup).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn writing_existing_output_does_not_remove_it() {
    let root = temp_root();
    let output = root.join("existing");
    fs::write(&output, b"preserve").unwrap();
    assert!(write_new_restricted(&output, b"replacement").is_err());
    assert_eq!(fs::read(&output).unwrap(), b"preserve");
    fs::remove_dir_all(root).unwrap();
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
fn inspection_metadata_keeps_product_fields_and_redacts_credentials() {
    let parsed = SessionText::parse(synthetic_plaintext(
        "K1=db;K2=product;K3=Name;K4=Vendor;K5=Category;K6=1.0;K7=2;K8=0;K9=0",
    ))
    .unwrap();
    let metadata = parsed.redacted_credential_metadata();
    assert_eq!(metadata.access_token_length, parsed.header(0).len());
    assert_eq!(metadata.refresh_token_length, parsed.header(1).len());
    assert_ne!(metadata.access_expiry, parsed.header(0));
    assert_eq!(
        metadata.user_identifier_length,
        Some("user-synthetic".len())
    );
    let fields = &parsed.cached_products()[0].fields;
    assert_eq!(fields.len(), 9);
    assert_eq!(fields[0].key, "K1");
    assert_eq!(
        fields[8],
        Sv2SessionCachedField {
            key: "K9".to_string(),
            value: "0".to_string()
        }
    );
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
