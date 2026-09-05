use super::*;

#[test]
#[ignore = "reads the explicitly supplied local product cache directories"]
fn inspect_local_product_catalog() {
    let roots = std::env::var_os("SV2_CATALOG_ROOTS").expect("explicit roots required");
    let roots = std::env::split_paths(&roots).collect::<Vec<_>>();
    assert!(!roots.is_empty() && roots.iter().all(|root| root.is_absolute()));
    let catalog = read_catalog(&roots);
    let images = catalog
        .iter()
        .filter(|voice| voice.image_data_url.is_some())
        .count();
    eprintln!(
        "SV2 local catalog: names={}, images={images}",
        catalog.len()
    );
    assert!(!catalog.is_empty());
    assert!(images > 0);
}
