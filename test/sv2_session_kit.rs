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
fn clearing_offline_cache_preserves_session_headers() {
    let parsed = SessionText::parse(synthetic_plaintext(
        "K1=db;K2=product;K3=Name;K4=Vendor;K5=Category;K6=1.0;K7=2",
    ))
    .unwrap();
    let (cleared, removed) = parsed.without_offline_cached_products().unwrap();
    assert_eq!(removed, 1);
    assert!(cleared.ends_with("user-synthetic"));
    assert!(!cleared.contains("K1=db"));
    assert_eq!(cleared.lines().next(), Some(parsed.header(0)));
    assert_eq!(cleared.lines().nth(1), Some(parsed.header(1)));
}

#[test]
fn clearing_offline_cache_rewrites_encrypted_session_with_verified_backup() {
    let root = temp_root();
    let destination = root.join("session");
    let key = b"test-key";
    let original = encrypt_session(
        &synthetic_plaintext("K1=db;K2=product;K3=Name;K4=Vendor;K5=Category;K6=1.0;K7=2"),
        key,
    )
    .unwrap();
    fs::write(&destination, &original).unwrap();

    let result = clear_offline_cached_products_with_key(&destination, key).unwrap();
    let rewritten = decode_bytes_with_key(read_ciphertext(&destination).unwrap(), key).unwrap();

    assert_eq!(result.removed_products, 1);
    assert_eq!(rewritten.products.len(), 0);
    assert_eq!(
        rewritten.header(0),
        "eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE4OTM0NTYwMDAsImV4cCI6MTg5MzQ1OTYwMH0.signature"
    );
    assert_eq!(
        hash(&fs::read(&result.backup_path).unwrap()),
        hash(&original)
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn clearing_offline_cache_rejects_unknown_rows() {
    let parsed = SessionText::parse(synthetic_plaintext("unsupported-cache-row")).unwrap();
    assert!(parsed.without_offline_cached_products().is_err());
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
fn session_backup_is_written_as_one_external_file() {
    let root = temp_root();
    let session_dir = root.join("data/license");
    let backup_dir = root.join("backups");
    fs::create_dir_all(&session_dir).unwrap();
    fs::create_dir_all(&backup_dir).unwrap();
    let session = session_dir.join("session");
    let bytes = vec![7u8; 16];
    fs::write(&session, &bytes).unwrap();

    let backup = create_verified_session_backup(&session, &backup_dir, &hash(&bytes)).unwrap();

    assert_eq!(fs::read(&backup).unwrap(), bytes);
    assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), 1);
    assert!(create_verified_session_backup(&session, &session_dir, &hash(&bytes)).is_err());
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
fn full_read_returns_exact_session_plaintext() {
    let root = temp_root();
    let destination = root.join("session");
    let key = [11u8; 8];
    let plaintext = synthetic_plaintext(
        "K1=db;K2=product;K3=Name;K4=Vendor;K5=Category;K6=1.0;K7=2;K8=0;K9=custom",
    );
    let encrypted = encrypt_session(&plaintext, &key).unwrap();
    fs::write(&destination, &encrypted).unwrap();

    let document = read_full_session_with_key(&destination, &key).unwrap();

    assert_eq!(document.plaintext.as_bytes(), plaintext.as_slice());
    assert_eq!(document.encrypted_sha256, hash(&encrypted));
    assert_eq!(document.encrypted_bytes, encrypted.len());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn full_write_backs_up_and_replaces_complete_session() {
    let root = temp_root();
    let destination = root.join("session");
    let key = [13u8; 8];
    let original_plaintext = synthetic_plaintext(
        "K1=db;K2=product;K3=Old;K4=Vendor;K5=Category;K6=1.0;K7=2;K8=0;K9=old",
    );
    let replacement_plaintext = synthetic_plaintext(
        "K1=db;K2=product;K3=New;K4=Vendor;K5=Category;K6=2.0;K7=3;K8=1;K9=new",
    );
    let original = encrypt_session(&original_plaintext, &key).unwrap();
    let original_hash = hash(&original);
    fs::write(&destination, &original).unwrap();

    let result = write_full_session_with_key(
        &destination,
        &original_hash,
        replacement_plaintext.clone(),
        &key,
        || Ok(false),
    )
    .unwrap();
    let written = read_full_session_with_key(&destination, &key).unwrap();

    assert_eq!(
        written.plaintext.as_bytes(),
        replacement_plaintext.as_slice()
    );
    assert_eq!(result.encrypted_sha256, written.encrypted_sha256);
    assert_eq!(
        result.encrypted_bytes,
        fs::read(&destination).unwrap().len()
    );
    assert_eq!(fs::read(&result.backup_path).unwrap(), original.as_slice());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn full_write_rejects_stale_hash_without_backup_or_change() {
    let root = temp_root();
    let destination = root.join("session");
    let key = [17u8; 8];
    let original = encrypt_session(
        &synthetic_plaintext("K1=db;K2=product;K3=Old;K4=Vendor;K5=Category;K6=1.0;K7=2"),
        &key,
    )
    .unwrap();
    fs::write(&destination, &original).unwrap();

    let error = match write_full_session_with_key(
        &destination,
        "stale",
        synthetic_plaintext("K1=db;K2=product;K3=New;K4=Vendor;K5=Category;K6=2.0;K7=3"),
        &key,
        || Ok(false),
    ) {
        Ok(_) => panic!("stale hash should be rejected"),
        Err(error) => error,
    };

    assert!(error.contains("destination hash guard"));
    assert_eq!(fs::read(&destination).unwrap(), original.as_slice());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
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
