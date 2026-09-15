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
use std::sync::atomic::{AtomicBool, Ordering};

/// Set when startup AUMID registration succeeded; when true the toast sender
/// can safely use the bundle identifier as the AppUserModelID in every build
/// (dev builds included), since the HKCU key makes Windows render those
/// toasts instead of silently dropping them.
static TOAST_AUMID_REGISTERED: AtomicBool = AtomicBool::new(false);

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

    // Prefer the bundle identifier whenever startup registration succeeded —
    // it works in dev and installed builds alike and shows the app's own
    // name/icon. Only an unregistered dev build (registration failed) falls
    // back to the always-available PowerShell AUMID.
    let app_id = if TOAST_AUMID_REGISTERED.load(Ordering::Acquire) {
        app.config().identifier.clone()
    } else if dev_build_exe_dir() == Some(true) {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
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

/// Registers the app's toast AUMID under HKCU at startup.
///
/// Windows only renders a toast whose AppUserModelID resolves to either a
/// Start Menu shortcut carrying that AUMID or an explicit
/// `HKCU\Software\Classes\AppUserModelId\<id>` key. The NSIS install can
/// produce neither (shortcut step skipped, manually created desktop-only
/// shortcuts), and then every toast is silently dropped — the WinRT `show()`
/// call still succeeds and the renderer never learns about it. Writing the
/// per-user key (no elevation needed) at startup makes delivery independent
/// of how the app was installed or launched. Idempotent; failures are
/// logged, never fatal.
#[cfg(windows)]
pub fn ensure_toast_aumid_registered(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let identifier = app.config().identifier.clone();
    let display_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| identifier.clone());
    // IconUri is happiest with a plain .ico on an ASCII path: exe paths break
    // when current_exe() returns a verbatim (\\?\) path, and even stripped
    // paths fail when the install/repo directory is non-ASCII (e.g. a Chinese
    // dev checkout). So write the bundled icon into the per-user config dir
    // and point IconUri there, falling back to the exe path only if the write
    // fails.
    let icon_bytes: &[u8] = include_bytes!("../icons/icon.ico");
    let icon_uri = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| {
            std::fs::create_dir_all(&dir).ok()?;
            let icon = dir.join("toast-icon.ico");
            std::fs::write(&icon, icon_bytes).ok()?;
            Some(icon.display().to_string())
        })
        .or_else(|| {
            tauri::utils::platform::current_exe().ok().map(|exe| {
                let mut text = exe.display().to_string();
                if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
                    text = format!(r"\\{unc}");
                } else if let Some(stripped) = text.strip_prefix(r"\\?\") {
                    text = stripped.to_string();
                }
                text
            })
        })
        .unwrap_or_default();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\AppUserModelId\{identifier}");
    let result = hkcu.create_subkey(&path).and_then(|(key, _)| {
        key.set_value("DisplayName", &display_name)?;
        if !icon_uri.is_empty() {
            key.set_value("IconUri", &icon_uri)?;
        }
        Ok(())
    });
    if let Err(error) = result {
        eprintln!("[piabyss] failed to register toast AUMID {identifier}: {error}");
        return;
    }
    TOAST_AUMID_REGISTERED.store(true, Ordering::Release);
}

/// No-op: AUMID registration is only meaningful for Windows toast delivery.
#[cfg(not(windows))]
pub fn ensure_toast_aumid_registered(_app: &tauri::AppHandle) {}

/// True when the running executable lives in a cargo `target/debug` or
/// `target/release` directory (no installed AUMID shortcut to lean on).
/// Mirrors the check `tauri-plugin-notification` performs for `app_id`.
#[cfg(windows)]
fn dev_build_exe_dir() -> Option<bool> {
    let exe = tauri::utils::platform::current_exe().ok()?;
    let dir = exe.parent()?.display().to_string();
    Some(is_dev_exe_dir(&dir))
}

/// Dev builds have no installer-registered AUMID shortcut, so they must fall
/// back to the always-available PowerShell AUMID or Windows silently drops
/// every toast. The exact two-segment layout (`target\debug`) is not enough:
/// custom CARGO_TARGET_DIRs and build scripts nest deeper (e.g. this repo's
/// `pnpm dev:fast` runs out of `target\dev-fast\debug`), so the check is
/// "some `target` path segment + a trailing debug/release segment".
#[cfg(windows)]
fn is_dev_exe_dir(dir: &str) -> bool {
    let sep = std::path::MAIN_SEPARATOR;
    if !dir.contains(format!("{sep}target{sep}").as_str()) {
        return false;
    }
    dir.ends_with(format!("{sep}debug").as_str()) || dir.ends_with(format!("{sep}release").as_str())
}

#[cfg(all(test, windows))]
mod tests {
    // NOTE: no `use super::*` — every reference below is fully qualified;
    // a glob import here trips `clippy -D warnings` (unused_imports).

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

    #[test]
    fn dev_exe_dir_matches_nested_target_profiles() {
        let sep = std::path::MAIN_SEPARATOR;
        let join = |parts: &[&str]| parts.join(&sep.to_string());
        // Stock cargo layouts.
        assert!(crate::system_notification::is_dev_exe_dir(&join(&[
            "repo", "target", "debug"
        ])));
        assert!(crate::system_notification::is_dev_exe_dir(&join(&[
            "repo", "target", "release"
        ])));
        // Custom target dirs / nested profiles (pnpm dev:fast, verify builds).
        assert!(crate::system_notification::is_dev_exe_dir(&join(&[
            "repo",
            "apps",
            "desktop",
            "src-tauri",
            "target",
            "dev-fast",
            "debug"
        ])));
        assert!(crate::system_notification::is_dev_exe_dir(&join(&[
            "repo",
            "target",
            "verify-rust",
            "debug"
        ])));
        // Installed builds: not under `target`, or target dir without a
        // trailing profile segment.
        assert!(!crate::system_notification::is_dev_exe_dir(&join(&[
            "Program Files",
            "PiAbyss"
        ])));
        assert!(!crate::system_notification::is_dev_exe_dir(&join(&[
            "repo", "target", "dev-fast"
        ])));
        // `target` must be an exact path segment, not a prefix.
        assert!(!crate::system_notification::is_dev_exe_dir(&join(&[
            "repo",
            "targeting",
            "debug"
        ])));
    }
}

#[cfg(all(test, windows))]
mod aumid_self_check {
    /// Manual: `cargo test --lib installed_aumid_toast_check -- --ignored`.
    /// Shows a real toast under the INSTALLED app's AUMID — the exact path
    /// the `system_notify` command uses on installed builds.
    #[test]
    #[ignore = "shows a real OS toast; run manually"]
    fn installed_aumid_toast_check() {
        tauri_winrt_notification::Toast::new("com.nick12138.pideck")
            .title("PiAbyss 通知自检 (AUMID)")
            .text1("如果你看到这条通知，说明系统投递正常，问题在应用触发逻辑。")
            .show()
            .expect("toast delivery failed with registered AUMID");
        std::thread::sleep(std::time::Duration::from_secs(20));
    }
}
