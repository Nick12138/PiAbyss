#![allow(linker_messages)]

mod browser_surface;
mod commands;
mod desktop_settings;
mod draft_store;
mod pi_host;
#[cfg(test)]
mod pi_host_tests;
mod shell_terminal;
mod system_autostart;
mod system_notification;
mod system_tray;

use desktop_settings::DesktopSettingsStore;
use draft_store::DraftStore;
use pi_host::{HostTransportFrame, PiHostPool};
use shell_terminal::ShellTerminalManager;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Listener, Manager};
use tokio::sync::Mutex;

pub struct AppState {
    pub exit_approved: AtomicBool,
    pub settings: Mutex<DesktopSettingsStore>,
    pub drafts: Mutex<DraftStore>,
    pub hosts: Mutex<PiHostPool>,
    pub terminals: Mutex<ShellTerminalManager>,
    pub browsers: Mutex<BrowserSurfaceManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            system_tray::install(app)?;

            let mut settings = DesktopSettingsStore::load(app.handle())?;
            settings.ensure_default_project_workspace()?;
            if let Err(error) = system_autostart::configure(settings.settings.auto_start_on_boot) {
                eprintln!("[piabyss] failed to configure startup launch: {error}");
            }
            if system_autostart::was_launched_at_login() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            let drafts = DraftStore::load(app.handle());
            let hosts = PiHostPool::new(app.handle().clone(), &settings);
            app.manage(AppState {
                exit_approved: AtomicBool::new(false),
                settings: Mutex::new(settings),
                drafts: Mutex::new(drafts),
                hosts: Mutex::new(hosts),
                terminals: Mutex::new(ShellTerminalManager::new()),
                browsers: Mutex::new(BrowserSurfaceManager::new()),
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let host = state.hosts.lock().await.active_manager();
                // start_unlocked never holds the host mutex across the ready-wait,
                // so IPC commands and app exit stay responsive during startup.
                if let Err(e) = pi_host::start_unlocked(&host, pi_host::StartKind::Fresh).await {
                    eprintln!("[piabyss] failed to start host: {e}");
                    // Surface to UI as host.fatal so the banner shows the real cause
                    let _ = handle.emit(
                        "pi-host-stdout",
                        HostTransportFrame {
                            route_id: state.hosts.lock().await.active_route_id(),
                            line: serde_json::json!({
                            "protocolVersion": 1,
                            "event": "host.fatal",
                            "sequence": 1,
                            "timestamp": 0,
                            "hostInstanceId": "00000000-0000-4000-8000-000000000001",
                            "workspaceId": null,
                            "workspaceRevision": 0,
                            "sessionId": null,
                            "sessionRevision": 0,
                            "packageRevision": 0,
                            "payload": {
                                "error": {
                                    "code": "INTERNAL_ERROR",
                                    "message": e,
                                    "retryable": true
                                }
                            }
                            })
                            .to_string(),
                        },
                    );
                }
            });

            // One-shot auto-restart after unexpected Host exit (R3)
            let handle_ar = app.handle().clone();
            app.listen("pi-host-auto-restart", move |event| {
                let handle = handle_ar.clone();
                let route_id = serde_json::from_str::<String>(event.payload())
                    .unwrap_or_else(|_| event.payload().trim_matches('"').to_string());
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    let host = state.hosts.lock().await.manager_for_route(&route_id);
                    let Some(host) = host else {
                        return;
                    };
                    eprintln!("[piabyss] auto-restarting Host once after crash");
                    if let Err(e) =
                        pi_host::start_unlocked(&host, pi_host::StartKind::AutoRestartAfterCrash)
                            .await
                    {
                        eprintln!("[piabyss] auto-restart failed: {e}");
                        let _ = handle.emit(
                            "pi-host-stdout",
                            HostTransportFrame {
                                route_id: route_id.clone(),
                                line: serde_json::json!({
                                "protocolVersion": 1,
                                "event": "host.fatal",
                                "sequence": 1,
                                "timestamp": 0,
                                "hostInstanceId": "00000000-0000-4000-8000-000000000003",
                                "workspaceId": null,
                                "workspaceRevision": 0,
                                "sessionId": null,
                                "sessionRevision": 0,
                                "packageRevision": 0,
                                "payload": {
                                    "error": {
                                        "code": "INTERNAL_ERROR",
                                        "message": format!("Auto-restart failed: {e}"),
                                        "retryable": false
                                    }
                                }
                                })
                                .to_string(),
                            },
                        );
                    }
                });
            });

            let handle_gc = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let state = handle_gc.state::<AppState>();
                    // Read live so a settings change takes effect on the next tick.
                    let rss_retire_mb =
                        state.settings.lock().await.settings.host_idle_rss_retire_mb;
                    let retired = state
                        .hosts
                        .lock()
                        .await
                        .take_expired_idle_hosts(rss_retire_mb);
                    for manager in retired {
                        manager.lock().await.shutdown().await;
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_settings_get,
            commands::desktop_settings_patch,
            commands::desktop_drafts_get,
            commands::desktop_drafts_apply,
            commands::desktop_open_path,
            commands::desktop_allow_exit,
            commands::desktop_exit,
            commands::desktop_read_small_file,
            commands::desktop_file_info,
            commands::pi_host_send,
            commands::pi_host_activate,
            commands::pi_host_prepare_switch,
            commands::pi_host_rebind_active,
            commands::pi_host_active_route,
            commands::pi_host_replay_ready,
            commands::pi_host_restart,
            commands::pi_host_status,
            commands::pi_host_activity,
            commands::pi_host_acknowledge_terminal,
            commands::pi_host_bootstrap_telegram,
            system_notification::system_notify,
            commands::shell_terminal_create,
            commands::shell_terminal_profiles,
            commands::shell_terminal_write,
            commands::shell_terminal_resize,
            commands::shell_terminal_close,
            commands::browser_surface_create,
            commands::browser_surface_navigate,
            commands::browser_surface_control,
            commands::browser_surface_set_bounds,
            commands::browser_surface_set_visible,
            commands::browser_surface_focus,
            commands::browser_surface_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if system_tray::should_hide_on_close(&label) => {
                api.prevent_close();
                // The frontend checks unsaved file edits before hiding to tray.
            }
            tauri::RunEvent::ExitRequested { api, .. }
                if app_handle.get_webview_window("main").is_some()
                    && !app_handle
                        .state::<AppState>()
                        .exit_approved
                        .load(Ordering::SeqCst) =>
            {
                api.prevent_exit();
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("desktop-quit-requested", ());
                }
            }
            tauri::RunEvent::Exit => {
                system_tray::remove(app_handle);
                let handle = app_handle.clone();
                tauri::async_runtime::block_on(async move {
                    let state = handle.state::<AppState>();
                    let mut browsers = state.browsers.lock().await;
                    browsers.shutdown_all();
                    drop(browsers);
                    let mut terminals = state.terminals.lock().await;
                    terminals.shutdown_all();
                    drop(terminals);
                    let hosts = state.hosts.lock().await;
                    hosts.shutdown_all(true).await;
                });
            }
            _ => {}
        });
}
use browser_surface::BrowserSurfaceManager;
