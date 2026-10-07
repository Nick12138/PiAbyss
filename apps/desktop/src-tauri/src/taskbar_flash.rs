//! Taskbar attention (flash) with a tao-workaround on Windows.
//!
//! The renderer normally calls `getCurrentWindow().requestUserAttention()`.
//! That path is broken for this app's borderless window: tao only sets its
//! internal MINIMIZED flag from `WM_SYSCOMMAND/SC_MINIMIZE` (the native
//! title-bar button), but PiAbyss minimizes via the custom title bar
//! (`ShowWindow(SW_MINIMIZE)`), so the flag never flips. When a minimized
//! window still owns thread activation, tao's `request_user_attention`
//! treats it as "active and not minimized" and returns without flashing
//! (tao-0.35.3 `window.rs` `request_user_attention`).
//!
//! This command calls `FlashWindowEx` directly, without that guard. All
//! flashing semantics come from the OS: `FLASHW_ALL | FLASHW_TIMERNOFG`
//! flashes the caption and tray button until the window comes to the
//! foreground; `stop: true` cancels a pending flash.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TaskbarFlashOptions {
    /// `true` cancels a pending flash; `false` (default) starts one.
    #[serde(default)]
    pub stop: bool,
}

#[tauri::command]
pub async fn taskbar_flash(
    app: tauri::AppHandle,
    options: TaskbarFlashOptions,
) -> Result<(), String> {
    eprintln!("[taskbar-flash] invoked stop={}", options.stop);
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use tauri::Manager as _;
            let mut last_error: Option<String> = None;
            for window in app.webview_windows().values() {
                if let Err(error) = flash_window(window, options.stop) {
                    eprintln!("[taskbar-flash] window {} failed: {error}", window.label());
                    last_error = Some(error);
                }
            }
            match last_error {
                Some(error) => Err(error),
                None => Ok(()),
            }
        })
        .await
        .map_err(|error| format!("taskbar flash task failed: {error}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, options);
        Ok(())
    }
}

#[cfg(windows)]
fn flash_window(window: &tauri::WebviewWindow, stop: bool) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_ALL, FLASHW_STOP, FLASHW_TRAY,
    };

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("window {} has no hwnd: {error}", window.label()))?;
    // tauri's hwnd() returns a `windows`-crate HWND(pub *mut c_void);
    // windows-sys wants the handle as isize. Cast the pointer value itself.
    let hwnd_value = hwnd.0 as isize;

    let (flags, count) = if stop {
        // Per MSDN, to stop flashing combine FLASHW_STOP with FLASHW_TRAY so
        // both caption and tray states are cleared.
        (FLASHW_STOP | FLASHW_TRAY, 0)
    } else {
        // Caption + tray button. Empirically on Windows 11, a minimized
        // window rejects FLASHW_ALL|FLASHW_TIMERNOFG when uCount=u32::MAX
        // unless FLASHW_TRAY is spelled out (FlashWindowEx returns FALSE
        // and nothing flashes): 0xF+MAX fails, 0xB+MAX and 0xF+10 both
        // work. Spell out the TRAY bit AND keep a finite count — the
        // 0xB|MAX combination also flashes and is kept as fallback, but
        // the finite count is what tao's Informational path uses and it
        // never gets rejected. A bounded count still restores itself if
        // the user focuses and leaves again (a new notification restarts
        // the flash).
        (FLASHW_ALL | FLASHW_TRAY, 10)
    };
    let flash = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: hwnd_value as _,
        dwFlags: flags,
        uCount: count,
        dwTimeout: 0,
    };
    let result = unsafe { FlashWindowEx(&flash) };
    if result == 0 {
        return Err(format!(
            "FlashWindowEx failed for window {}",
            window.label()
        ));
    }
    Ok(())
}
