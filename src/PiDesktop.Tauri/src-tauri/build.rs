fn main() {
    let attributes = tauri_build::Attributes::new();
    #[cfg(windows)]
    {
        cc::Build::new()
            .cpp(true)
            .file("native/windows_process_loopback.cpp")
            .flag_if_supported("/std:c++17")
            .warnings(true)
            .compile("synthv_process_loopback");
        println!("cargo:rustc-link-lib=mmdevapi");
        println!("cargo:rustc-link-lib=runtimeobject");
        println!("cargo:rustc-link-lib=ole32");
        println!("cargo:rerun-if-changed=native/windows_process_loopback.cpp");
    }
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .cpp(true)
            .file("native/macos_process_tap.mm")
            .flag_if_supported("-std=c++17")
            .flag_if_supported("-fobjc-arc")
            .warnings(true)
            .compile("synthv_macos_process_tap");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rerun-if-changed=native/macos_process_tap.mm");
    }
    #[cfg(windows)]
    let attributes = {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    };
    tauri_build::try_build(attributes).expect("failed to build desktop resources");
}
