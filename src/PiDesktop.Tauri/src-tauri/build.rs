fn main() {
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    for reference in ["HEAD", "packed-refs"] {
        if let Ok(output) = std::process::Command::new("git")
            .args(["rev-parse", "--git-path", reference])
            .output()
        {
            if output.status.success() {
                println!(
                    "cargo:rerun-if-changed={}",
                    String::from_utf8_lossy(&output.stdout).trim()
                );
            }
        }
    }
    if let Ok(reference) = std::process::Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
    {
        if reference.status.success() {
            if let Ok(output) = std::process::Command::new("git")
                .args([
                    "rev-parse",
                    "--git-path",
                    String::from_utf8_lossy(&reference.stdout).trim(),
                ])
                .output()
            {
                if output.status.success() {
                    println!(
                        "cargo:rerun-if-changed={}",
                        String::from_utf8_lossy(&output.stdout).trim()
                    );
                }
            }
        }
    }
    if let Ok(output) = std::process::Command::new("git")
        .args(["log", "-1", "--format=%cI"])
        .output()
    {
        let committed_at = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !committed_at.is_empty() {
            println!("cargo:rustc-env=SYNTHV_TOOLBOX_SOURCE_COMMITTED_AT_UTC={committed_at}");
        }
    }
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
