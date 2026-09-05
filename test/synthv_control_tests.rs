use super::*;

#[test]
fn identifies_only_explicit_sv2_executables() {
    for path in [
        r"C:\Apps\Synthesizer V Studio 2 Pro\synthv-studio.exe",
        "/Applications/Synthesizer V Studio 2 Pro.app/Contents/MacOS/synthv-studio",
    ] {
        assert!(is_sv2_executable_path(path));
    }
    for path in [
        "synthv-studio.exe",
        r"C:\Apps\Synthesizer V Studio Pro\synthv-studio.exe",
        r"C:\Apps\Synthesizer V Studio 2 Pro\updater.exe",
        r"C:\Downloads\svstudio2-pro-setup-2.3.0tp1.exe",
        r"C:\Apps\SVStudio2 Pro\svstudio2-pro-updater.exe",
        r"C:\Apps\Synthesizer V Flat.exe",
    ] {
        assert!(!is_sv2_executable_path(path));
    }
}

#[test]
fn only_a_current_sv2_identity_can_be_controlled() {
    let process = SynthVProcess {
        process_id: 77,
        process_identity: "windows:77:123".to_string(),
        name: "svstudio2-pro.exe".to_string(),
        product_name: "SVStudio2 Pro".to_string(),
        version: "2.3.0".to_string(),
        command: r"C:\Apps\SVStudio2 Pro\svstudio2-pro.exe".to_string(),
        window_title: "Account Projectname".to_string(),
        is_sv2: true,
        sandboxed: Some(false),
    };
    assert!(matches_control_target(&process, "windows:77:123"));
    assert!(!matches_control_target(&process, "windows:77:999"));

    let mut non_sv2 = process;
    non_sv2.is_sv2 = false;
    assert!(!matches_control_target(&non_sv2, "windows:77:123"));
}

#[test]
fn matches_flat_only_by_exact_executable_name() {
    assert!(is_synthv_process(
        "Synthesizer V Flat.exe",
        "C:\\Apps\\Synthesizer V Flat.exe"
    ));
    assert!(is_synthv_process(
        "Synthesizer V Flat",
        "/Applications/Synthesizer V Flat"
    ));
    assert!(!is_synthv_process(
        "flat-helper.exe",
        "C:\\Apps\\flat-helper.exe"
    ));
    assert!(!is_synthv_process(
        "Synthesizer V Flat Helper.exe",
        "C:\\Apps\\Synthesizer V Flat Helper.exe"
    ));
}

#[test]
fn identifies_only_explicit_sv1_executables() {
    assert!(is_synthv_process(
        "synthv-studio.exe",
        r"C:\Apps\Synthesizer V Studio Pro\synthv-studio.exe"
    ));
    assert!(!is_synthv_process(
        "synthv-studio-setup.exe",
        r"C:\Downloads\synthv-studio-setup.exe"
    ));
}

#[test]
fn parses_macos_comm_without_splitting_spaces_or_arguments() {
    let output = "  42 Mon Sep  5 10:20:30 2026 /Applications/SVStudio2 Pro.app/Contents/MacOS/SVStudio2 Pro\n";
    assert_eq!(
        parse_macos_processes(output),
        vec![(
            42,
            "macos:42:Mon Sep 5 10:20:30 2026".to_string(),
            "/Applications/SVStudio2 Pro.app/Contents/MacOS/SVStudio2 Pro".to_string(),
        ),]
    );
}

#[test]
fn product_name_uses_sv2_install_identity_not_parent_path_text() {
    assert_eq!(
        product_name(r"C:\Program Files\SVStudio2\svstudio2.exe", true),
        "SVStudio2"
    );
    assert_eq!(
        product_name(r"C:\Apps\SVStudio2 Pro\svstudio2-pro.exe", true),
        "SVStudio2 Pro"
    );
}

#[test]
fn excludes_setup_and_updater_from_process_enumeration() {
    for path in [
        r"C:\Downloads\svstudio2-pro-setup-2.3.0tp1.exe",
        r"C:\Apps\SVStudio2 Pro\svstudio2-pro-updater.exe",
    ] {
        assert!(!is_synthv_process(path, path));
    }
    assert!(is_synthv_process(
        "svstudio2-pro.exe",
        r"C:\Apps\SVStudio2 Pro\svstudio2-pro.exe"
    ));
}
