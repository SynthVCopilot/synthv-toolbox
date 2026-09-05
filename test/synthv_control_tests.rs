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
        r"C:\Apps\Synthesizer V Flat.exe",
    ] {
        assert!(!is_sv2_executable_path(path));
    }
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
