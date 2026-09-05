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
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].name, "Fixture Voice");
    assert_eq!(catalog[0].vendor.as_deref(), Some("Fixture Vendor"));
    assert_eq!(
        catalog[0].image_data_url,
        Some(format!("data:image/png;base64,{PNG}"))
    );
    let public = serde_json::to_string(&catalog).unwrap();
    assert!(!public.contains("invalid.example"));
    assert!(!public.contains("authorized"));
    assert_eq!(fs::read(metadata_path).unwrap(), metadata);
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
            .map(|voice| voice.name.as_str())
            .collect::<Vec<_>>(),
        ["Alpha Voice", "Beta Voice"]
    );
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
