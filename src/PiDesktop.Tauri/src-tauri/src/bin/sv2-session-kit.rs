fn main() {
    if let Err(error) = synthv_toolbox_lib::sv2_session_kit::run(std::env::args_os()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
