fn main() {
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
    tauri_build::build()
}
