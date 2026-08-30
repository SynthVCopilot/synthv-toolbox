pub mod agent;
mod bridge_workflows;
mod commands;
mod components;
mod config;
mod creative_history;
mod creative_tools;
mod downloads;
mod lyric_tools;
mod mcp;
mod state;
mod sv2_concurrent;
mod sv2_profiles;
mod sv2_session_guard;
mod sv2_sync;
mod svp_launch_router;
mod synthv;
mod workflows;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use state::AppState;
use svp_launch_router::{
    parse_svp_activation, passthrough_svp_project, SvpActivation, SvpLaunchMode, SvpRoutePlan,
};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_args = std::env::args().collect::<Vec<_>>();
    let initial_cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    let initial_activation = parse_svp_activation(&initial_args, initial_cwd.as_deref())
        .ok()
        .flatten();
    let passthrough_only = initial_activation.is_some();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            handle_svp_activation(app.clone(), args, Some(cwd));
        }))
        .setup(move |app| {
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
            let development_components =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("components");
            let components_dir = if bundled_components.is_dir() {
                bundled_components
            } else {
                development_components
            };
            app.manage(AppState::new(
                resource_dir,
                bridge_dir,
                components_dir,
                passthrough_only,
            ));
            if let Some(activation) = initial_activation.clone() {
                let settings = crate::config::load_settings();
                match open_original_svp_project(
                    &activation.project_path,
                    settings.original_svp_prog_id.as_deref(),
                ) {
                    Ok(()) => {
                        let handle = app.handle().clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(750));
                            handle.exit(0);
                        });
                    }
                    Err(error) => {
                        app.state::<AppState>()
                            .svp_passthrough_only
                            .store(false, Ordering::Release);
                        show_main_window(app.handle());
                        let _ = app.emit("svp-route-error", error);
                    }
                }
            } else {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::complete_onboarding,
            commands::set_mode,
            commands::save_model_settings,
            commands::scan_synthv,
            commands::sv2_profile_state,
            commands::sv2_account_precheck,
            commands::sv2_account_usage_snapshot,
            commands::sv2_sync_categories,
            commands::preview_sv2_selective_sync,
            commands::execute_sv2_selective_sync,
            commands::import_current_sv2_profile,
            commands::create_sv2_profile,
            commands::rename_sv2_profile,
            commands::update_sv2_profile_identity,
            commands::update_sv2_profile_voice_licenses,
            commands::preview_svp_route,
            commands::launch_svp_route,
            commands::set_svp_launch_routing,
            commands::open_svp_default_apps_settings,
            commands::update_sv2_concurrent_defaults,
            commands::update_sv2_concurrent_content,
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
            commands::open_downloaded_component,
            commands::list_workflow_recipes,
            commands::list_creative_history,
            commands::create_project_checkpoint,
            commands::list_project_checkpoints,
            commands::restore_project_checkpoint,
            commands::export_workflow_report,
            commands::lookup_chinese_rhyme,
            commands::build_lyric_template,
            commands::generate_lyric_candidates,
            commands::run_project_doctor,
            commands::run_pronunciation_diagnostics,
            commands::run_render_review,
            commands::run_audio_to_project,
            commands::run_retake_workbench,
            commands::run_batch_workflow,
            commands::run_audio_probe,
            commands::run_game_to_midi,
            commands::run_project_probe,
            commands::add_project_reference,
            commands::export_project_without_parameters,
            commands::export_project_lyrics,
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

fn handle_svp_activation(app: tauri::AppHandle, args: Vec<String>, cwd: Option<String>) {
    let activation = match parse_svp_activation(&args, cwd.as_deref()) {
        Ok(Some(activation)) => activation,
        Ok(None) => {
            show_main_window(&app);
            return;
        }
        Err(error) => {
            show_main_window(&app);
            let _ = app.emit("svp-route-error", error);
            return;
        }
    };
    tauri::async_runtime::spawn(route_hot_activation(app, activation));
}

async fn route_hot_activation(app: tauri::AppHandle, activation: SvpActivation) {
    let state = app.state::<AppState>();
    let passthrough_only = state.svp_passthrough_only.load(Ordering::Acquire);
    let (enabled, original_prog_id, concurrent_disclaimer_accepted) = {
        let settings = state.settings.read().await;
        (
            settings.smart_svp_launch_enabled,
            settings.original_svp_prog_id.clone(),
            settings.concurrent_disclaimer_accepted,
        )
    };
    if passthrough_only || !enabled {
        if let Err(error) =
            open_original_svp_project(&activation.project_path, original_prog_id.as_deref())
        {
            show_main_window(&app);
            let _ = app.emit("svp-route-error", error);
        }
        return;
    }

    let profiles = state.sv2_profiles.clone();
    let project_path = activation.project_path.clone();
    let plan_result =
        tauri::async_runtime::spawn_blocking(move || profiles.preview_svp_route(project_path))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
    let plan = match plan_result {
        Ok(plan) => plan,
        Err(error) => {
            if let Err(passthrough_error) =
                open_original_svp_project(&activation.project_path, original_prog_id.as_deref())
            {
                show_main_window(&app);
                let _ = app.emit(
                    "svp-route-error",
                    format!("智能路由失败：{error}\n透明转交也失败：{passthrough_error}"),
                );
            }
            return;
        }
    };

    let can_auto_launch = !plan.requires_confirmation
        && plan.selected_slot_id.is_some()
        && plan.selected_launch_mode.is_some()
        && (plan.selected_launch_mode != Some(SvpLaunchMode::Concurrent)
            || concurrent_disclaimer_accepted);
    if can_auto_launch {
        let slot_id = plan.selected_slot_id.clone().unwrap_or_default();
        let mode = plan.selected_launch_mode.unwrap_or(SvpLaunchMode::Normal);
        let project_path = plan.project_path.clone();
        let profiles = state.sv2_profiles.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            profiles.launch_svp_route(slot_id, project_path, mode)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        if let Err(error) = result {
            show_main_window(&app);
            let _ = app.emit("svp-route-error", error);
        }
        return;
    }

    show_main_window(&app);
    emit_svp_route_request(&app, plan);
}

fn emit_svp_route_request(app: &tauri::AppHandle, plan: SvpRoutePlan) {
    let _ = app.emit("svp-route-request", plan);
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_original_svp_project(
    project_path: &str,
    original_prog_id: Option<&str>,
) -> Result<(), String> {
    match passthrough_svp_project(project_path, original_prog_id) {
        Ok(()) => Ok(()),
        Err(association_error) => {
            let executable = crate::synthv::find_sv2_executable().ok_or_else(|| {
                format!(
                    "{association_error}\n同时没有发现可直接启动的 Synthesizer V Studio 2 Pro。"
                )
            })?;
            std::process::Command::new(&executable)
                .arg(project_path)
                .spawn()
                .map_err(|error| {
                    format!(
                        "{association_error}\n直接启动 Synthesizer V Studio 2 Pro 也失败：{error}"
                    )
                })?;
            Ok(())
        }
    }
}
