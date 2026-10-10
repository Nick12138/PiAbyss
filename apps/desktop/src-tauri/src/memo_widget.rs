//! 备忘速记小窗（memo-widget）：全局快捷键 / 托盘可唤出的桌面速记面板。
//!
//! 设计取舍：
//!   - 窗口懒创建：首次唤出才创建无边框小窗；之后显隐复用，关闭请求被
//!     转为隐藏（保持 webview 存活，下次唤出即点即开）。
//!   - 首次创建后保持隐藏：前端加载完成、从 localStorage 恢复位置/大小
//!     后调用 `memo_widget_show` 自行显示，避免窗口在默认位置闪跳。
//!   - 位置/大小/置顶状态由前端持久化；Rust 侧只在首次创建时给一个
//!     靠近屏幕右下角的默认位置（估算任务栏高度，用户首次拖动后以
//!     前端保存的位置为准）。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MEMO_WIDGET_LABEL: &str = "memo-widget";
pub const MEMO_WIDGET_SHORTCUT: &str = "Alt+Space";
const WIDGET_MODE_FLOAT: &str = "float";
const WIDGET_MODE_DESKTOP: &str = "desktop";
const MEMO_WIDGET_URL: &str = "widget.html";

const DEFAULT_WIDTH: f64 = 380.0;
const DEFAULT_HEIGHT: f64 = 560.0;
const MIN_WIDTH: f64 = 320.0;
const MIN_HEIGHT: f64 = 420.0;
/** 默认位置距屏幕右/下边缘的留白（逻辑像素）。 */
const EDGE_MARGIN: f64 = 16.0;
/** 任务栏高度的保守估算（逻辑像素），仅用于首次默认位置。 */
const TASKBAR_ALLOWANCE: f64 = 64.0;

/// 托盘 / 快捷键入口：小窗已显示则隐藏，否则创建（首唤出）或唤出。
pub fn toggle<R: tauri::Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(MEMO_WIDGET_LABEL) {
        Some(window) => match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => show_focused(&window),
        },
        None => match ensure_window(app) {
            // 首次创建：保持隐藏，等前端恢复位置后自行 show。
            Ok(_) => {}
            Err(error) => eprintln!("[piabyss] failed to create memo widget: {error}"),
        },
    }
}

pub fn show_focused<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// 创建（或复用已有的）memo-widget 窗口。创建结果保持隐藏。
pub fn ensure_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(MEMO_WIDGET_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        MEMO_WIDGET_LABEL,
        WebviewUrl::App(MEMO_WIDGET_URL.into()),
    )
    .title("PiAbyss Memo")
    .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
    .decorations(false)
    .skip_taskbar(true)
    .resizable(true)
    .shadow(true)
    .always_on_top(true)
    .visible(false)
    .build()?;
    place_default(&window);
    Ok(window)
}

/// 首次创建时的默认位置：当前显示器右下角（避开估算的任务栏）。
fn place_default<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use tauri::LogicalPosition;
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return;
    }
    let size = monitor.size();
    let origin = monitor.position();
    let monitor_right = origin.x as f64 + size.width as f64 / scale;
    let monitor_bottom = origin.y as f64 + size.height as f64 / scale;
    let x = monitor_right - DEFAULT_WIDTH - EDGE_MARGIN;
    let y = monitor_bottom - DEFAULT_HEIGHT - EDGE_MARGIN - TASKBAR_ALLOWANCE;
    let _ = window.set_position(LogicalPosition::new(
        x.max(origin.x as f64 / scale),
        y.max(origin.y as f64 / scale),
    ));
}

/// 全局快捷键插件：Alt+Space 唤出/隐藏小窗。注册失败（如被其他程序
/// 占用）只打日志，托盘入口仍可用。
/// 注意：这会全局接管 Alt+Space（各应用原本的窗口菜单快捷键）；
/// 底层 RegisterHotKey 的 MOD_ALT 不区分左/右 Alt。
pub fn shortcut_plugin<R: tauri::Runtime>() -> tauri_plugin_global_shortcut::Builder<R> {
    use tauri_plugin_global_shortcut::{Builder, Shortcut, ShortcutState};

    Builder::new().with_handler(move |app, shortcut, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        if let Ok(expected) = MEMO_WIDGET_SHORTCUT.parse::<Shortcut>() {
            if *shortcut == expected {
                toggle(app);
            }
        }
    })
}

#[tauri::command]
pub fn memo_widget_toggle<R: tauri::Runtime>(app: AppHandle<R>) {
    toggle(&app);
}

/// 前端恢复位置/大小后自行显示（首次创建流程），或用户按 Esc 隐藏前调用。
#[tauri::command]
pub fn memo_widget_show<R: tauri::Runtime>(app: AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MEMO_WIDGET_LABEL) {
        show_focused(&window);
    }
}

#[tauri::command]
pub fn memo_widget_hide<R: tauri::Runtime>(app: AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MEMO_WIDGET_LABEL) {
        let _ = window.hide();
    }
}

/// 从小窗跳回主窗口并打开备忘录页。
#[tauri::command]
pub fn memo_widget_show_main<R: tauri::Runtime>(app: AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::system_tray::MAIN_WINDOW_LABEL) {
        show_focused(&window);
    }
    let _ = app.emit("memo-widget-open-memo", ());
}

/// 小窗存在模式：
///   - `float`：悬浮置顶，浮在所有窗口之上（默认）；
///   - `desktop`：钉在桌面层，永远沉在普通窗口之下，其他窗口会盖住它，
///     按 Win+D/显示桌面时仍可见。
///
/// 置底语义由 tao 的 ALWAYS_ON_BOTTOM 实现（WM_WINDOWPOSCHANGING 强制
/// HWND_BOTTOM），激活/聚焦都不会把它抬上来。
#[tauri::command]
pub fn memo_widget_set_mode<R: tauri::Runtime>(app: AppHandle<R>, mode: String) -> Result<(), String> {
    let window = app
        .get_webview_window(MEMO_WIDGET_LABEL)
        .ok_or_else(|| "memo widget window not found".to_string())?;
    match mode.as_str() {
        WIDGET_MODE_FLOAT => {
            window.set_always_on_bottom(false).map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
        }
        WIDGET_MODE_DESKTOP => {
            window.set_always_on_top(false).map_err(|e| e.to_string())?;
            window.set_always_on_bottom(true).map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("unknown memo widget mode: {mode}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn shortcut_and_label_are_stable_constants() {
        assert_eq!(super::MEMO_WIDGET_LABEL, "memo-widget");
        assert_eq!(super::MEMO_WIDGET_SHORTCUT, "Alt+Space");
        assert!(super::MEMO_WIDGET_SHORTCUT.parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok());
    }

    #[test]
    fn mode_names_are_stable_constants() {
        assert_eq!(super::WIDGET_MODE_FLOAT, "float");
        assert_eq!(super::WIDGET_MODE_DESKTOP, "desktop");
    }
}
