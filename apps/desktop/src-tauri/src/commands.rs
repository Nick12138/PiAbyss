use crate::browser_surface::{BrowserSurfaceBounds, BrowserSurfaceSnapshot};
use crate::desktop_settings::{DesktopSettings, DesktopSettingsSnapshot};
use crate::draft_store::{DraftApplyResult, DraftMutation, DraftWorkspaceSnapshot};
use crate::shell_terminal::{
    shell_profile_catalog, ShellProfileCatalog, ShellTerminalCreateResult, ShellTerminalEvent,
};
use crate::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, State};

#[tauri::command]
pub async fn desktop_settings_get(
    state: State<'_, AppState>,
) -> Result<DesktopSettingsSnapshot, String> {
    let store = state.settings.lock().await;
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn desktop_settings_patch(
    state: State<'_, AppState>,
    patch: Value,
) -> Result<DesktopSettings, String> {
    let requested_auto_start = patch.get("autoStartOnBoot").and_then(Value::as_bool);
    let mut store = state.settings.lock().await;
    let previous_auto_start = store.settings.auto_start_on_boot;

    // Register/unregister first so a registry failure never leaves the JSON
    // setting claiming that startup launch is enabled when it is not.
    if let Some(enabled) = requested_auto_start {
        if enabled != previous_auto_start {
            crate::system_autostart::configure(enabled)?;
        }
    }

    let next = match store.patch(patch) {
        Ok(next) => next,
        Err(error) => {
            if let Some(enabled) = requested_auto_start {
                if enabled != previous_auto_start {
                    let _ = crate::system_autostart::configure(previous_auto_start);
                }
            }
            return Err(error);
        }
    };
    // Propagate agentDir / autoRestart to host manager
    let hosts = state.hosts.lock().await;
    hosts.update_settings(&store).await;
    Ok(next)
}

#[tauri::command]
pub async fn desktop_drafts_get(
    state: State<'_, AppState>,
    canonical_cwd: String,
) -> Result<DraftWorkspaceSnapshot, String> {
    let mut store = state.drafts.lock().await;
    store.workspace_snapshot(&canonical_cwd)
}

#[tauri::command]
pub async fn desktop_drafts_apply(
    state: State<'_, AppState>,
    mutations: Vec<DraftMutation>,
) -> Result<DraftApplyResult, String> {
    let mut store = state.drafts.lock().await;
    store.apply(mutations)
}

#[tauri::command]
pub async fn desktop_open_path(path: String) -> Result<(), String> {
    let target = validate_open_path(&path)?;
    open_in_file_manager(target)
}

const MAIN_WINDOW_LABEL: &str = "main";

fn require_main_webview_label(label: &str) -> Result<(), String> {
    if label != MAIN_WINDOW_LABEL {
        return Err("this command is only available to the main window".to_string());
    }
    Ok(())
}

fn require_main_webview(webview: &tauri::Webview) -> Result<(), String> {
    require_main_webview_label(webview.window().label())
}

#[tauri::command]
pub fn desktop_allow_exit(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    approved: bool,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    state
        .exit_approved
        .store(approved, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn desktop_exit(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    desktop_allow_exit(webview, state, true)?;
    app.exit(0);
    Ok(())
}

const MAX_SMALL_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SMALL_TEXT_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSmallFile {
    kind: &'static str,
    name: String,
    size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[tauri::command]
pub fn desktop_read_small_file(path: String) -> Result<DesktopSmallFile, String> {
    read_small_file(&path)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileInfo {
    name: String,
    size_bytes: u64,
    path: String,
    is_directory: bool,
}

#[tauri::command]
pub fn desktop_file_info(path: String) -> Result<DesktopFileInfo, String> {
    let resolved = validate_local_path(&path)?;
    let metadata =
        std::fs::metadata(&resolved).map_err(|e| format!("file is not accessible: {e}"))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("path is not a regular file or directory".to_string());
    }
    let name = resolved
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "file name is not valid UTF-8".to_string())?
        .to_string();
    Ok(DesktopFileInfo {
        name,
        size_bytes: metadata.len(),
        path: resolved.to_string_lossy().into_owned(),
        is_directory: metadata.is_dir(),
    })
}

fn read_small_file(raw: &str) -> Result<DesktopSmallFile, String> {
    let path = validate_local_file(raw)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("file is not accessible: {e}"))?;
    let size_bytes = metadata.len();
    if size_bytes > MAX_SMALL_IMAGE_BYTES {
        return Err(format!(
            "file exceeds the {} MiB local-read limit",
            MAX_SMALL_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read file: {e}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "file name is not valid UTF-8".to_string())?
        .to_string();

    if let Some(media_type) = sniff_image_media_type(&bytes) {
        return Ok(DesktopSmallFile {
            kind: "image",
            name,
            size_bytes,
            media_type: Some(media_type),
            data: Some(BASE64_STANDARD.encode(bytes)),
            text: None,
        });
    }

    if size_bytes > MAX_SMALL_TEXT_BYTES {
        return Err(format!(
            "text file exceeds the {} KiB local-read limit",
            MAX_SMALL_TEXT_BYTES / 1024
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())?;
    if looks_binary_text(&text) {
        return Err("binary file type is not supported".to_string());
    }
    Ok(DesktopSmallFile {
        kind: "text",
        name,
        size_bytes,
        media_type: None,
        data: None,
        text: Some(text),
    })
}

fn validate_local_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("path does not exist: {e}"))?;
    let resolved = crate::pi_host::strip_verbatim_prefix(resolved);
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) paths are not allowed".into());
    }
    std::fs::metadata(&resolved).map_err(|e| format!("file is not accessible: {e}"))?;
    Ok(resolved)
}

fn validate_local_file(raw: &str) -> Result<PathBuf, String> {
    let resolved = validate_local_path(raw)?;
    let metadata =
        std::fs::metadata(&resolved).map_err(|e| format!("file is not accessible: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    Ok(resolved)
}

fn sniff_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn looks_binary_text(text: &str) -> bool {
    text.contains('\0')
}

#[tauri::command]
pub async fn pi_host_send(state: State<'_, AppState>, line: String) -> Result<(), String> {
    let host = state.hosts.lock().await.active_manager();
    let mut host = host.lock().await;
    host.send_line(line).await
}

#[tauri::command]
pub async fn pi_host_activate(state: State<'_, AppState>, cwd: String) -> Result<String, String> {
    let settings = state.settings.lock().await;
    let (route_id, manager, created) = {
        let mut hosts = state.hosts.lock().await;
        hosts.activate_workspace(Path::new(&cwd), &settings)?
    };
    drop(settings);
    let running = if created {
        false
    } else {
        manager.lock().await.is_running()
    };
    if !running {
        crate::pi_host::start_unlocked(&manager, crate::pi_host::StartKind::Fresh).await?;
    }
    state.hosts.lock().await.set_active_route(&route_id)?;
    Ok(route_id)
}

#[tauri::command]
pub async fn pi_host_prepare_switch(
    state: State<'_, AppState>,
    cwd: String,
    active_busy: bool,
) -> Result<Option<String>, String> {
    let settings = state.settings.lock().await;
    let activation = {
        let mut hosts = state.hosts.lock().await;
        hosts.prepare_workspace_switch(Path::new(&cwd), active_busy, &settings)?
    };
    drop(settings);
    let Some(activation) = activation else {
        return Ok(None);
    };
    let running = if activation.created {
        false
    } else {
        activation.manager.lock().await.is_running()
    };
    if !running {
        crate::pi_host::start_unlocked(&activation.manager, crate::pi_host::StartKind::Fresh)
            .await?;
    }
    state
        .hosts
        .lock()
        .await
        .set_active_route(&activation.route_id)?;
    Ok(Some(activation.route_id))
}

#[tauri::command]
pub async fn pi_host_rebind_active(state: State<'_, AppState>, cwd: String) -> Result<(), String> {
    // Lock order matches the other commands: settings first, then hosts.
    let rebind = {
        let settings = state.settings.lock().await;
        let shared_host_mode = settings.settings.shared_host_mode;
        state
            .hosts
            .lock()
            .await
            .rebind_active_workspace(Path::new(&cwd), shared_host_mode)?
    };
    rebind
        .manager
        .lock()
        .await
        .set_initial_workspace_path(rebind.canonical_workspace);
    for manager in rebind.retired {
        manager.lock().await.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn pi_host_active_route(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.hosts.lock().await.active_route_id())
}

#[tauri::command]
pub async fn pi_host_replay_ready(
    state: State<'_, AppState>,
    route_id: String,
) -> Result<(), String> {
    let manager = state
        .hosts
        .lock()
        .await
        .manager_for_route(&route_id)
        .ok_or_else(|| "unknown Host route".to_string())?;
    let result = manager.lock().await.replay_ready_event().await;
    result
}

#[tauri::command]
pub async fn pi_host_restart(state: State<'_, AppState>) -> Result<(), String> {
    // Holds the host mutex only for spawn/commit, not across the ready-wait.
    let host = state.hosts.lock().await.active_manager();
    crate::pi_host::start_unlocked(&host, crate::pi_host::StartKind::ManualRestart).await
}

#[tauri::command]
pub async fn pi_host_status(state: State<'_, AppState>) -> Result<bool, String> {
    let host = state.hosts.lock().await.active_manager();
    let mut host = host.lock().await;
    Ok(host.is_running())
}

#[tauri::command]
pub async fn pi_host_activity(
    state: State<'_, AppState>,
) -> Result<Vec<crate::pi_host::HostActivitySnapshot>, String> {
    Ok(state.hosts.lock().await.activity_snapshot())
}

#[tauri::command]
pub async fn pi_host_acknowledge_terminal(
    state: State<'_, AppState>,
    cwd: String,
    session_id: String,
) -> Result<bool, String> {
    Ok(state
        .hosts
        .lock()
        .await
        .acknowledge_session_terminal(Path::new(&cwd), &session_id))
}

/// Start (or reuse) a workspace's Host in the BACKGROUND — without changing the
/// renderer's active route — and run `/telegram-connect` in it. This lets the
/// telegram bridge poll while the user stays on their last workspace.
#[tauri::command]
pub async fn pi_host_bootstrap_telegram(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<(), String> {
    let settings = state.settings.lock().await;
    let (_route_id, manager, created) = {
        let mut hosts = state.hosts.lock().await;
        hosts.activate_workspace(Path::new(&cwd), &settings)?
    };
    drop(settings);
    if created || !manager.lock().await.is_running() {
        crate::pi_host::start_unlocked(&manager, crate::pi_host::StartKind::Fresh).await?;
    }

    let mut mgr = manager.lock().await;

    // 1. system.hello → current identity (workspace preloaded via --initial-cwd).
    let hello_id = uuid::Uuid::new_v4().to_string();
    let hello = serde_json::json!({
        "protocolVersion": 1,
        "id": hello_id,
        "method": "system.hello",
        "context": {},
        "params": {
            "clientName": "piabyss",
            "clientVersion": "0.1.0",
            "protocolVersion": 1,
            "extensionDecisionPresentation": "auto",
        },
    });
    let hello_resp = mgr
        .request(hello.to_string(), Duration::from_secs(30))
        .await?;
    let hello_json: serde_json::Value =
        serde_json::from_str(&hello_resp).map_err(|e| format!("parse hello response: {e}"))?;
    if hello_json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "hello failed: {}",
            hello_json
                .get("error")
                .map(|e| e.to_string())
                .unwrap_or_default()
        ));
    }
    let result = hello_json.get("result").ok_or("hello missing result")?;
    let host_instance_id = result
        .get("hostInstanceId")
        .and_then(|v| v.as_str())
        .ok_or("hello missing hostInstanceId")?
        .to_string();
    let workspace_id = result
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .ok_or("telegram Host did not preload its workspace")?
        .to_string();
    let workspace_revision = result
        .get("workspaceRevision")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let session_id = result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("telegram Host did not preload its session")?
        .to_string();
    let session_revision = result
        .get("sessionRevision")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    // 2. agent.prompt → /telegram-connect in the dedicated telegram workspace.
    let prompt_id = uuid::Uuid::new_v4().to_string();
    let prompt = serde_json::json!({
        "protocolVersion": 1,
        "id": prompt_id,
        "method": "agent.prompt",
        "context": {
            "expectedHostInstanceId": host_instance_id,
            "expectedWorkspaceId": workspace_id,
            "expectedWorkspaceRevision": workspace_revision,
            "expectedSessionId": session_id,
            "expectedSessionRevision": session_revision,
        },
        "params": { "text": "/telegram-connect" },
    });
    let prompt_resp = mgr
        .request(prompt.to_string(), Duration::from_secs(60))
        .await?;
    let prompt_json: serde_json::Value =
        serde_json::from_str(&prompt_resp).map_err(|e| format!("parse prompt response: {e}"))?;
    if prompt_json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "/telegram-connect failed: {}",
            prompt_json
                .get("error")
                .map(|e| e.to_string())
                .unwrap_or_default()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn shell_terminal_create(
    state: State<'_, AppState>,
    cwd: String,
    cols: u16,
    rows: u16,
    profile_id: String,
    on_event: Channel<ShellTerminalEvent>,
) -> Result<ShellTerminalCreateResult, String> {
    let mut terminals = state.terminals.lock().await;
    terminals.create(&cwd, cols, rows, &profile_id, on_event)
}

#[tauri::command]
pub async fn shell_terminal_profiles() -> Result<ShellProfileCatalog, String> {
    shell_profile_catalog()
}

#[tauri::command]
pub async fn shell_terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    // A completion may wait on PTY capacity; only enqueue while holding the manager lock.
    let completion = {
        let terminals = state.terminals.lock().await;
        terminals.enqueue_write(&terminal_id, data)?
    };
    completion
        .await
        .map_err(|_| "terminal writer stopped before completing input".to_string())?
}

#[tauri::command]
pub async fn shell_terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().await;
    terminals.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub async fn shell_terminal_close(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<bool, String> {
    let mut terminals = state.terminals.lock().await;
    Ok(terminals.close(&terminal_id))
}

#[tauri::command]
pub async fn browser_surface_create(
    app: AppHandle,
    state: State<'_, AppState>,
    surface_id: String,
    url: String,
    bounds: BrowserSurfaceBounds,
    visible: bool,
) -> Result<BrowserSurfaceSnapshot, String> {
    let mut browsers = state.browsers.lock().await;
    browsers.create(&app, &surface_id, &url, bounds, visible)
}

#[tauri::command]
pub async fn browser_surface_navigate(
    state: State<'_, AppState>,
    surface_id: String,
    url: String,
) -> Result<String, String> {
    let browsers = state.browsers.lock().await;
    browsers.navigate(&surface_id, &url)
}

#[tauri::command]
pub async fn browser_surface_control(
    state: State<'_, AppState>,
    surface_id: String,
    action: String,
) -> Result<(), String> {
    let browsers = state.browsers.lock().await;
    browsers.control(&surface_id, &action)
}

#[tauri::command]
pub async fn browser_surface_set_bounds(
    state: State<'_, AppState>,
    surface_id: String,
    bounds: BrowserSurfaceBounds,
) -> Result<(), String> {
    let browsers = state.browsers.lock().await;
    browsers.set_bounds(&surface_id, bounds)
}

#[tauri::command]
pub async fn browser_surface_set_visible(
    state: State<'_, AppState>,
    surface_id: String,
    visible: bool,
) -> Result<(), String> {
    let browsers = state.browsers.lock().await;
    browsers.set_visible(&surface_id, visible)
}

#[tauri::command]
pub async fn browser_surface_focus(
    state: State<'_, AppState>,
    surface_id: String,
) -> Result<(), String> {
    let browsers = state.browsers.lock().await;
    browsers.focus(&surface_id)
}

#[tauri::command]
pub async fn browser_surface_close(
    state: State<'_, AppState>,
    surface_id: String,
) -> Result<bool, String> {
    let mut browsers = state.browsers.lock().await;
    browsers.close(&surface_id)
}

/// What the file manager should do with a validated local path.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenTarget {
    /// Reveal (select) the directory in the platform file manager.
    Directory(PathBuf),
    /// Reveal (select) the file in its parent directory.
    Reveal(PathBuf),
}

/// The webview may only point the file manager at an existing local
/// directory or file. Anything else — relative paths, UNC/network paths,
/// non-existent paths — is rejected before the path is passed as an argument
/// to the platform file manager.
pub fn validate_open_path(raw: &str) -> Result<OpenTarget, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    // Resolve symlinks/relative components; fails for non-existent paths.
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("path does not exist: {e}"))?;
    let resolved = crate::pi_host::strip_verbatim_prefix(resolved);
    // Re-check after canonicalize: a symlink may resolve to a network path
    // (\\?\UNC\... is rendered back as \\server\share by strip_verbatim_prefix).
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) paths are not allowed".into());
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("path is not accessible: {e}"))?;
    if meta.is_dir() {
        Ok(OpenTarget::Directory(resolved))
    } else if meta.is_file() {
        Ok(OpenTarget::Reveal(resolved))
    } else {
        Err("path is neither a regular file nor a directory".into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_open_args(target: &OpenTarget) -> Vec<std::ffi::OsString> {
    let path = match target {
        OpenTarget::Directory(dir) => dir,
        OpenTarget::Reveal(file) => file,
    };
    vec![
        std::ffi::OsString::from("-R"),
        path.as_os_str().to_os_string(),
    ]
}

fn open_in_file_manager(target: OpenTarget) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer.exe");
        match &target {
            OpenTarget::Directory(dir) => {
                cmd.arg(dir);
            }
            OpenTarget::Reveal(file) => {
                // `/select,` shows the file in its folder without opening/executing it.
                cmd.arg(format!("/select,{}", file.display()));
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.args(macos_open_args(&target));
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = match &target {
            OpenTarget::Directory(dir) => dir.clone(),
            OpenTarget::Reveal(file) => file
                .parent()
                .map(|p| p.to_path_buf())
                .ok_or_else(|| "file has no parent directory".to_string())?,
        };
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("piabyss-small-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn rejects_empty_and_relative_paths() {
        assert!(validate_open_path("").is_err());
        assert!(validate_open_path("   ").is_err());
        assert!(validate_open_path("relative/dir").is_err());
        assert!(validate_open_path("./here").is_err());
    }

    #[test]
    fn rejects_unc_paths() {
        assert!(validate_open_path("\\\\attacker\\share\\evil.exe").is_err());
        assert!(validate_open_path("//attacker/share/evil.exe").is_err());
    }

    #[test]
    fn rejects_nonexistent_paths() {
        assert!(validate_open_path("C:\\definitely\\not\\a\\real\\path\\x9z").is_err());
    }

    #[test]
    fn accepts_existing_directory() {
        let dir = std::env::temp_dir();
        let target = validate_open_path(dir.to_str().unwrap()).unwrap();
        assert!(matches!(target, OpenTarget::Directory(_)));
    }

    #[test]
    fn files_are_revealed_not_opened() {
        let dir = std::env::temp_dir().join("piabyss-open-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.exe");
        std::fs::write(&file, b"not really an exe").unwrap();
        let target = validate_open_path(file.to_str().unwrap()).unwrap();
        match target {
            OpenTarget::Reveal(p) => assert!(p.ends_with("sample.exe")),
            other => panic!("expected Reveal, got {other:?}"),
        }
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn macos_reveals_directories_and_files() {
        let app = PathBuf::from("/Applications/Example.app");
        assert_eq!(
            macos_open_args(&OpenTarget::Directory(app.clone())),
            vec![std::ffi::OsString::from("-R"), app.into_os_string()],
        );

        let file = PathBuf::from("/tmp/example.txt");
        assert_eq!(
            macos_open_args(&OpenTarget::Reveal(file.clone())),
            vec![std::ffi::OsString::from("-R"), file.into_os_string()],
        );
    }

    #[test]
    fn reads_small_utf8_text() {
        let path = temp_test_file("notes.txt", "hello 世界".as_bytes());
        let file = read_small_file(path.to_str().unwrap()).unwrap();
        assert_eq!(file.kind, "text");
        assert_eq!(file.name, "notes.txt");
        assert_eq!(file.text.as_deref(), Some("hello 世界"));
        assert!(file.data.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn sniffs_images_instead_of_trusting_extension() {
        let path = temp_test_file("not-an-image.txt", b"\x89PNG\r\n\x1a\nrest");
        let file = read_small_file(path.to_str().unwrap()).unwrap();
        assert_eq!(file.kind, "image");
        assert_eq!(file.media_type, Some("image/png"));
        assert!(file.data.as_deref().is_some_and(|value| !value.is_empty()));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rejects_binary_and_oversized_text() {
        let binary = temp_test_file("binary.dat", b"abc\0def");
        assert!(read_small_file(binary.to_str().unwrap()).is_err());
        let oversized = temp_test_file("large.txt", &vec![b'a'; MAX_SMALL_TEXT_BYTES as usize + 1]);
        assert!(read_small_file(oversized.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(binary.parent().unwrap());
        let _ = std::fs::remove_dir_all(oversized.parent().unwrap());
    }
}
