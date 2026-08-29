mod commands;
mod components;
mod config;
mod downloads;
mod mcp;
mod state;
mod sv2_concurrent;
mod sv2_profiles;
mod synthv;
mod workflows;

use std::path::PathBuf;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
            let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let bundled_bridge = resource_dir.join("synthv-agent-bridge");
            let development_bridge = repository.join("external/synthv-agent-bridge");
            let bridge_dir = if bundled_bridge.join("dist/src/cli.js").is_file() {
                bundled_bridge
            } else {
                development_bridge
            };
            let bundled_components = resource_dir.join("components");
            let development_components = repository.join("external/pi-agent/components");
            let components_dir = if bundled_components.is_dir() {
                bundled_components
            } else {
                development_components
            };
            app.manage(AppState::new(resource_dir, bridge_dir, components_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::complete_onboarding,
            commands::set_mode,
            commands::save_model_settings,
            commands::scan_synthv,
            commands::sv2_profile_state,
            commands::import_current_sv2_profile,
            commands::create_sv2_profile,
            commands::rename_sv2_profile,
            commands::update_sv2_profile_identity,
            commands::activate_sv2_profile,
            commands::launch_sv2_profile,
            commands::force_launch_sv2_profile,
            commands::open_sv2_profile_folder,
            commands::prepare_sv2_concurrent_profile,
            commands::launch_sv2_concurrent_profile,
            commands::accept_sv2_concurrent_disclaimer,
            commands::open_sv2_concurrent_folder,
            commands::save_scripts_path,
            commands::install_bridge,
            commands::diagnose_bridge,
            commands::connect_bridge,
            commands::component_downloads,
            commands::queue_component_install,
            commands::run_audio_probe,
            commands::run_game_to_midi,
            commands::run_project_probe,
            commands::add_project_reference,
            commands::review_workflow,
            commands::save_mcp_server,
            commands::delete_mcp_server,
            commands::test_mcp_server,
            commands::list_conversations,
            commands::new_conversation,
            commands::open_conversation,
            commands::send_message,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SynthV Toolbox");
}
