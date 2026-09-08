use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SETTINGS_SCHEMA_VERSION: u32 = 1;
const SETTINGS_FILE_NAME: &str = "desktop-settings.json";
const PIABYSS_DATA_DIR_NAME: &str = "piabyss";
const DEFAULT_PROJECT_DIR_NAME: &str = "DefaultProject";
const DEFAULT_CONVERSATION_MIN_WIDTH: u32 = 350;
const DEFAULT_CONVERSATION_MAX_WIDTH: u32 = 1100;
const HARD_MIN_CONVERSATION_WIDTH: u32 = 350;
const HARD_MAX_CONVERSATION_WIDTH: u32 = 2400;
const DEFAULT_CONVERSATION_FONT_SIZE: u32 = 14;
const MIN_CONVERSATION_FONT_SIZE: u32 = 12;
const MAX_CONVERSATION_FONT_SIZE: u32 = 18;
const DEFAULT_CODE_FONT_SIZE: u32 = 12;
const MIN_CODE_FONT_SIZE: u32 = 10;
const MAX_CODE_FONT_SIZE: u32 = 18;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopTheme {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopLanguage {
    System,
    En,
    Zh,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopThemeFamily {
    #[default]
    #[serde(alias = "pideck")]
    PiAbyss,
    Vercel,
    Apple,
    Transparent,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopInterfaceDensity {
    Compact,
    #[default]
    Standard,
    Comfortable,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalProfileId {
    #[default]
    Auto,
    Pwsh,
    WindowsPowershell,
    Cmd,
    GitBash,
    WslDefault,
    Zsh,
    Bash,
    Fish,
    Sh,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionDecisionPresentation {
    LegacyModal,
    #[default]
    Auto,
    InlineFirst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusySendBehavior {
    FollowUp,
    Steer,
}

fn legacy_extension_decision_presentation() -> ExtensionDecisionPresentation {
    ExtensionDecisionPresentation::LegacyModal
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopSettings {
    pub theme: DesktopTheme,
    pub theme_family: DesktopThemeFamily,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_workspace: Option<String>,
    pub restore_last_session: bool,
    pub auto_start_on_boot: bool,
    pub system_notifications_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_dir: Option<String>,
    pub auto_restart_host_once: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub busy_send_behavior: Option<BusySendBehavior>,
    #[serde(default = "legacy_extension_decision_presentation")]
    pub extension_decision_presentation: ExtensionDecisionPresentation,
    pub terminal_profile: TerminalProfileId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<DesktopLanguage>,
    pub interface_density: DesktopInterfaceDensity,
    pub conversation_min_width: u32,
    pub conversation_max_width: u32,
    pub conversation_font_size: u32,
    pub code_font_size: u32,
    pub idle_session_cache_limit: u32,
    pub idle_session_timeout_minutes: u32,
    /// Opt-in RSS-aware idle retirement for background Hosts (MiB working
    /// set). `0` disables the probe and keeps the time-based rule only.
    pub host_idle_rss_retire_mb: u32,
    /// Shared-host mode (opt-in): one Host process serves every workspace;
    /// switching rebinds the active Host in place instead of spawning a
    /// dedicated one. Saves memory at the cost of extension isolation.
    pub shared_host_mode: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub known_workspaces: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub shortcut_overrides: BTreeMap<String, Option<String>>,
    /// Plugin library configuration: plugin id → environment variable → value.
    /// Injected into the Host process environment at spawn time.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub plugin_env: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: DesktopTheme::System,
            theme_family: DesktopThemeFamily::PiAbyss,
            default_workspace: None,
            restore_last_session: true,
            auto_start_on_boot: false,
            system_notifications_enabled: true,
            last_workspace: None,
            last_session_path: None,
            agent_dir: None,
            auto_restart_host_once: true,
            busy_send_behavior: None,
            extension_decision_presentation: ExtensionDecisionPresentation::Auto,
            terminal_profile: TerminalProfileId::Auto,
            language: None,
            interface_density: DesktopInterfaceDensity::Standard,
            conversation_min_width: DEFAULT_CONVERSATION_MIN_WIDTH,
            conversation_max_width: DEFAULT_CONVERSATION_MAX_WIDTH,
            conversation_font_size: DEFAULT_CONVERSATION_FONT_SIZE,
            code_font_size: DEFAULT_CODE_FONT_SIZE,
            idle_session_cache_limit: 5,
            idle_session_timeout_minutes: 30,
            host_idle_rss_retire_mb: 0,
            shared_host_mode: false,
            known_workspaces: Vec::new(),
            shortcut_overrides: BTreeMap::new(),
            plugin_env: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    schema_version: u32,
    settings: DesktopSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsSnapshot {
    pub schema_version: u32,
    pub settings: DesktopSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_from: Option<String>,
}

pub struct DesktopSettingsStore {
    path: PathBuf,
    pub settings: DesktopSettings,
    warning: Option<String>,
    recovered_from: Option<PathBuf>,
}

/// One-shot rename of the legacy `pideck` namespace directory to `piabyss`.
/// Runs before any namespace consumer; rename is same-volume and atomic.
/// If the target already exists (partially migrated), the legacy dir is left
/// untouched so no data is overwritten.
fn migrate_legacy_namespace_dir(agent_dir: &std::path::Path) {
    let legacy = agent_dir.join("pideck");
    let current = agent_dir.join(PIABYSS_DATA_DIR_NAME);
    let legacy_is_dir = fs::metadata(&legacy).map(|m| m.is_dir()).unwrap_or(false);
    if !legacy_is_dir {
        return;
    }
    if std::fs::symlink_metadata(&current).is_ok() {
        return;
    }
    if let Err(error) = fs::rename(&legacy, &current) {
        eprintln!(
            "[piabyss] could not migrate legacy data dir {}: {error}",
            legacy.display()
        );
    }
}

impl DesktopSettingsStore {
    fn recovery_defaults() -> DesktopSettings {
        DesktopSettings {
            extension_decision_presentation: ExtensionDecisionPresentation::LegacyModal,
            ..DesktopSettings::default()
        }
    }

    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let dir = match std::env::var_os("PIABYSS_CONFIG_DIR") {
            Some(value) => {
                let path = PathBuf::from(value);
                if !path.is_absolute() {
                    return Err("PIABYSS_CONFIG_DIR must be an absolute path".into());
                }
                path
            }
            None => app.path().app_config_dir().map_err(|e| e.to_string())?,
        };
        Self::load_from_dir(&dir)
    }

    fn load_from_dir(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join(SETTINGS_FILE_NAME);
        if !path.exists() {
            return Ok(Self {
                path,
                settings: DesktopSettings::default(),
                warning: None,
                recovered_from: None,
            });
        }

        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        match Self::parse_settings(&raw) {
            Ok((settings, legacy)) => {
                let store = Self {
                    path,
                    settings,
                    warning: legacy.then(|| {
                        "Desktop settings were migrated to the current versioned format".into()
                    }),
                    recovered_from: None,
                };
                if legacy {
                    store.save()?;
                }
                Ok(store)
            }
            Err(parse_error) => {
                let recovered_from = Self::quarantine_corrupt_file(&path)?;
                let store = Self {
                    path,
                    settings: Self::recovery_defaults(),
                    warning: Some(format!(
                        "Desktop settings were corrupt and defaults were restored: {parse_error}"
                    )),
                    recovered_from: Some(recovered_from),
                };
                store.save()?;
                Ok(store)
            }
        }
    }

    fn parse_settings(raw: &str) -> Result<(DesktopSettings, bool), String> {
        let mut value: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let removed_theme_family = Self::migrate_removed_theme_family(&mut value);
        let (mut settings, legacy) = if value.get("schemaVersion").is_some()
            || value.get("settings").is_some()
        {
            let file: SettingsFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
            if file.schema_version != SETTINGS_SCHEMA_VERSION {
                return Err(format!(
                    "unsupported settings schema version {}",
                    file.schema_version
                ));
            }
            (file.settings, false)
        } else {
            let settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
            (settings, true)
        };
        settings.conversation_min_width = settings
            .conversation_min_width
            .clamp(HARD_MIN_CONVERSATION_WIDTH, HARD_MAX_CONVERSATION_WIDTH);
        settings.conversation_max_width = settings
            .conversation_max_width
            .clamp(HARD_MIN_CONVERSATION_WIDTH, HARD_MAX_CONVERSATION_WIDTH);
        if settings.conversation_max_width < settings.conversation_min_width {
            settings.conversation_max_width = settings.conversation_min_width;
        }
        settings.conversation_font_size = settings
            .conversation_font_size
            .clamp(MIN_CONVERSATION_FONT_SIZE, MAX_CONVERSATION_FONT_SIZE);
        settings.code_font_size = settings
            .code_font_size
            .clamp(MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE);
        Ok((settings, legacy || removed_theme_family))
    }

    fn migrate_removed_theme_family(value: &mut serde_json::Value) -> bool {
        let settings = if value.get("schemaVersion").is_some() || value.get("settings").is_some() {
            value.get_mut("settings")
        } else {
            Some(value)
        };
        let Some(settings) = settings.and_then(serde_json::Value::as_object_mut) else {
            return false;
        };
        if settings
            .get("themeFamily")
            .and_then(serde_json::Value::as_str)
            != Some("acrylic")
        {
            return false;
        }
        settings.insert(
            "themeFamily".to_string(),
            serde_json::Value::String("apple".to_string()),
        );
        true
    }

    fn validate_settings(settings: &DesktopSettings) -> Result<(), String> {
        if settings.conversation_min_width < HARD_MIN_CONVERSATION_WIDTH {
            return Err(format!(
                "conversationMinWidth must be at least {HARD_MIN_CONVERSATION_WIDTH}"
            ));
        }
        if settings.conversation_max_width > HARD_MAX_CONVERSATION_WIDTH {
            return Err(format!(
                "conversationMaxWidth must be at most {HARD_MAX_CONVERSATION_WIDTH}"
            ));
        }
        if settings.conversation_max_width < settings.conversation_min_width {
            return Err(
                "conversationMaxWidth must be greater than or equal to conversationMinWidth"
                    .to_string(),
            );
        }
        if !(MIN_CONVERSATION_FONT_SIZE..=MAX_CONVERSATION_FONT_SIZE)
            .contains(&settings.conversation_font_size)
        {
            return Err(format!(
                "conversationFontSize must be between {MIN_CONVERSATION_FONT_SIZE} and {MAX_CONVERSATION_FONT_SIZE}"
            ));
        }
        if !(MIN_CODE_FONT_SIZE..=MAX_CODE_FONT_SIZE).contains(&settings.code_font_size) {
            return Err(format!(
                "codeFontSize must be between {MIN_CODE_FONT_SIZE} and {MAX_CODE_FONT_SIZE}"
            ));
        }
        if !(1..=20).contains(&settings.idle_session_cache_limit) {
            return Err("idleSessionCacheLimit must be between 1 and 20".to_string());
        }
        if !(1..=24 * 60).contains(&settings.idle_session_timeout_minutes) {
            return Err("idleSessionTimeoutMinutes must be between 1 and 1440".to_string());
        }
        if settings.host_idle_rss_retire_mb > 8192 {
            return Err("hostIdleRssRetireMb must be between 0 and 8192".to_string());
        }
        for (plugin_id, vars) in &settings.plugin_env {
            if plugin_id.is_empty() || plugin_id.chars().count() > 64 {
                return Err("pluginEnv plugin ids must be 1-64 characters".to_string());
            }
            for (name, value) in vars {
                let valid_name = !name.is_empty()
                    && name.len() <= 128
                    && name
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
                if !valid_name {
                    return Err(format!("pluginEnv contains invalid env var name: {name}"));
                }
                if value.chars().count() > 8192 {
                    return Err(format!(
                        "pluginEnv value for {name} exceeds 8192 characters"
                    ));
                }
            }
        }
        Ok(())
    }

    fn quarantine_corrupt_file(path: &Path) -> Result<PathBuf, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let backup = path.with_file_name(format!("desktop-settings.corrupt-{timestamp}.json"));
        fs::rename(path, &backup).map_err(|e| {
            format!(
                "could not preserve corrupt settings at {}: {e}",
                backup.display()
            )
        })?;
        Ok(backup)
    }

    fn write_settings(&self, settings: &DesktopSettings) -> Result<(), String> {
        let raw = serde_json::to_vec_pretty(&SettingsFile {
            schema_version: SETTINGS_SCHEMA_VERSION,
            settings: settings.clone(),
        })
        .map_err(|e| e.to_string())?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "settings path has no parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temp = parent.join(format!(
            ".{SETTINGS_FILE_NAME}.{}.{}.tmp",
            std::process::id(),
            Uuid::new_v4()
        ));

        let write_result = (|| -> Result<(), String> {
            let mut file = File::create(&temp).map_err(|e| e.to_string())?;
            file.write_all(&raw).map_err(|e| e.to_string())?;
            file.write_all(b"\n").map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            replace_file(&temp, &self.path)
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        write_result
    }

    pub fn snapshot(&self) -> DesktopSettingsSnapshot {
        DesktopSettingsSnapshot {
            schema_version: SETTINGS_SCHEMA_VERSION,
            settings: self.settings.clone(),
            warning: self.warning.clone(),
            recovered_from: self
                .recovered_from
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        self.write_settings(&self.settings)
    }

    pub fn ensure_default_project_workspace(&mut self) -> Result<Option<PathBuf>, String> {
        let has_workspace = self
            .settings
            .default_workspace
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
            || self
                .settings
                .last_workspace
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty())
            || self
                .settings
                .known_workspaces
                .iter()
                .any(|path| !path.trim().is_empty());
        if has_workspace {
            return Ok(None);
        }

        let namespace_dir = self.resolved_agent_dir().join(PIABYSS_DATA_DIR_NAME);
        let project_dir = namespace_dir.join(DEFAULT_PROJECT_DIR_NAME);
        create_private_directory(&namespace_dir)?;
        create_private_directory(&project_dir)?;

        let project_path = project_dir.to_string_lossy().into_owned();
        let mut next = self.settings.clone();
        next.default_workspace = None;
        next.last_workspace = Some(project_path.clone());
        next.known_workspaces = vec![project_path];
        self.write_settings(&next)?;
        self.settings = next;
        Ok(Some(project_dir))
    }

    pub fn patch(&mut self, patch: serde_json::Value) -> Result<DesktopSettings, String> {
        let mut current = serde_json::to_value(&self.settings).map_err(|e| e.to_string())?;
        let patch_object = patch
            .as_object()
            .ok_or_else(|| "desktop settings patch must be an object".to_string())?;
        for key in patch_object.keys() {
            if !matches!(
                key.as_str(),
                "theme"
                    | "themeFamily"
                    | "defaultWorkspace"
                    | "restoreLastSession"
                    | "autoStartOnBoot"
                    | "systemNotificationsEnabled"
                    | "lastWorkspace"
                    | "lastSessionPath"
                    | "agentDir"
                    | "autoRestartHostOnce"
                    | "busySendBehavior"
                    | "extensionDecisionPresentation"
                    | "terminalProfile"
                    | "language"
                    | "interfaceDensity"
                    | "conversationMinWidth"
                    | "conversationMaxWidth"
                    | "conversationFontSize"
                    | "codeFontSize"
                    | "idleSessionCacheLimit"
                    | "idleSessionTimeoutMinutes"
                    | "hostIdleRssRetireMb"
                    | "sharedHostMode"
                    | "knownWorkspaces"
                    | "shortcutOverrides"
                    | "pluginEnv"
            ) {
                return Err(format!("unknown desktop settings field: {key}"));
            }
        }
        let current_object = current
            .as_object_mut()
            .ok_or_else(|| "desktop settings must serialize as an object".to_string())?;
        for (key, value) in patch_object {
            current_object.insert(key.clone(), value.clone());
        }
        let next = serde_json::from_value(current).map_err(|e| e.to_string())?;
        Self::validate_settings(&next)?;
        self.write_settings(&next)?;
        self.settings = next;
        Ok(self.settings.clone())
    }

    pub fn resolved_agent_dir(&self) -> PathBuf {
        let dir = if let Some(ref dir) = self.settings.agent_dir {
            PathBuf::from(dir)
        } else {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".pi")
                .join("agent")
        };
        migrate_legacy_namespace_dir(&dir);
        dir
    }
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("create directory {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("set directory permissions {}: {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("piabyss-settings-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn persists_the_language_preference_across_reloads() {
        let dir = test_dir("language");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store
            .patch(serde_json::json!({ "language": "zh" }))
            .unwrap();
        assert_eq!(store.settings.language, Some(DesktopLanguage::Zh));

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(reloaded.settings.language, Some(DesktopLanguage::Zh));

        let mut cleared = reloaded;
        cleared
            .patch(serde_json::json!({ "language": null }))
            .unwrap();
        assert_eq!(cleared.settings.language, None);
    }

    #[test]
    fn persists_system_notifications_enabled_across_reloads() {
        let dir = test_dir("system-notifications");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert!(store.settings.system_notifications_enabled);

        store
            .patch(serde_json::json!({ "systemNotificationsEnabled": false }))
            .unwrap();
        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert!(!reloaded.settings.system_notifications_enabled);

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "systemNotificationsEnabled": "yes" }))
            .is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persists_busy_send_behavior_across_reloads() {
        let dir = test_dir("busy-send-behavior");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(store.settings.busy_send_behavior, None);

        store
            .patch(serde_json::json!({ "busySendBehavior": "steer" }))
            .unwrap();
        assert_eq!(
            store.settings.busy_send_behavior,
            Some(BusySendBehavior::Steer)
        );

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.busy_send_behavior,
            Some(BusySendBehavior::Steer)
        );

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "busySendBehavior": "invalid" }))
            .is_err());
        assert_eq!(
            invalid.settings.busy_send_behavior,
            Some(BusySendBehavior::Steer)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_values_outside_the_desktop_settings_contract() {
        let dir = test_dir("contract-validation");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        let before = serde_json::to_value(&store.settings).unwrap();

        for patch in [
            serde_json::json!({ "theme": "neon" }),
            serde_json::json!({ "themeFamily": "neon" }),
            serde_json::json!({ "language": "fr" }),
            serde_json::json!({ "interfaceDensity": "dense" }),
            serde_json::json!({ "conversationFontSize": 11 }),
            serde_json::json!({ "codeFontSize": 19 }),
            serde_json::json!({ "terminalProfile": "nu" }),
            serde_json::json!({ "futureSetting": true }),
            serde_json::json!(["theme", "dark"]),
        ] {
            assert!(store.patch(patch).is_err());
            assert_eq!(serde_json::to_value(&store.settings).unwrap(), before);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_validates_and_persists_appearance_preferences() {
        let dir = test_dir("appearance-preferences");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            store.settings.interface_density,
            DesktopInterfaceDensity::Standard
        );
        assert_eq!(store.settings.theme_family, DesktopThemeFamily::PiAbyss);
        assert_eq!(
            store.settings.conversation_font_size,
            DEFAULT_CONVERSATION_FONT_SIZE
        );
        assert_eq!(store.settings.code_font_size, DEFAULT_CODE_FONT_SIZE);

        store
            .patch(serde_json::json!({
                "themeFamily": "vercel",
                "interfaceDensity": "compact",
                "conversationFontSize": 17,
                "codeFontSize": 15
            }))
            .unwrap();
        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.interface_density,
            DesktopInterfaceDensity::Compact
        );
        assert_eq!(reloaded.settings.theme_family, DesktopThemeFamily::Vercel);
        assert_eq!(reloaded.settings.conversation_font_size, 17);
        assert_eq!(reloaded.settings.code_font_size, 15);

        let mut apple = reloaded;
        apple
            .patch(serde_json::json!({ "themeFamily": "apple" }))
            .unwrap();
        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(reloaded.settings.theme_family, DesktopThemeFamily::Apple);

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "conversationFontSize": 19 }))
            .unwrap_err()
            .contains("between 12 and 18"));
        assert_eq!(invalid.settings.conversation_font_size, 17);
        assert!(invalid
            .patch(serde_json::json!({ "codeFontSize": 9 }))
            .unwrap_err()
            .contains("between 10 and 18"));
        assert_eq!(invalid.settings.code_font_size, 15);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_validates_and_persists_conversation_min_max_width() {
        let dir = test_dir("conversation-min-max-width");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            store.settings.conversation_min_width,
            DEFAULT_CONVERSATION_MIN_WIDTH
        );
        assert_eq!(
            store.settings.conversation_max_width,
            DEFAULT_CONVERSATION_MAX_WIDTH
        );

        store
            .patch(serde_json::json!({
                "conversationMinWidth": 640,
                "conversationMaxWidth": 1200
            }))
            .unwrap();
        assert_eq!(store.settings.conversation_min_width, 640);
        assert_eq!(store.settings.conversation_max_width, 1200);

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(reloaded.settings.conversation_min_width, 640);
        assert_eq!(reloaded.settings.conversation_max_width, 1200);

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "conversationMinWidth": 100 }))
            .unwrap_err()
            .contains("must be at least 350"));
        assert!(invalid
            .patch(serde_json::json!({ "conversationMaxWidth": 3000 }))
            .unwrap_err()
            .contains("must be at most 2400"));
        assert!(invalid
            .patch(serde_json::json!({
                "conversationMinWidth": 1200,
                "conversationMaxWidth": 800
            }))
            .unwrap_err()
            .contains("greater than or equal"));
        assert_eq!(invalid.settings.conversation_min_width, 640);
        assert_eq!(invalid.settings.conversation_max_width, 1200);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validates_and_persists_shortcut_overrides() {
        let dir = test_dir("shortcut-overrides");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store
            .patch(serde_json::json!({
                "shortcutOverrides": {
                    "session.new": "mod+shift+n",
                    "chat.stop": null
                }
            }))
            .unwrap();
        assert_eq!(
            store
                .settings
                .shortcut_overrides
                .get("session.new")
                .and_then(|value| value.as_deref()),
            Some("mod+shift+n")
        );
        assert_eq!(
            store.settings.shortcut_overrides.get("chat.stop"),
            Some(&None)
        );

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.shortcut_overrides,
            store.settings.shortcut_overrides
        );

        let before = reloaded.settings.shortcut_overrides.clone();
        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({
                "shortcutOverrides": { "session.new": 42 }
            }))
            .is_err());
        assert_eq!(invalid.settings.shortcut_overrides, before);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_validates_and_persists_host_idle_rss_retire_mb() {
        let dir = test_dir("host-idle-rss-retire");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        // Disabled by default: the probe must never retire hosts unexpectedly.
        assert_eq!(store.settings.host_idle_rss_retire_mb, 0);

        store
            .patch(serde_json::json!({ "hostIdleRssRetireMb": 512 }))
            .unwrap();
        assert_eq!(store.settings.host_idle_rss_retire_mb, 512);

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(reloaded.settings.host_idle_rss_retire_mb, 512);

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "hostIdleRssRetireMb": 8193 }))
            .is_err());
        assert!(invalid
            .patch(serde_json::json!({ "hostIdleRssRetireMb": -1 }))
            .is_err());
        assert_eq!(invalid.settings.host_idle_rss_retire_mb, 512);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_and_persists_shared_host_mode() {
        let dir = test_dir("shared-host-mode");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        // Disabled by default: the dedicated-Host pool behavior is unchanged.
        assert!(!store.settings.shared_host_mode);

        store
            .patch(serde_json::json!({ "sharedHostMode": true }))
            .unwrap();
        assert!(store.settings.shared_host_mode);

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert!(reloaded.settings.shared_host_mode);

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({ "sharedHostMode": "yes" }))
            .is_err());
        assert!(invalid.settings.shared_host_mode);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn defaults_and_persists_extension_decision_presentation() {
        let dir = test_dir("extension-decision-presentation");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            store.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::Auto
        );

        store
            .patch(serde_json::json!({
                "extensionDecisionPresentation": "inline-first"
            }))
            .unwrap();
        assert_eq!(
            store.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::InlineFirst
        );

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::InlineFirst
        );

        let mut invalid = reloaded;
        assert!(invalid
            .patch(serde_json::json!({
                "extensionDecisionPresentation": "automatic"
            }))
            .is_err());
        assert_eq!(
            invalid.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::InlineFirst
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_versioned_settings_atomically_and_round_trips() {
        let dir = test_dir("roundtrip");
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store
            .patch(serde_json::json!({ "theme": "dark", "lastWorkspace": "C:\\repo" }))
            .unwrap();

        let raw = fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(value["settings"]["theme"], "dark");
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, DesktopTheme::Dark);
        assert_eq!(loaded.settings.last_workspace.as_deref(), Some("C:\\repo"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_legacy_unversioned_settings() {
        let dir = test_dir("legacy");
        fs::write(
            dir.join(SETTINGS_FILE_NAME),
            r#"{"theme":"light","restoreLastSession":false}"#,
        )
        .unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme, DesktopTheme::Light);
        assert_eq!(loaded.settings.theme_family, DesktopThemeFamily::PiAbyss);
        assert!(!loaded.settings.restore_last_session);
        assert_eq!(
            loaded.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::LegacyModal
        );
        assert!(loaded.snapshot().warning.is_some());
        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(migrated["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_removed_acrylic_theme_family_to_apple() {
        let dir = test_dir("removed-acrylic-theme");
        fs::write(
            dir.join(SETTINGS_FILE_NAME),
            r#"{"theme":"light","themeFamily":"acrylic"}"#,
        )
        .unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(loaded.settings.theme_family, DesktopThemeFamily::Apple);
        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(migrated["settings"]["themeFamily"], "apple");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quarantines_corrupt_settings_and_surfaces_recovery() {
        let dir = test_dir("corrupt");
        fs::write(dir.join(SETTINGS_FILE_NAME), b"{not-json").unwrap();

        let loaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        let snapshot = loaded.snapshot();
        assert_eq!(loaded.settings.theme, DesktopTheme::System);
        assert_eq!(
            loaded.settings.extension_decision_presentation,
            ExtensionDecisionPresentation::LegacyModal
        );
        assert!(snapshot.warning.unwrap().contains("corrupt"));
        let backup = PathBuf::from(snapshot.recovered_from.unwrap());
        assert!(backup.exists());
        assert_eq!(fs::read_to_string(backup).unwrap(), "{not-json");
        let replacement: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(replacement["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn initializes_and_persists_the_default_project_workspace() {
        let dir = test_dir("default-project");
        let agent_dir = dir.join("agent");
        let project_dir = agent_dir.join("piabyss").join("DefaultProject");
        let project_path = project_dir.to_string_lossy().into_owned();
        let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        store.settings.agent_dir = Some(agent_dir.to_string_lossy().into_owned());

        assert_eq!(
            store.ensure_default_project_workspace().unwrap(),
            Some(project_dir.clone())
        );
        assert!(project_dir.is_dir());
        assert_eq!(store.settings.default_workspace, None);
        assert_eq!(
            store.settings.last_workspace.as_deref(),
            Some(project_path.as_str())
        );
        assert_eq!(store.settings.known_workspaces, vec![project_path.clone()]);

        #[cfg(unix)]
        {
            let namespace_mode = fs::metadata(agent_dir.join("piabyss"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let project_mode = fs::metadata(&project_dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(namespace_mode, 0o700);
            assert_eq!(project_mode, 0o700);
        }

        assert_eq!(store.ensure_default_project_workspace().unwrap(), None);
        assert_eq!(store.settings.known_workspaces, vec![project_path.clone()]);

        let reloaded = DesktopSettingsStore::load_from_dir(&dir).unwrap();
        assert_eq!(
            reloaded.settings.last_workspace.as_deref(),
            Some(project_path.as_str())
        );
        assert_eq!(reloaded.settings.known_workspaces, vec![project_path]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preserves_every_form_of_existing_workspace_configuration() {
        let cases = [
            DesktopSettings {
                default_workspace: Some("/projects/default".into()),
                ..DesktopSettings::default()
            },
            DesktopSettings {
                last_workspace: Some("/projects/recent".into()),
                ..DesktopSettings::default()
            },
            DesktopSettings {
                known_workspaces: vec!["/projects/known".into()],
                ..DesktopSettings::default()
            },
        ];

        for (index, settings) in cases.into_iter().enumerate() {
            let dir = test_dir(&format!("existing-workspace-{index}"));
            let agent_dir = dir.join("agent");
            let mut store = DesktopSettingsStore::load_from_dir(&dir).unwrap();
            store.settings = DesktopSettings {
                agent_dir: Some(agent_dir.to_string_lossy().into_owned()),
                ..settings
            };
            let before = serde_json::to_value(&store.settings).unwrap();

            assert_eq!(store.ensure_default_project_workspace().unwrap(), None);
            assert_eq!(serde_json::to_value(&store.settings).unwrap(), before);
            assert!(!agent_dir.join("piabyss").join("DefaultProject").exists());
            fs::remove_dir_all(dir).unwrap();
        }
    }
}
