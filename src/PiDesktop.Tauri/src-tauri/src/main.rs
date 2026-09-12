#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os()
        .skip(1)
        .any(|argument| argument == "--session-kit-handoff")
    {
        if let Err(error) = synthv_toolbox_lib::sv2_session_kit::run_handoff(std::env::args_os()) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    synthv_toolbox_lib::run();
}
