use std::fs;
use std::path::PathBuf;

use serde_json::json;
use synthv_toolbox_lib::unrestricted_filesystem_request;
use uuid::Uuid;

fn temporary_root() -> PathBuf {
    std::env::temp_dir().join(format!("synthv-plugin-filesystem-test-{}", Uuid::new_v4()))
}

#[test]
fn advanced_filesystem_operations_handle_unrestricted_paths_and_binary_content() {
    let root = temporary_root();
    let nested = root.join("nested");
    let text_file = nested.join("note.txt");
    let binary_file = nested.join("bytes.bin");
    let copied = root.join("copied.txt");
    let moved = root.join("moved.txt");

    unrestricted_filesystem_request(
        "create-directory",
        &json!({ "path": nested, "recursive": true }),
    )
    .unwrap();
    unrestricted_filesystem_request(
        "write",
        &json!({ "path": text_file, "encoding": "text", "content": "outside plugin directory" }),
    )
    .unwrap();
    unrestricted_filesystem_request(
        "write",
        &json!({ "path": binary_file, "encoding": "base64", "content": "AP+A" }),
    )
    .unwrap();

    let text =
        unrestricted_filesystem_request("read", &json!({ "path": text_file, "encoding": "text" }))
            .unwrap();
    assert_eq!(text["content"], "outside plugin directory");
    let binary = unrestricted_filesystem_request(
        "read",
        &json!({ "path": binary_file, "encoding": "base64" }),
    )
    .unwrap();
    assert_eq!(binary["content"], "AP+A");

    let entries = unrestricted_filesystem_request("list", &json!({ "path": nested })).unwrap();
    assert_eq!(entries["entries"].as_array().unwrap().len(), 2);
    assert_eq!(
        unrestricted_filesystem_request("metadata", &json!({ "path": text_file })).unwrap()["kind"],
        "file"
    );
    unrestricted_filesystem_request(
        "copy",
        &json!({ "sourcePath": text_file, "destinationPath": copied }),
    )
    .unwrap();
    unrestricted_filesystem_request(
        "move",
        &json!({ "sourcePath": copied, "destinationPath": moved }),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(&moved).unwrap(),
        "outside plugin directory"
    );

    unrestricted_filesystem_request("remove", &json!({ "path": root, "recursive": true })).unwrap();
    assert!(!root.exists());
}
