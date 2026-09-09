//! System (OS-level) notification delivery with click-through support.
//!
//! `tauri-plugin-notification`'s desktop backend only forwards title/body to
//! the OS: it never emits the `actionPerformed` event (that is mobile-only)
//! and drops the `extra` payload, so a toast click could not be routed back
//! into the renderer. This command sends the toast directly and — on Windows —
//! wires the WinRT `Activated` callback to a Tauri event so the renderer's
//! notification click router (navigate to workspace/session) actually runs.
//! Non-Windows desktop platforms keep the plugin's delivery path (no click
//! events there either way).

use serde::Deserialize;

/// Payload mirrors the plugin's `Options` subset the renderer actually uses.
/// `extra` carries the `{ kind, target }` object that is validated and routed
/// by the renderer (see `isNotificationPayload` in system-notifications.ts).
#[derive(Debug, Deserialize)]
pub struct SystemNotificationOptions {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

/// The renderer listens on this event to route toast clicks through
/// `openSystemNotificationTarget` (show window → switch workspace/session).
pub const CLICK_EVENT: &str = "system-notification-click";

#[tauri::command]
pub async fn system_notify(
    app: tauri::AppHandle,
    options: SystemNotificationOptions,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || notify_windows(&app, &options))
            .await
            .map_err(|error| format!("system notify task failed: {error}"))?
    }
    #[cfg(not(windows))]
    {
        // Plugin fallback: delivery works, click routing is unavailable on
        // this platform regardless of which sender is used.
        use tauri_plugin_notification::NotificationExt as _;
        let builder = app
            .notification()
            .builder()
            .title(options.title)
            .body(options.body);
        builder.show().map_err(|error| error.to_string())
    }
}

/// WinRT toast with a click callback. Mirrors the plugin's AppUserModelID
/// choice: installed builds use the bundle identifier (the installer's Start
/// Menu shortcut registers that AUMID); dev builds fall back to the always
/// available PowerShell AUMID so toasts still show.
#[cfg(windows)]
fn notify_windows(
    app: &tauri::AppHandle,
    options: &SystemNotificationOptions,
) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_winrt_notification::Toast;

    let app_id = match dev_build_exe_dir() {
        Some(true) => Toast::POWERSHELL_APP_ID.to_string(),
        _ => app.config().identifier.clone(),
    };

    let click_app = app.clone();
    let click_extra = options.extra.clone();
    let toast = Toast::new(&app_id)
        .title(&options.title)
        .text1(&options.body)
        .on_activated(move |_arguments| {
            if let Some(extra) = click_extra.clone() {
                let _ = click_app.emit(CLICK_EVENT, extra);
            }
            Ok(())
        });
    toast.show().map_err(|error| error.to_string())
}

/// True when the running executable lives in a cargo `target/debug` or
/// `target/release` directory (no installed AUMID shortcut to lean on).
/// Mirrors the check `tauri-plugin-notification` performs for `app_id`.
#[cfg(windows)]
fn dev_build_exe_dir() -> Option<bool> {
    let exe = tauri::utils::platform::current_exe().ok()?;
    let dir = exe.parent()?.display().to_string();
    let sep = std::path::MAIN_SEPARATOR;
    Some(
        dir.ends_with(format!("{sep}target{sep}debug").as_str())
            || dir.ends_with(format!("{sep}target{sep}release").as_str()),
    )
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Manual self-check: `cargo test --lib system_notify_self_check -- --ignored`.
    /// Shows a real toast under the PowerShell AUMID (dev fallback path) and
    /// keeps the process alive for 15s — clicking it exercises the WinRT
    /// Activated → Tauri event wiring that P3 depends on.
    #[test]
    #[ignore = "shows a real OS toast; run manually"]
    fn system_notify_self_check() {
        let toast = tauri_winrt_notification::Toast::new(ToastAumidDev::aumid())
            .title("PiAbyss 通知自检")
            .text1("若能看到此通知，说明 WinRT 投递链路正常；点击它可验证点击回传。")
            .on_activated(|_args| {
                eprintln!("[self-check] toast click callback fired");
                Ok(())
            });
        toast
            .show()
            .expect("toast delivery failed (WinRT path broken)");
        std::thread::sleep(std::time::Duration::from_secs(15));
    }

    struct ToastAumidDev;
    impl ToastAumidDev {
        fn aumid() -> &'static str {
            tauri_winrt_notification::Toast::POWERSHELL_APP_ID
        }
    }
}
