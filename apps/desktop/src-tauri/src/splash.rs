//! 启动开屏小窗（splash）。
//!
//! 目标：Host 启动 + 前端 bootstrap 全部完成之前，用户看到的是一个**小而稳**
//! 的开屏窗；一切就绪后交接给主窗口，而不是让主窗口自己一边加载一边上屏。
//!
//! 设计取舍（对齐 `memo_widget` 的既有约定）：
//!   - 窗口**程序化创建**，不写进 `tauri.conf.json`：登录项后台启动不建开屏，
//!     只有正常启动路径才有。
//!   - 创建后保持隐藏，由 splash 前端加载完成自行调 `splash_ready` 显示，
//!     避免窗口在默认位置闪跳（同 memo-widget）。
//!   - 主窗口在配置文件里是 `visible: false`：开屏期间它照常加载并跑完整个
//!     bootstrap（设置 / 工作区 / 会话），只是不上屏；等前端报 `splash_finish`
//!     才交接。这样「加载中」和「已就绪」是两套独立的窗口，不会互相拖慢。
//!   - 阶段是**可拉取**的：Rust 在 `starting-host` 就广播时，splash 的 JS 往往
//!     还没加载完，事件必丢。所以当前阶段存在 `AppState.splash_stage` 里，
//!     splash 挂载时用 `splash_context` 先拉一次，再靠 `splash-stage` 事件跟进。

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::desktop_settings::DesktopLanguage;
use crate::AppState;

pub const SPLASH_LABEL: &str = "splash";
const SPLASH_URL: &str = "splash.html";

/// 开屏窗初始阶段。也是 `AppState.splash_stage` 的初值。
pub const SPLASH_INITIAL_STAGE: &str = "preparing";

const SPLASH_WIDTH: f64 = 360.0;
/// 内容高 134px（标 52 + 应用名 15 + 进度条 2 + 轮播文案 20，加 3 个 15px 间距），
/// 上下各留 ~37px 呼吸位。
const SPLASH_HEIGHT: f64 = 210.0;

/// 开屏保底停留时长。Host 冷启动有时几百毫秒就绪，不保底会「闪一下就没」，
/// 用户既看不清动画也读不到阶段文案。
pub const MIN_SPLASH_VISIBLE_MS: u64 = 3_000;

/// 主窗口先上屏、splash 稍后再关，中间不留「两个窗口都没有」的空档。
const HANDOFF_DELAY_MS: u64 = 260;

/// 兜底看门狗：前端迟迟不报就绪（渲染崩了 / 卡死 / WebView 起不来）时强制
/// 交接。否则用户会面对一个永远关不掉的开屏。取值远大于正常启动耗时，
/// 只在异常路径生效。
pub const SPLASH_WATCHDOG_MS: u64 = 45_000;

/// `splash-stage` 事件载荷。`stage` 用与前端 `StartupStage` 同一套词表。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplashStagePayload<'a> {
    stage: &'a str,
}

/// splash 前端启动时拉取的上下文。
///
/// 语言之所以走 IPC 而不是塞进 URL query：`WebviewUrl::App` 的路径会被当成
/// URL path 处理，带 `?` 不可靠；而 splash 只活几秒，不值得为它引一套路由。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplashContext {
    /// 用户显式选择的界面语言。`None` = 跟随系统，由 splash 按
    /// `navigator.language` 自行判断（与前端 `resolveLocale` 的回落规则一致）。
    pub language: Option<String>,
    /// 拉取时的当前阶段。补上「splash JS 加载完成之前已广播的阶段」。
    pub stage: String,
}

/// 创建开屏窗口（保持隐藏，等前端 `splash_ready`）。
pub fn create<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    let window = WebviewWindowBuilder::new(app, SPLASH_LABEL, WebviewUrl::App(SPLASH_URL.into()))
        .title("PiAbyss")
        .inner_size(SPLASH_WIDTH, SPLASH_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        // 启动期间浮在最上层：用户此时可能正对着别的窗口，开屏不该被盖住。
        .always_on_top(true)
        .skip_taskbar(true)
        // 开屏不抢焦点：用户可能是启动后立刻去别的窗口干活了。真正该抢焦点的
        // 时刻是交接——`finish` 里对主窗口 set_focus。
        .focused(false)
        .center()
        .visible(false)
        .build()?;
    Ok(window)
}

/// 记录当前阶段并广播给开屏窗。没有开屏窗（登录项启动 / 已交接）时静默。
pub async fn set_stage<R: tauri::Runtime>(app: &AppHandle<R>, stage: &str) {
    {
        let state = app.state::<AppState>();
        *state.splash_stage.lock().await = stage.to_string();
    }
    if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
        let _ = window.emit("splash-stage", SplashStagePayload { stage });
    }
}

/// 交接：主窗口上屏 → 稍后关闭开屏。幂等——前端与看门狗谁先到谁生效。
pub async fn finish<R: tauri::Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if state.splash_finished.swap(true, Ordering::SeqCst) {
        return;
    }

    // 保底停留：从开屏**真正显示**的那一刻起算，而不是从进程启动算。
    let shown_at = *state.splash_shown_at.lock().await;
    if let Some(shown_at) = shown_at {
        let minimum = Duration::from_millis(MIN_SPLASH_VISIBLE_MS);
        let elapsed = shown_at.elapsed();
        if elapsed < minimum {
            tokio::time::sleep(minimum - elapsed).await;
        }
    }

    // 登录项后台启动：不弹主窗口，用户从托盘唤起（保持既有行为）。
    if !state.start_hidden.load(Ordering::SeqCst) {
        if let Some(main) = app.get_webview_window(crate::system_tray::MAIN_WINDOW_LABEL) {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }

    if app.get_webview_window(SPLASH_LABEL).is_some() {
        // 让开屏先切到「准备完成」，再随主窗口上屏退场。
        set_stage(app, "ready").await;
        tokio::time::sleep(Duration::from_millis(HANDOFF_DELAY_MS)).await;
        if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
            let _ = splash.close();
        }
    }
}

/// 启动看门狗：到点仍未交接就强制交接，避免开屏卡死无人收场。
pub fn spawn_watchdog<R: tauri::Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SPLASH_WATCHDOG_MS)).await;
        if !handle
            .state::<AppState>()
            .splash_finished
            .load(Ordering::SeqCst)
        {
            eprintln!(
                "[piabyss] splash watchdog fired after {SPLASH_WATCHDOG_MS}ms; handing off without a renderer ready signal"
            );
            finish(&handle).await;
        }
    });
}

/// splash 前端加载完成 → 上屏。同时记录显示时刻，供 `finish` 计算保底停留。
#[tauri::command]
pub async fn splash_ready<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut shown_at = state.splash_shown_at.lock().await;
    let first_call = shown_at.is_none();
    if first_call {
        *shown_at = Some(Instant::now());
    }
    drop(shown_at);

    if first_call {
        if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
            let _ = window.show();
        }
    }
    Ok(())
}

/// 主窗口把 `resolveStartupStage` 的结果实时推给开屏。
#[tauri::command]
pub async fn splash_stage<R: tauri::Runtime>(app: AppHandle<R>, stage: String) {
    set_stage(&app, &stage).await;
}

/// 主窗口 bootstrap 全部完成 → 交接。保底时长与关闭延迟都在 `finish` 里。
#[tauri::command]
pub async fn splash_finish<R: tauri::Runtime>(app: AppHandle<R>) {
    finish(&app).await;
}

/// splash 前端拉取上下文（语言 + 当前阶段）。
#[tauri::command]
pub async fn splash_context(state: tauri::State<'_, AppState>) -> Result<SplashContext, String> {
    let language = match state.settings.lock().await.settings.language {
        Some(DesktopLanguage::Zh) => Some("zh".to_string()),
        Some(DesktopLanguage::En) => Some("en".to_string()),
        // `System` 与缺省都交给 splash 按 navigator.language 判断——Rust 侧
        // 拿不到浏览器/系统的界面语言偏好，硬猜不如不猜。
        _ => None,
    };
    let stage = state.splash_stage.lock().await.clone();
    Ok(SplashContext { language, stage })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_and_timings_are_stable() {
        assert_eq!(SPLASH_LABEL, "splash");
        assert_eq!(SPLASH_URL, "splash.html");
        assert_eq!(SPLASH_INITIAL_STAGE, "preparing");
        assert_eq!(MIN_SPLASH_VISIBLE_MS, 3_000);
        // 看门狗必须显著长于保底停留，否则正常启动也会被兜底路径抢跑。
        const {
            assert!(SPLASH_WATCHDOG_MS > MIN_SPLASH_VISIBLE_MS * 10);
        }
        // 交接延迟要短到用户感知不到，又不能为 0（否则两个窗口同时消失）。
        const {
            assert!(HANDOFF_DELAY_MS > 0 && HANDOFF_DELAY_MS < 1_000);
        }
    }
}
