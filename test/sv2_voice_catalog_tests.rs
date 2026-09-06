use super::*;

const FIRST_ID: &str = "00000000-0000-4000-8000-000000000001";
const SECOND_ID: &str = "00000000-0000-4000-8000-000000000002";
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("sv2-voice-catalog-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn root(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(path.join("databases/meta")).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        assert!(self.0.starts_with(std::env::temp_dir()));
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("sv2-voice-catalog-"));
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn catalog_joins_local_product_metadata_and_images_without_using_remote_urls() {
    let fixture = Fixture::new();
    let first = fixture.root("first");
    let second = fixture.root("second");
    let metadata = br#"{"name":"  Fixture   Voice ","vendor":"Fixture Vendor","profileImageUrl":"https://invalid.example/image.png"}"#;
    let metadata_path = first.join(format!("databases/meta/{FIRST_ID}.json"));
    fs::write(&metadata_path, metadata).unwrap();
    fs::write(
        second.join(format!("databases/meta/{FIRST_ID}.png")),
        STANDARD.decode(PNG).unwrap(),
    )
    .unwrap();
    fs::write(
        second.join(format!("databases/meta/{SECOND_ID}.png")),
        STANDARD.decode(PNG).unwrap(),
    )
    .unwrap();

    let catalog = read_catalog(&[first, second]);
    assert_eq!(catalog.len(), 2);
    assert_eq!(catalog[0].name.as_deref(), Some("Fixture Voice"));
    assert_eq!(catalog[0].vendor.as_deref(), Some("Fixture Vendor"));
    assert_eq!(
        catalog[0].image_data_url,
        Some(format!("data:image/png;base64,{PNG}"))
    );
    let public = serde_json::to_string(&catalog).unwrap();
    assert!(!public.contains("invalid.example"));
    assert!(!public.contains("authorized"));
    assert_eq!(fs::read(metadata_path).unwrap(), metadata);
    let image_only = catalog.iter().find(|voice| voice.id == SECOND_ID).unwrap();
    assert!(image_only.name.is_none());
    assert!(image_only.image_data_url.is_some());
}

#[test]
fn catalog_rejects_unbounded_or_unsafe_metadata_and_keeps_missing_images_optional() {
    let fixture = Fixture::new();
    let root = fixture.root("slot");
    let metadata_path = root.join(format!("databases/meta/{FIRST_ID}.json"));
    for bytes in [
        br#"{"name":""}"#.to_vec(),
        br#"{"name":"Voice\u0000"}"#.to_vec(),
        vec![b' '; MAX_METADATA_BYTES + 1],
    ] {
        fs::write(&metadata_path, bytes).unwrap();
        assert!(read_catalog(std::slice::from_ref(&root)).is_empty());
    }
    fs::write(&metadata_path, br#"{"name":"Fixture Voice"}"#).unwrap();
    fs::write(
        root.join("databases/meta/not-a-product-id.json"),
        br#"{"name":"Unexpected"}"#,
    )
    .unwrap();
    let png_path = root.join(format!("databases/meta/{FIRST_ID}.png"));
    let mut oversized_dimensions = STANDARD.decode(PNG).unwrap();
    oversized_dimensions[16..20].copy_from_slice(&4096_u32.to_be_bytes());
    for bytes in [
        b"<svg/>".to_vec(),
        oversized_dimensions,
        vec![0; MAX_IMAGE_BYTES + 1],
    ] {
        fs::write(&png_path, bytes).unwrap();
        let catalog = read_catalog(std::slice::from_ref(&root));
        assert_eq!(catalog.len(), 1);
        assert!(catalog[0].image_data_url.is_none());
    }
}

#[test]
fn catalog_deduplicates_product_ids_and_sorts_names() {
    let fixture = Fixture::new();
    let first = fixture.root("first");
    let second = fixture.root("second");
    for root in [&first, &second] {
        fs::write(
            root.join(format!("databases/meta/{FIRST_ID}.json")),
            br#"{"name":"Beta Voice"}"#,
        )
        .unwrap();
        fs::write(
            root.join(format!("databases/meta/{SECOND_ID}.json")),
            br#"{"name":"Alpha Voice"}"#,
        )
        .unwrap();
    }
    let catalog = read_catalog(&[first, second]);
    assert_eq!(
        catalog
            .iter()
            .map(|voice| voice.name.as_deref())
            .collect::<Vec<_>>(),
        [Some("Alpha Voice"), Some("Beta Voice")]
    );
}

#[test]
fn installed_voice_ids_require_local_manifest_and_model_files() {
    let fixture = Fixture::new();
    let root = fixture.root("slot");
    let installed = "00000000-0000-4000-8000-000000000003";
    let incomplete = "00000000-0000-4000-8000-000000000004";
    let cache_only = "00000000-0000-4000-8000-000000000005";
    let missing_manifest = "00000000-0000-4000-8000-000000000006";
    let empty_files = "00000000-0000-4000-8000-000000000007";

    let installed_version = root.join(format!("databases/{installed}/204b1"));
    fs::create_dir_all(&installed_version).unwrap();
    fs::write(installed_version.join("m"), b"manifest").unwrap();
    fs::write(installed_version.join("model.dnni"), b"model").unwrap();

    let incomplete_version = root.join(format!("databases/{incomplete}/204b1"));
    fs::create_dir_all(&incomplete_version).unwrap();
    fs::write(incomplete_version.join("m"), b"manifest").unwrap();
    fs::write(incomplete_version.join("model.dnni.part"), b"partial").unwrap();

    let missing_manifest_version = root.join(format!("databases/{missing_manifest}/204b1"));
    fs::create_dir_all(&missing_manifest_version).unwrap();
    fs::write(missing_manifest_version.join("model.dnni"), b"model").unwrap();

    let empty_files_version = root.join(format!("databases/{empty_files}/204b1"));
    fs::create_dir_all(&empty_files_version).unwrap();
    fs::write(empty_files_version.join("m"), []).unwrap();
    fs::write(empty_files_version.join("model.dnni"), []).unwrap();

    fs::write(
        root.join(format!("databases/meta/{cache_only}.json")),
        br#"{"name":"Cached only"}"#,
    )
    .unwrap();

    assert_eq!(read_installed_voice_ids(&root), vec![installed.to_string()]);
}

#[cfg(windows)]
#[test]
fn catalog_does_not_follow_a_redirected_metadata_directory() {
    let fixture = Fixture::new();
    let root = fixture.root("slot");
    let outside = fixture.root("outside");
    fs::write(
        outside.join(format!("databases/meta/{FIRST_ID}.json")),
        br#"{"name":"Outside Voice"}"#,
    )
    .unwrap();
    fs::remove_dir(root.join("databases/meta")).unwrap();
    junction::create(outside.join("databases/meta"), root.join("databases/meta")).unwrap();
    assert!(read_catalog(&[root]).is_empty());
}

#[cfg(windows)]
#[test]
fn installed_voice_ids_do_not_follow_redirected_product_directories() {
    let fixture = Fixture::new();
    let root = fixture.root("slot");
    let outside = fixture.root("outside");
    let product = "00000000-0000-4000-8000-000000000006";
    let version = outside.join(format!("databases/{product}/204b1"));
    fs::create_dir_all(&version).unwrap();
    fs::write(version.join("m"), b"manifest").unwrap();
    fs::write(version.join("model.dnni"), b"model").unwrap();
    junction::create(
        outside.join(format!("databases/{product}")),
        root.join(format!("databases/{product}")),
    )
    .unwrap();

    assert!(read_installed_voice_ids(&root).is_empty());
}
