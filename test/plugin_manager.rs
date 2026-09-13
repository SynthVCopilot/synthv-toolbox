use std::fs;
use std::io::Write;
use std::path::PathBuf;

use synthv_toolbox_lib::plugin_manager;
use uuid::Uuid;

fn temporary_root() -> PathBuf {
    std::env::temp_dir().join(format!("synthv-plugin-test-{}", Uuid::new_v4()))
}

fn write_plugin(root: &std::path::Path, id: &str, permissions: &str) {
    fs::create_dir_all(root.join("ui")).unwrap();
    fs::write(root.join("ui/index.html"), "<main>plugin</main>").unwrap();
    fs::write(root.join("backend.js"), "export default {};\n").unwrap();
    fs::write(root.join("manifest.json"), format!(r#"{{"schemaVersion":1,"id":"{id}","name":"Example","version":"1.0.0","hostApi":{{"min":"1.0","max":"1.0"}},"backend":{{"entry":"backend.js"}},"pages":[{{"id":"workbench","title":"Workbench","entry":"ui/index.html"}}],"actions":[{{"id":"run","location":"project.toolbar","title":"Run"}}],"permissions":{permissions}}}"#)).unwrap();
}

#[test]
fn installs_lists_and_disables_a_directory_plugin() {
    let temporary = temporary_root();
    let source = temporary.join("source");
    let installed = temporary.join("plugins");
    write_plugin(&source, "com.example.plugin", r#"{"host.read":"required"}"#);

    let plugin = plugin_manager::install(&source, &installed).unwrap();
    assert!(plugin.enabled);
    assert!(!plugin.internal_functions_enabled);
    assert!(!plugin.advanced_functions_enabled);
    assert_eq!(plugin.manifest.id, "com.example.plugin");
    assert_eq!(plugin_manager::list(&installed).unwrap().len(), 1);
    assert!(
        !plugin_manager::set_enabled(&installed, "com.example.plugin", false, false, false)
            .unwrap()
            .enabled
    );
    assert!(!plugin_manager::list(&installed).unwrap()[0].enabled);
    assert!(
        plugin_manager::set_internal_functions_enabled(&installed, "com.example.plugin", true)
            .is_err()
    );
    assert!(
        plugin_manager::set_advanced_functions_enabled(&installed, "com.example.plugin", true)
            .is_err()
    );
    let listed = plugin_manager::list(&installed).unwrap();
    assert!(!listed[0].internal_functions_enabled);
    assert!(!listed[0].advanced_functions_enabled);
    plugin_manager::uninstall(&installed, "com.example.plugin").unwrap();
    assert!(plugin_manager::list(&installed).unwrap().is_empty());
    let _ = fs::remove_dir_all(temporary);
}

#[test]
fn requires_global_and_plugin_specific_consent_for_privileged_permissions() {
    let temporary = temporary_root();
    let source = temporary.join("source");
    let installed = temporary.join("plugins");
    write_plugin(
        &source,
        "com.example.plugin",
        r#"{"host.internal":"optional","host.advanced":"optional"}"#,
    );
    plugin_manager::install(&source, &installed).unwrap();

    assert!(plugin_manager::authorize_capability(
        &installed,
        "com.example.plugin",
        "host.internal",
        false,
        false,
    )
    .is_err());
    plugin_manager::set_internal_functions_enabled(&installed, "com.example.plugin", true).unwrap();
    assert!(plugin_manager::authorize_capability(
        &installed,
        "com.example.plugin",
        "host.internal",
        true,
        false,
    )
    .is_ok());

    assert!(plugin_manager::authorize_capability(
        &installed,
        "com.example.plugin",
        "host.advanced",
        true,
        false,
    )
    .is_err());
    plugin_manager::set_advanced_functions_enabled(&installed, "com.example.plugin", true).unwrap();
    assert!(plugin_manager::authorize_capability(
        &installed,
        "com.example.plugin",
        "host.advanced",
        true,
        true,
    )
    .is_ok());
    plugin_manager::set_enabled(&installed, "com.example.plugin", false, true, true).unwrap();
    assert!(plugin_manager::authorize_capability(
        &installed,
        "com.example.plugin",
        "host.advanced",
        true,
        true,
    )
    .is_err());
    let _ = fs::remove_dir_all(temporary);
}

#[test]
fn required_privileged_permissions_keep_a_plugin_disabled_until_every_grant_exists() {
    let temporary = temporary_root();
    let source = temporary.join("source");
    let installed = temporary.join("plugins");
    write_plugin(
        &source,
        "com.example.required",
        r#"{"host.internal":"required","host.advanced":"required"}"#,
    );

    let plugin = plugin_manager::install(&source, &installed).unwrap();
    assert!(!plugin.enabled);
    assert!(plugin_manager::runnable_plugin_ids(&installed, true, true)
        .unwrap()
        .is_empty());
    assert!(
        plugin_manager::set_enabled(&installed, "com.example.required", true, true, true).is_err()
    );

    plugin_manager::set_internal_functions_enabled(&installed, "com.example.required", true)
        .unwrap();
    assert!(
        plugin_manager::set_enabled(&installed, "com.example.required", true, true, true).is_err()
    );
    plugin_manager::set_advanced_functions_enabled(&installed, "com.example.required", true)
        .unwrap();
    assert!(
        plugin_manager::set_enabled(&installed, "com.example.required", true, false, true).is_err()
    );
    assert!(
        plugin_manager::set_enabled(&installed, "com.example.required", true, true, true)
            .unwrap()
            .enabled
    );
    assert_eq!(
        plugin_manager::runnable_plugin_ids(&installed, true, true).unwrap(),
        ["com.example.required"]
    );

    let revoked =
        plugin_manager::set_internal_functions_enabled(&installed, "com.example.required", false)
            .unwrap();
    assert!(!revoked.enabled);
    plugin_manager::set_internal_functions_enabled(&installed, "com.example.required", true)
        .unwrap();
    assert!(!plugin_manager::list(&installed).unwrap()[0].enabled);
    plugin_manager::set_enabled(&installed, "com.example.required", true, true, true).unwrap();

    plugin_manager::disable_plugins_requiring_permission(&installed, "host.internal").unwrap();
    assert!(!plugin_manager::list(&installed).unwrap()[0].enabled);
    assert!(plugin_manager::runnable_plugin_ids(&installed, true, true)
        .unwrap()
        .is_empty());
    let _ = fs::remove_dir_all(temporary);
}

#[test]
fn rejects_legacy_permission_arrays_and_none_grants() {
    let temporary = temporary_root();
    let source = temporary.join("source");
    let installed = temporary.join("plugins");
    write_plugin(&source, "com.example.none", r#"{"host.internal":"none"}"#);
    plugin_manager::install(&source, &installed).unwrap();
    assert!(
        plugin_manager::set_internal_functions_enabled(&installed, "com.example.none", true)
            .is_err()
    );

    let legacy = temporary.join("legacy");
    write_plugin(&legacy, "com.example.legacy", r#"["host.read"]"#);
    assert!(plugin_manager::install(&legacy, &installed).is_err());
    let _ = fs::remove_dir_all(temporary);
}

#[test]
fn rejects_entry_traversal_before_installing() {
    let temporary = temporary_root();
    let source = temporary.join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("manifest.json"), r#"{"schemaVersion":1,"id":"com.example.bad","name":"Bad","version":"1.0.0","hostApi":{"min":"1.0","max":"1.0"},"pages":[{"id":"page","title":"Bad","entry":"../outside.html"}],"permissions":{}}"#).unwrap();
    assert!(plugin_manager::install(&source, &temporary.join("plugins")).is_err());
    let _ = fs::remove_dir_all(temporary);
}

#[test]
fn rejects_unknown_permissions() {
    let temporary = temporary_root();
    let source = temporary.join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("manifest.json"), r#"{"schemaVersion":1,"id":"com.example.bad","name":"Bad","version":"1.0.0","hostApi":{"min":"1.0","max":"1.0"},"permissions":{"host.everything":"optional"}}"#).unwrap();
    assert!(plugin_manager::install(&source, &temporary.join("plugins")).is_err());
    let _ = fs::remove_dir_all(temporary);
}

#[test]
fn rejects_zip_path_traversal() {
    let temporary = temporary_root();
    fs::create_dir_all(&temporary).unwrap();
    let archive_path = temporary.join("unsafe.zip");
    let file = fs::File::create(&archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file("../outside.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"outside").unwrap();
    archive.finish().unwrap();
    assert!(plugin_manager::install(&archive_path, &temporary.join("plugins")).is_err());
    assert!(!temporary.join("outside.txt").exists());
    let _ = fs::remove_dir_all(temporary);
}
