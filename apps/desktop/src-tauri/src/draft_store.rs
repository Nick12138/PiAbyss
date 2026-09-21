use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DRAFT_SCHEMA_VERSION: u32 = 2;
const DRAFT_FILE_NAME: &str = "drafts.json";
const MAX_DRAFT_TEXT_BYTES: usize = 1024 * 1024;
const MAX_DRAFT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DRAFT_RECORDS: usize = 1_000;
const MAX_DRAFT_MUTATIONS: usize = 128;
const MAX_SESSION_ID_BYTES: usize = 256;
const MAX_DRAFT_ATTACHMENTS: usize = 32;
const MAX_DRAFT_REFERENCES: usize = 16;
const MAX_DRAFT_ATTACHMENT_ITEM_BYTES: usize = 4 * 1024 * 1024;
const MAX_DRAFT_ATTACHMENTS_BYTES: usize = 8 * 1024 * 1024;
const MAX_DRAFT_REFERENCE_LABEL_BYTES: usize = 512;
const MAX_DRAFT_REFERENCE_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DraftKind {
    Session,
    NewConversation,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTarget {
    pub kind: DraftKind,
    pub canonical_cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// A restorable composer attachment persisted alongside the draft text.
///
/// Path-backed entries only keep the absolute source path so restore can
/// re-read (or re-upload) them; content-backed entries keep the payload and
/// are individually size-capped in `validate_attachments`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DraftAttachmentRecord {
    Image {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<String>,
    },
    File {
        id: String,
        name: String,
        size: u64,
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_directory: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unlimited: Option<bool>,
    },
    Document {
        source_path: String,
    },
    PastedText {
        text: String,
    },
}

/// An injected prompt reference (e.g. memo capsule) persisted with the draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftReferenceRecord {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub payload: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecord {
    pub kind: DraftKind,
    pub canonical_cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<DraftAttachmentRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<DraftReferenceRecord>,
    pub updated_at: u64,
}

impl DraftRecord {
    fn target(&self) -> DraftTarget {
        DraftTarget {
            kind: self.kind,
            canonical_cwd: self.canonical_cwd.clone(),
            session_id: self.session_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftFile {
    schema_version: u32,
    drafts: Vec<DraftRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum DraftMutation {
    /// Full-state upsert: replaces the record's text, attachments, and
    /// references together. An upsert whose payload is entirely empty deletes
    /// the target instead.
    Upsert {
        target: DraftTarget,
        text: String,
        #[serde(default)]
        attachments: Vec<DraftAttachmentRecord>,
        #[serde(default)]
        references: Vec<DraftReferenceRecord>,
    },
    Delete {
        target: DraftTarget,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftWorkspaceSnapshot {
    pub schema_version: u32,
    pub drafts: Vec<DraftRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_from: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftApplyResult {
    pub applied: usize,
}

pub struct DraftStore {
    path: Option<PathBuf>,
    drafts: Vec<DraftRecord>,
    read_only: bool,
    warning: Option<String>,
    recovered_from: Option<PathBuf>,
}

enum ParsedDraftFile {
    Current(Vec<DraftRecord>),
    Unsupported(u64),
}

impl DraftStore {
    pub fn load(app: &AppHandle) -> Self {
        let dir = match std::env::var_os("PIABYSS_CONFIG_DIR") {
            Some(value) => {
                let path = PathBuf::from(value);
                if !path.is_absolute() {
                    return Self::disabled("PIABYSS_CONFIG_DIR must be an absolute path".into());
                }
                path
            }
            None => match app.path().app_config_dir() {
                Ok(path) => path,
                Err(error) => return Self::disabled(error.to_string()),
            },
        };

        Self::load_from_dir(&dir).unwrap_or_else(Self::disabled)
    }

    fn disabled(error: String) -> Self {
        Self {
            path: None,
            drafts: Vec::new(),
            read_only: true,
            warning: Some(format!(
                "Draft persistence is unavailable; drafts will remain in memory only: {error}"
            )),
            recovered_from: None,
        }
    }

    fn load_from_dir(dir: &Path) -> Result<Self, String> {
        create_private_directory(dir)?;
        let path = dir.join(DRAFT_FILE_NAME);
        if !path.exists() {
            return Ok(Self {
                path: Some(path),
                drafts: Vec::new(),
                read_only: false,
                warning: None,
                recovered_from: None,
            });
        }

        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        let parsed = if metadata.len() > MAX_DRAFT_FILE_BYTES {
            Err(format!(
                "draft file exceeds the {} MiB limit",
                MAX_DRAFT_FILE_BYTES / 1024 / 1024
            ))
        } else {
            let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            Self::parse_file(&raw)
        };

        match parsed {
            Ok(ParsedDraftFile::Current(drafts)) => Ok(Self {
                path: Some(path),
                drafts,
                read_only: false,
                warning: None,
                recovered_from: None,
            }),
            Ok(ParsedDraftFile::Unsupported(version)) => Ok(Self {
                path: Some(path),
                drafts: Vec::new(),
                read_only: true,
                warning: Some(format!(
                    "Drafts were created by a newer PiAbyss schema ({version}) and were left unchanged"
                )),
                recovered_from: None,
            }),
            Err(parse_error) => {
                let recovered_from = Self::quarantine_corrupt_file(&path)?;
                Ok(Self {
                    path: Some(path),
                    drafts: Vec::new(),
                    read_only: false,
                    warning: Some(format!(
                        "Saved drafts were corrupt and an empty draft store was restored: {parse_error}"
                    )),
                    recovered_from: Some(recovered_from),
                })
            }
        }
    }

    fn parse_file(raw: &str) -> Result<ParsedDraftFile, String> {
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let version = value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "draft file is missing a numeric schemaVersion".to_string())?;
        if version > u64::from(DRAFT_SCHEMA_VERSION) {
            return Ok(ParsedDraftFile::Unsupported(version));
        }
        if version < 1 {
            return Err(format!("unsupported draft schema version {version}"));
        }
        // Versions 1..=2 share the record shape: v1 records simply lack the
        // attachments/references fields, which default to empty via serde.

        let file: DraftFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if file.drafts.len() > MAX_DRAFT_RECORDS {
            return Err(format!(
                "draft file contains more than {MAX_DRAFT_RECORDS} records"
            ));
        }
        let mut keys = HashSet::with_capacity(file.drafts.len());
        for record in &file.drafts {
            let target = record.target();
            validate_target(&target)?;
            validate_text(&record.text)?;
            validate_attachments(&record.attachments)?;
            validate_references(&record.references)?;
            if is_empty_record(&record.text, &record.attachments, &record.references) {
                return Err("draft file contains an empty draft record".into());
            }
            if !keys.insert(target) {
                return Err("draft file contains duplicate draft targets".into());
            }
        }
        Ok(ParsedDraftFile::Current(file.drafts))
    }

    fn quarantine_corrupt_file(path: &Path) -> Result<PathBuf, String> {
        let timestamp = now_millis()?;
        let backup = path.with_file_name(format!("drafts.corrupt-{timestamp}.json"));
        fs::rename(path, &backup).map_err(|error| {
            format!(
                "could not preserve corrupt drafts at {}: {error}",
                backup.display()
            )
        })?;
        Ok(backup)
    }

    pub fn workspace_snapshot(
        &mut self,
        canonical_cwd: &str,
    ) -> Result<DraftWorkspaceSnapshot, String> {
        validate_canonical_cwd(canonical_cwd)?;
        let mut drafts: Vec<_> = self
            .drafts
            .iter()
            .filter(|draft| draft.canonical_cwd == canonical_cwd)
            .cloned()
            .collect();
        sort_records(&mut drafts);
        Ok(DraftWorkspaceSnapshot {
            schema_version: DRAFT_SCHEMA_VERSION,
            drafts,
            warning: self.warning.take(),
            recovered_from: self
                .recovered_from
                .take()
                .map(|path| path.to_string_lossy().into_owned()),
        })
    }

    pub fn apply(&mut self, mutations: Vec<DraftMutation>) -> Result<DraftApplyResult, String> {
        if self.read_only {
            return Err("draft persistence is read-only or unavailable".into());
        }
        if mutations.len() > MAX_DRAFT_MUTATIONS {
            return Err(format!(
                "draft mutation batch exceeds the {MAX_DRAFT_MUTATIONS} item limit"
            ));
        }
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| "draft persistence path is unavailable".to_string())?;
        let mut next = self.drafts.clone();
        let mut applied = 0;

        for mutation in mutations {
            match mutation {
                DraftMutation::Upsert {
                    target,
                    text,
                    attachments,
                    references,
                } => {
                    validate_target(&target)?;
                    validate_text(&text)?;
                    validate_attachments(&attachments)?;
                    validate_references(&references)?;
                    if is_empty_record(&text, &attachments, &references) {
                        if remove_target(&mut next, &target) {
                            applied += 1;
                        }
                        continue;
                    }
                    match next.iter_mut().find(|record| record.target() == target) {
                        Some(record)
                            if record.is_same_payload(&text, &attachments, &references) => {}
                        Some(record) => {
                            record.text = text;
                            record.attachments = attachments;
                            record.references = references;
                            record.updated_at = now_millis()?;
                            applied += 1;
                        }
                        None => {
                            next.push(DraftRecord {
                                kind: target.kind,
                                canonical_cwd: target.canonical_cwd,
                                session_id: target.session_id,
                                text,
                                attachments,
                                references,
                                updated_at: now_millis()?,
                            });
                            applied += 1;
                        }
                    }
                }
                DraftMutation::Delete { target } => {
                    validate_target(&target)?;
                    if remove_target(&mut next, &target) {
                        applied += 1;
                    }
                }
            }
        }

        if next.len() > MAX_DRAFT_RECORDS {
            return Err(format!(
                "draft store exceeds the {MAX_DRAFT_RECORDS} record limit"
            ));
        }
        if applied == 0 {
            return Ok(DraftApplyResult { applied });
        }
        sort_records(&mut next);
        write_file(path, &next)?;
        self.drafts = next;
        Ok(DraftApplyResult { applied })
    }
}

fn validate_canonical_cwd(canonical_cwd: &str) -> Result<(), String> {
    if canonical_cwd.trim().is_empty() {
        return Err("canonicalCwd must not be empty".into());
    }
    if !Path::new(canonical_cwd).is_absolute() {
        return Err("canonicalCwd must be an absolute path".into());
    }
    Ok(())
}

fn validate_target(target: &DraftTarget) -> Result<(), String> {
    validate_canonical_cwd(&target.canonical_cwd)?;
    match target.kind {
        DraftKind::Session => {
            let session_id = target
                .session_id
                .as_deref()
                .ok_or_else(|| "Session draft target requires sessionId".to_string())?;
            if session_id.trim().is_empty() || session_id.len() > MAX_SESSION_ID_BYTES {
                return Err(format!(
                    "sessionId must contain 1 to {MAX_SESSION_ID_BYTES} bytes"
                ));
            }
        }
        DraftKind::NewConversation if target.session_id.is_some() => {
            return Err("New-conversation draft target must not include sessionId".into());
        }
        DraftKind::NewConversation => {}
    }
    Ok(())
}

fn is_empty_record(
    text: &str,
    attachments: &[DraftAttachmentRecord],
    references: &[DraftReferenceRecord],
) -> bool {
    text.trim().is_empty() && attachments.is_empty() && references.is_empty()
}

impl DraftRecord {
    fn is_same_payload(
        &self,
        text: &str,
        attachments: &[DraftAttachmentRecord],
        references: &[DraftReferenceRecord],
    ) -> bool {
        self.text == text && self.attachments == attachments && self.references == references
    }
}

fn validate_attachments(attachments: &[DraftAttachmentRecord]) -> Result<(), String> {
    if attachments.len() > MAX_DRAFT_ATTACHMENTS {
        return Err(format!(
            "draft record contains more than {MAX_DRAFT_ATTACHMENTS} attachments"
        ));
    }
    let mut total_bytes = 0usize;
    for attachment in attachments {
        let payload_bytes = match attachment {
            DraftAttachmentRecord::Image {
                id,
                name,
                source_path,
                media_type,
                data,
            } => {
                validate_attachment_id(id)?;
                validate_optional_path(source_path)?;
                validate_optional_capped(name, MAX_DRAFT_REFERENCE_LABEL_BYTES, "image name")?;
                validate_optional_capped(media_type, 256, "image media type")?;
                if source_path.is_none() && data.is_none() {
                    return Err("image attachment has neither sourcePath nor data".into());
                }
                data.as_deref().map_or(0, str::len)
            }
            DraftAttachmentRecord::File {
                id,
                name,
                kind,
                text,
                source_path,
                ..
            } => {
                validate_attachment_id(id)?;
                if kind != "text" && kind != "path" {
                    return Err(format!("unknown file attachment kind {kind}"));
                }
                if name.trim().is_empty() {
                    return Err("file attachment has an empty name".into());
                }
                validate_optional_path(source_path)?;
                if kind == "text" && source_path.is_none() && text.is_none() {
                    return Err("text file attachment has neither sourcePath nor text".into());
                }
                text.as_deref().map_or(0, str::len)
            }
            DraftAttachmentRecord::Document { source_path } => {
                validate_required_path(source_path)?;
                0
            }
            DraftAttachmentRecord::PastedText { text } => {
                if text.is_empty() {
                    return Err("pasted-text attachment has empty text".into());
                }
                text.len()
            }
        };
        if payload_bytes > MAX_DRAFT_ATTACHMENT_ITEM_BYTES {
            return Err(format!(
                "draft attachment exceeds the {} MiB per-item limit",
                MAX_DRAFT_ATTACHMENT_ITEM_BYTES / 1024 / 1024
            ));
        }
        total_bytes += payload_bytes;
    }
    if total_bytes > MAX_DRAFT_ATTACHMENTS_BYTES {
        return Err(format!(
            "draft attachments exceed the {} MiB total limit",
            MAX_DRAFT_ATTACHMENTS_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn validate_references(references: &[DraftReferenceRecord]) -> Result<(), String> {
    if references.len() > MAX_DRAFT_REFERENCES {
        return Err(format!(
            "draft record contains more than {MAX_DRAFT_REFERENCES} references"
        ));
    }
    for reference in references {
        validate_optional_capped(
            &Some(reference.id.clone()),
            MAX_DRAFT_REFERENCE_ID_BYTES,
            "reference id",
        )?;
        if reference.kind.trim().is_empty() || reference.kind.len() > 64 {
            return Err("draft reference has an invalid kind".into());
        }
        if reference.label.trim().is_empty()
            || reference.label.len() > MAX_DRAFT_REFERENCE_LABEL_BYTES
        {
            return Err("draft reference has an invalid label".into());
        }
        if reference.payload.is_empty() || reference.payload.len() > MAX_DRAFT_TEXT_BYTES {
            return Err("draft reference has an invalid payload".into());
        }
    }
    Ok(())
}

fn validate_attachment_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > MAX_DRAFT_REFERENCE_ID_BYTES {
        return Err("attachment id must contain 1 to 128 bytes".into());
    }
    Ok(())
}

fn validate_optional_path(path: &Option<String>) -> Result<(), String> {
    if let Some(path) = path {
        validate_required_path(path)?;
    }
    Ok(())
}

fn validate_required_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.len() > MAX_SESSION_ID_BYTES * 4 {
        return Err("attachment sourcePath must contain 1 to 1024 bytes".into());
    }
    Ok(())
}

fn validate_optional_capped(
    value: &Option<String>,
    max_bytes: usize,
    field: &str,
) -> Result<(), String> {
    if let Some(value) = value {
        if value.len() > max_bytes {
            return Err(format!("{field} exceeds the {max_bytes} byte limit"));
        }
    }
    Ok(())
}

fn validate_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_DRAFT_TEXT_BYTES {
        return Err(format!(
            "draft text exceeds the {} MiB limit",
            MAX_DRAFT_TEXT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn remove_target(records: &mut Vec<DraftRecord>, target: &DraftTarget) -> bool {
    let original_len = records.len();
    records.retain(|record| record.target() != *target);
    records.len() != original_len
}

fn sort_records(records: &mut [DraftRecord]) {
    records.sort_by(|left, right| {
        left.canonical_cwd
            .cmp(&right.canonical_cwd)
            .then_with(|| draft_kind_rank(left.kind).cmp(&draft_kind_rank(right.kind)))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
}

fn draft_kind_rank(kind: DraftKind) -> u8 {
    match kind {
        DraftKind::NewConversation => 0,
        DraftKind::Session => 1,
    }
}

fn write_file(path: &Path, drafts: &[DraftRecord]) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(&DraftFile {
        schema_version: DRAFT_SCHEMA_VERSION,
        drafts: drafts.to_vec(),
    })
    .map_err(|error| error.to_string())?;
    if raw.len() as u64 > MAX_DRAFT_FILE_BYTES {
        return Err(format!(
            "draft file exceeds the {} MiB limit",
            MAX_DRAFT_FILE_BYTES / 1024 / 1024
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "draft file path has no parent directory".to_string())?;
    create_private_directory(parent)?;
    let temp = parent.join(format!(
        ".{DRAFT_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ));

    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file: File = options.open(&temp).map_err(|error| error.to_string())?;
        file.write_all(&raw).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        replace_file(&temp, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
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

fn now_millis() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system time is outside the supported range".into())
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
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("piabyss-drafts-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn workspace_cwd(dir: &Path, name: &str) -> String {
        dir.join(name).to_string_lossy().into_owned()
    }

    fn session_target(cwd: &str, session_id: &str) -> DraftTarget {
        DraftTarget {
            kind: DraftKind::Session,
            canonical_cwd: cwd.into(),
            session_id: Some(session_id.into()),
        }
    }

    fn new_target(cwd: &str) -> DraftTarget {
        DraftTarget {
            kind: DraftKind::NewConversation,
            canonical_cwd: cwd.into(),
            session_id: None,
        }
    }

    fn upsert(target: DraftTarget, text: &str) -> DraftMutation {
        DraftMutation::Upsert {
            target,
            text: text.into(),
            attachments: Vec::new(),
            references: Vec::new(),
        }
    }

    fn upsert_full(
        target: DraftTarget,
        text: &str,
        attachments: Vec<DraftAttachmentRecord>,
        references: Vec<DraftReferenceRecord>,
    ) -> DraftMutation {
        DraftMutation::Upsert {
            target,
            text: text.into(),
            attachments,
            references,
        }
    }

    #[test]
    fn writes_round_trips_and_filters_by_workspace() {
        let dir = test_dir("roundtrip");
        let repo_a = workspace_cwd(&dir, "repo-a");
        let repo_b = workspace_cwd(&dir, "repo-b");
        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        let result = store
            .apply(vec![
                upsert(new_target(&repo_a), "new A"),
                upsert(session_target(&repo_a, "s1"), "session A"),
                upsert(session_target(&repo_b, "s2"), "session B"),
            ])
            .unwrap();
        assert_eq!(result.applied, 3);

        let raw = fs::read_to_string(dir.join(DRAFT_FILE_NAME)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schemaVersion"], DRAFT_SCHEMA_VERSION);
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

        let mut reloaded = DraftStore::load_from_dir(&dir).unwrap();
        let snapshot = reloaded.workspace_snapshot(&repo_a).unwrap();
        assert_eq!(snapshot.drafts.len(), 2);
        assert_eq!(snapshot.drafts[0].kind, DraftKind::NewConversation);
        assert_eq!(snapshot.drafts[1].session_id.as_deref(), Some("s1"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn coalesces_identical_upserts_and_deletes_empty_or_explicit_targets() {
        let dir = test_dir("mutations");
        let cwd = workspace_cwd(&dir, "repo");
        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        let target = session_target(&cwd, "s1");
        assert_eq!(
            store
                .apply(vec![upsert(target.clone(), "draft")])
                .unwrap()
                .applied,
            1
        );
        assert_eq!(
            store
                .apply(vec![upsert(target.clone(), "draft")])
                .unwrap()
                .applied,
            0
        );
        assert_eq!(
            store
                .apply(vec![upsert(target.clone(), "   ")])
                .unwrap()
                .applied,
            1
        );
        assert!(store.workspace_snapshot(&cwd).unwrap().drafts.is_empty());

        store.apply(vec![upsert(target.clone(), "again")]).unwrap();
        assert_eq!(
            store
                .apply(vec![DraftMutation::Delete { target }])
                .unwrap()
                .applied,
            1
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quarantines_corrupt_data_and_surfaces_one_warning() {
        let dir = test_dir("corrupt");
        let cwd = workspace_cwd(&dir, "repo");
        fs::write(dir.join(DRAFT_FILE_NAME), b"{not-json").unwrap();

        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        let first = store.workspace_snapshot(&cwd).unwrap();
        assert!(first.warning.is_some());
        let backup = first.recovered_from.expect("corrupt backup path");
        assert!(Path::new(&backup).exists());
        assert!(store.workspace_snapshot(&cwd).unwrap().warning.is_none());
        store
            .apply(vec![upsert(new_target(&cwd), "recovered")])
            .unwrap();
        assert!(dir.join(DRAFT_FILE_NAME).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preserves_unknown_newer_schema_read_only() {
        let dir = test_dir("newer");
        let cwd = workspace_cwd(&dir, "repo");
        let path = dir.join(DRAFT_FILE_NAME);
        let original = r#"{"schemaVersion":3,"drafts":[{"future":true}]}"#;
        fs::write(&path, original).unwrap();

        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        assert!(store.workspace_snapshot(&cwd).unwrap().warning.is_some());
        assert!(store
            .apply(vec![upsert(new_target(&cwd), "no overwrite")])
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validates_target_shape_and_text_limit_before_writing() {
        let dir = test_dir("validation");
        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        assert!(store
            .apply(vec![upsert(
                DraftTarget {
                    kind: DraftKind::Session,
                    canonical_cwd: "/repo".into(),
                    session_id: None,
                },
                "draft",
            )])
            .is_err());
        assert!(store
            .apply(vec![upsert(
                new_target("/repo"),
                &"x".repeat(MAX_DRAFT_TEXT_BYTES + 1),
            )])
            .is_err());
        assert!(!dir.join(DRAFT_FILE_NAME).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    fn image_attachment(data: &str) -> DraftAttachmentRecord {
        DraftAttachmentRecord::Image {
            id: "img-1".into(),
            name: Some("shot.png".into()),
            source_path: None,
            media_type: Some("image/png".into()),
            data: Some(data.into()),
        }
    }

    fn memo_reference() -> DraftReferenceRecord {
        DraftReferenceRecord {
            id: "memo-1".into(),
            kind: "memo".into(),
            label: "待办".into(),
            payload: "<piabyss-memo>payload</piabyss-memo>".into(),
        }
    }

    #[test]
    fn round_trips_attachments_and_references_with_text() {
        let dir = test_dir("attachments");
        let cwd = workspace_cwd(&dir, "repo");
        let target = session_target(&cwd, "s1");
        let attachments = vec![
            image_attachment("aGVsbG8="),
            DraftAttachmentRecord::Document {
                source_path: "/repo/report.pdf".into(),
            },
        ];
        let references = vec![memo_reference()];
        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        store
            .apply(vec![upsert_full(
                target.clone(),
                "explain the report",
                attachments.clone(),
                references.clone(),
            )])
            .unwrap();

        let mut reloaded = DraftStore::load_from_dir(&dir).unwrap();
        let snapshot = reloaded.workspace_snapshot(&cwd).unwrap();
        assert_eq!(snapshot.drafts.len(), 1);
        assert_eq!(snapshot.drafts[0].attachments, attachments);
        assert_eq!(snapshot.drafts[0].references, references);

        // Sending clears text/attachments/references in one upsert → delete.
        reloaded
            .apply(vec![upsert_full(target, "", Vec::new(), Vec::new())])
            .unwrap();
        assert!(reloaded.workspace_snapshot(&cwd).unwrap().drafts.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_record_alive_on_attachments_or_references_alone() {
        let dir = test_dir("attachments-only");
        let cwd = workspace_cwd(&dir, "repo");
        let target = session_target(&cwd, "s1");
        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        store
            .apply(vec![upsert_full(
                target.clone(),
                "",
                vec![DraftAttachmentRecord::Document {
                    source_path: "/repo/a.pdf".into(),
                }],
                Vec::new(),
            )])
            .unwrap();
        assert_eq!(store.workspace_snapshot(&cwd).unwrap().drafts.len(), 1);
        store
            .apply(vec![upsert_full(
                target.clone(),
                "",
                Vec::new(),
                vec![memo_reference()],
            )])
            .unwrap();
        assert_eq!(store.workspace_snapshot(&cwd).unwrap().drafts.len(), 1);

        // Empty upsert (no text, no attachments, no references) deletes.
        store
            .apply(vec![upsert_full(target, "", Vec::new(), Vec::new())])
            .unwrap();
        assert!(store.workspace_snapshot(&cwd).unwrap().drafts.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_v1_records_and_upgrades_on_next_write() {
        let dir = test_dir("v1");
        let cwd = workspace_cwd(&dir, "repo");
        let path = dir.join(DRAFT_FILE_NAME);
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "drafts": [{
                "kind": "session",
                "canonicalCwd": cwd,
                "sessionId": "s1",
                "text": "legacy draft",
                "updatedAt": 123
            }]
        });
        fs::write(&path, serde_json::to_string(&legacy).unwrap()).unwrap();

        let mut store = DraftStore::load_from_dir(&dir).unwrap();
        let snapshot = store.workspace_snapshot(&cwd).unwrap();
        assert!(snapshot.warning.is_none());
        assert_eq!(snapshot.drafts.len(), 1);
        assert_eq!(snapshot.drafts[0].text, "legacy draft");
        assert!(snapshot.drafts[0].attachments.is_empty());

        store
            .apply(vec![upsert_full(
                session_target(&cwd, "s1"),
                "legacy draft",
                vec![image_attachment("aGVsbG8=")],
                Vec::new(),
            )])
            .unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schemaVersion"], DRAFT_SCHEMA_VERSION);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validates_attachments_and_references_before_writing() {
        let dir = test_dir("attachment-validation");
        let cwd = workspace_cwd(&dir, "repo");
        let target = session_target(&cwd, "s1");
        let mut store = DraftStore::load_from_dir(&dir).unwrap();

        // Oversized image data.
        let oversized = vec![image_attachment(
            &"x".repeat(MAX_DRAFT_ATTACHMENT_ITEM_BYTES + 1),
        )];
        assert!(store
            .apply(vec![upsert_full(
                target.clone(),
                "t",
                oversized,
                Vec::new()
            )])
            .is_err());

        // Image with neither sourcePath nor data.
        let hollow = vec![DraftAttachmentRecord::Image {
            id: "img".into(),
            name: None,
            source_path: None,
            media_type: None,
            data: None,
        }];
        assert!(store
            .apply(vec![upsert_full(target.clone(), "t", hollow, Vec::new())])
            .is_err());

        // Unknown file kind.
        let bad_kind = vec![DraftAttachmentRecord::File {
            id: "f1".into(),
            name: "a.bin".into(),
            size: 1,
            kind: "blob".into(),
            text: None,
            source_path: None,
            is_directory: None,
            unlimited: None,
        }];
        assert!(store
            .apply(vec![upsert_full(target.clone(), "t", bad_kind, Vec::new())])
            .is_err());

        // Invalid reference payload.
        let bad_reference = vec![DraftReferenceRecord {
            id: "r1".into(),
            kind: "memo".into(),
            label: "待办".into(),
            payload: String::new(),
        }];
        assert!(store
            .apply(vec![upsert_full(target, "t", Vec::new(), bad_reference)])
            .is_err());

        assert!(!dir.join(DRAFT_FILE_NAME).exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
