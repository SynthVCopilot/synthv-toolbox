use synthv_toolbox_lib::plugin_assets;
use tauri::http::{Method, Request, StatusCode};

fn request(method: Method, uri: &str) -> Request<Vec<u8>> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Vec::new())
        .unwrap()
}

#[test]
fn rejects_unsafe_plugin_asset_requests() {
    let traversal = plugin_assets::serve(&request(
        Method::GET,
        "toolbox-plugin://localhost/com.example.plugin/../manifest.json",
    ));
    assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);

    let encoded_path = plugin_assets::serve(&request(
        Method::GET,
        "toolbox-plugin://localhost/com.example.plugin/ui%2Findex.html",
    ));
    assert_eq!(encoded_path.status(), StatusCode::BAD_REQUEST);

    let mutation = plugin_assets::serve(&request(
        Method::POST,
        "toolbox-plugin://localhost/com.example.plugin/ui/index.html",
    ));
    assert_eq!(mutation.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[test]
fn missing_normal_plugin_asset_is_not_found() {
    let response = plugin_assets::serve(&request(
        Method::GET,
        "toolbox-plugin://localhost/com.example.plugin/ui/index.html",
    ));
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
}
