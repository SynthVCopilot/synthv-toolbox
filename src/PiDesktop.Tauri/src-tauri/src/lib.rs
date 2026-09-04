pub mod agent;
pub mod agent_files;
mod api_keys;
mod audio_capture;
mod audio_prep;
mod bridge_workflows;
mod commands;
mod components;
mod config;
mod creative_history;
mod creative_tools;
pub mod credential_balancer;
mod downloads;
mod http_api;
mod lyric_projects;
mod lyric_tools;
mod managed_process;
mod mcp;
mod media_import;
mod media_tasks;
mod oauth;
mod opencode_catalog;
mod process_tree;
mod solo_tuning;
mod state;
mod sv2_account_probe;
mod sv2_concurrent;
mod sv2_profiles;
mod sv2_session_guard;
mod sv2_sync;
mod svp_launch_router;
mod synthv;
mod synthv_control;
mod synthv_hosts;
mod synthv_unified;
mod tuning_profiles;
mod update_checker;
mod workbuddy_store;
mod workflows;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use state::AppState;
use svp_launch_router::{
    parse_svp_activation, passthrough_svp_project, SvpActivation, SvpLaunchMode, SvpRoutePlan,
};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

const TRAY_ID: &str = "main-tray";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";

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
            let bundled_components = resource_dir.join("components");
            let development_components =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("components");
            let components_dir = if bundled_components.is_dir() {
                bundled_components
            } else {
                development_components
            };
            let bridge_dir = components_dir.join("synthv-agent-bridge");
            let settings = match crate::config::load_settings() {
                Ok(settings) => settings,
                Err(error) => {
                    eprintln!("{error}");
                    // Keep the UI available as a read-only recovery surface.
                    // save_settings independently blocks every write while the
                    // original file is invalid.
                    crate::config::ToolboxSettings::default()
                }
            };
            let original_svp_prog_id = settings.original_svp_prog_id.clone();
            app.manage(AppState::new(
                resource_dir,
                bridge_dir,
                components_dir,
                passthrough_only,
                settings,
            ));
            let http_api = app.state::<AppState>().http_api.clone();
            let mut http_context = crate::http_api::HttpApiContext::from_state(
                &app.state::<AppState>(),
                app.handle().clone(),
            );
            let http_settings = app.state::<AppState>().settings.clone();
            tauri::async_runtime::spawn(async move {
                let settings = http_settings.read().await;
                http_context.mcp_enabled = settings.http_api_enabled;
                http_context.agent_enabled = settings.http_agent_enabled;
                http_context.port = settings.http_api_port;
                let _ = http_api.start_if_enabled(http_context).await;
            });
            if let Some(activation) = initial_activation.clone() {
                match open_original_svp_project(
                    &activation.project_path,
                    original_svp_prog_id.as_deref(),
                ) {
                    Ok(()) => {
                        let handle = app.handle().clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(750));
                            if handle
                                .state::<AppState>()
                                .svp_passthrough_only
                                .load(Ordering::Acquire)
                            {
                                handle.exit(0);
                            }
                        });
                    }
                    Err(error) => {
                        promote_to_interactive(app.handle());
                        let _ = app.emit("svp-route-error", error);
                    }
                }
            } else {
                promote_to_interactive(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && window.app_handle().tray_by_id(TRAY_ID).is_some() {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::complete_onboarding,
            commands::set_mode,
            commands::set_agent_work_mode,
            commands::authorize_ai_provider,
            commands::select_ai_provider,
            commands::add_ai_api_key,
            commands::remove_ai_api_key,
            commands::ai_provider_state,
            commands::opencode_provider_catalog,
            commands::remove_ai_provider_account,
            commands::scan_synthv,
            commands::check_toolbox_update,
            commands::open_toolbox_releases,
            commands::sv2_profile_state,
            commands::sv2_account_precheck,
            commands::sv2_account_usage_snapshot,
            commands::sv2_account_usage_snapshot_for_slot,
            commands::set_sv2_account_indicator,
            commands::set_sv2_concurrent_enabled,
            commands::sv2_sync_categories,
            commands::preview_sv2_selective_sync,
            commands::execute_sv2_selective_sync,
            commands::import_current_sv2_profile,
            commands::create_sv2_profile,
            commands::rename_sv2_profile,
            commands::update_sv2_profile_identity,
            commands::update_sv2_profile_voice_licenses,
            commands::delete_sv2_profile,
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
            commands::list_synthv_processes,
            commands::synthv_shortcut_profile,
            commands::send_synthv_bridge_shortcut,
            commands::auto_connect_synthv_bridge,
            commands::audio_capture_capability,
            commands::list_synthv_capture_targets,
            commands::capture_synthv_clip,
            commands::compare_synthv_clips,
            commands::ffmpeg_status,
            commands::probe_media,
            commands::plan_audio_prepare,
            commands::start_audio_prepare,
            commands::analyze_loudness,
            commands::plan_loudness_normalize,
            commands::start_loudness_normalize,
            commands::audio_job_snapshot,
            commands::cancel_audio_job,
            commands::component_downloads,
            commands::queue_component_install,
            commands::cancel_component_install,
            commands::retry_component_install,
            commands::open_downloaded_component,
            commands::remove_local_component,
            commands::list_workflow_recipes,
            commands::list_creative_history,
            commands::create_project_checkpoint,
            commands::list_project_checkpoints,
            commands::restore_project_checkpoint,
            commands::export_workflow_report,
            commands::lookup_chinese_rhyme,
            commands::build_lyric_template,
            commands::generate_lyric_candidates,
            commands::list_lyric_projects,
            commands::create_lyric_project,
            commands::save_lyric_project,
            commands::load_lyric_project,
            commands::run_project_doctor,
            commands::run_pronunciation_diagnostics,
            commands::run_render_review,
            commands::run_audio_to_project,
            commands::run_score_to_synthv,
            commands::run_retake_workbench,
            commands::run_batch_workflow,
            commands::run_audio_probe,
            commands::learn_tuning_profile,
            commands::list_tuning_profiles,
            commands::get_tuning_profile,
            commands::record_tuning_outcome,
            commands::apply_tuning_profile,
            commands::run_solo_tuning,
            commands::preview_media_source,
            commands::media_tasks,
            commands::queue_media_import,
            commands::queue_media_separation,
            commands::queue_cover,
            commands::cancel_media_task,
            commands::retry_media_task,
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
            commands::agent_file_approvals,
            commands::decide_agent_file_approval,
            commands::get_http_api_status,
            commands::configure_http_api,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SynthV Toolbox");
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let menu = MenuBuilder::new(app)
        .text(TRAY_SHOW_ID, "打开 SynthV Toolbox")
        .separator()
        .text(TRAY_QUIT_ID, "退出")
        .build()?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .tooltip("SynthV Toolbox")
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if !cfg!(target_os = "macos")
                && matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                )
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn promote_to_interactive(app: &tauri::AppHandle) {
    app.state::<AppState>()
        .svp_passthrough_only
        .store(false, Ordering::Release);
    if let Err(error) = setup_tray(app) {
        eprintln!("failed to create SynthV Toolbox tray icon: {error}");
    }
    show_main_window(app);
}

fn handle_svp_activation(app: tauri::AppHandle, args: Vec<String>, cwd: Option<String>) {
    let activation = match parse_svp_activation(&args, cwd.as_deref()) {
        Ok(Some(activation)) => activation,
        Ok(None) => {
            promote_to_interactive(&app);
            return;
        }
        Err(error) => {
            promote_to_interactive(&app);
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
            promote_to_interactive(&app);
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
                promote_to_interactive(&app);
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
            promote_to_interactive(&app);
            let _ = app.emit("svp-route-error", error);
        }
        return;
    }

    promote_to_interactive(&app);
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
