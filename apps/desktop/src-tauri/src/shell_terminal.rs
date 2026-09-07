use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use tauri::ipc::Channel;
use uuid::Uuid;

const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 4;
const MAX_ROWS: u16 = 300;
const MAX_INPUT_BYTES: usize = 256 * 1024;
const READ_BUFFER_BYTES: usize = 32 * 1024;
const TERMINAL_TERM: &str = "xterm-256color";
const TERMINAL_COLORTERM: &str = "truecolor";

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShellTerminalEvent {
    Output { data: String },
    Exited { exit_code: Option<u32> },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellTerminalCreateResult {
    pub terminal_id: String,
    pub title: String,
    pub cwd: String,
    pub resolved_profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfileSummary {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfileCatalog {
    pub profiles: Vec<ShellProfileSummary>,
    pub automatic_profile: ShellProfileSummary,
}

#[derive(Clone)]
struct DetectedShellProfile {
    id: &'static str,
    executable: PathBuf,
    label: &'static str,
}

struct ResolvedShell {
    profile_id: String,
    executable: PathBuf,
    args: Vec<String>,
    label: String,
}

type ShellTerminalWriteCompletion = tokio::sync::oneshot::Receiver<Result<(), String>>;

struct ShellTerminalWriteRequest {
    data: String,
    completed: tokio::sync::oneshot::Sender<Result<(), String>>,
}

struct ShellTerminalWriter {
    requests: mpsc::Sender<ShellTerminalWriteRequest>,
}

impl ShellTerminalWriter {
    fn new(mut writer: Box<dyn Write + Send>) -> Result<Self, String> {
        let (requests, receiver) = mpsc::channel::<ShellTerminalWriteRequest>();
        // Never join this worker during close: the PTY syscall itself may be blocked.
        std::thread::Builder::new()
            .name("piabyss-shell-writer".into())
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    let result = writer
                        .write_all(request.data.as_bytes())
                        .map_err(|error| format!("write PTY: {error}"))
                        .and_then(|_| {
                            writer
                                .flush()
                                .map_err(|error| format!("flush PTY: {error}"))
                        });
                    let _ = request.completed.send(result);
                }
            })
            .map_err(|error| format!("start PTY writer: {error}"))?;
        Ok(Self { requests })
    }

    fn enqueue_write(&self, data: String) -> Result<ShellTerminalWriteCompletion, String> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(format!("terminal input exceeds {MAX_INPUT_BYTES} bytes"));
        }
        let (completed, completion) = tokio::sync::oneshot::channel();
        self.requests
            .send(ShellTerminalWriteRequest { data, completed })
            .map_err(|_| "terminal writer is unavailable".to_string())?;
        Ok(completion)
    }
}

struct ShellTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: ShellTerminalWriter,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    stopping: Arc<AtomicBool>,
    reader_thread: Option<JoinHandle<()>>,
    #[cfg(windows)]
    windows_job: WindowsPtyJob,
    #[cfg(unix)]
    process_group_id: Option<i32>,
}

impl ShellTerminalSession {
    fn spawn(
        cwd: &Path,
        cols: u16,
        rows: u16,
        profile_id: &str,
        on_event: Channel<ShellTerminalEvent>,
    ) -> Result<(Self, ResolvedShell, Option<String>), String> {
        let (shell, warning) = resolve_shell(profile_id, cwd)?;
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|error| format!("open PTY: {error}"))?;
        let mut command = CommandBuilder::new(&shell.executable);
        configure_terminal_environment(&mut command);
        command.cwd(cwd);
        for arg in &shell.args {
            command.arg(arg);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("start {}: {error}", shell.label))?;
        drop(pair.slave);

        #[cfg(windows)]
        let windows_job = match child.as_raw_handle() {
            Some(process_handle) => match WindowsPtyJob::assign(process_handle) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    return Err(error);
                }
            },
            None => {
                let _ = child.kill();
                return Err("Shell exited before process-tree assignment".into());
            }
        };
        #[cfg(unix)]
        let process_group_id = pair.master.process_group_leader();
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("clone PTY reader: {error}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("take PTY writer: {error}"));
            }
        };
        let writer = match ShellTerminalWriter::new(writer) {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        let child = Arc::new(Mutex::new(child));
        let stopping = Arc::new(AtomicBool::new(false));
        let reader_child = Arc::clone(&child);
        let reader_stopping = Arc::clone(&stopping);
        let reader_thread = match std::thread::Builder::new()
            .name("piabyss-shell-reader".into())
            .spawn(move || {
                let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
                let mut decoder = Utf8StreamDecoder::default();
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            if let Some(data) = decoder.push(&buffer[..read]) {
                                let _ = on_event.send(ShellTerminalEvent::Output { data });
                            }
                        }
                        Err(error) => {
                            if !reader_stopping.load(Ordering::SeqCst) {
                                let _ = on_event.send(ShellTerminalEvent::Error {
                                    message: format!("read PTY: {error}"),
                                });
                            }
                            break;
                        }
                    }
                }
                if let Some(data) = decoder.finish() {
                    let _ = on_event.send(ShellTerminalEvent::Output { data });
                }
                let exit_code = reader_child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.wait().ok())
                    .map(|status| status.exit_code());
                let _ = on_event.send(ShellTerminalEvent::Exited { exit_code });
            }) {
            Ok(thread) => thread,
            Err(error) => {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
                return Err(format!("start PTY reader: {error}"));
            }
        };

        Ok((
            Self {
                master: pair.master,
                writer,
                child,
                stopping,
                reader_thread: Some(reader_thread),
                #[cfg(windows)]
                windows_job,
                #[cfg(unix)]
                process_group_id,
            },
            shell,
            warning,
        ))
    }

    fn enqueue_write(&self, data: String) -> Result<ShellTerminalWriteCompletion, String> {
        self.writer.enqueue_write(data)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(pty_size(cols, rows))
            .map_err(|error| format!("resize PTY: {error}"))
    }

    fn shutdown(mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            unsafe {
                libc::kill(-process_group_id, libc::SIGHUP);
            }
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        drop(self.writer);
        drop(self.master);
        #[cfg(windows)]
        drop(self.windows_job);
        if let Some(reader_thread) = self.reader_thread.take() {
            let _ = reader_thread.join();
        }
    }
}

pub struct ShellTerminalManager {
    sessions: HashMap<String, ShellTerminalSession>,
}

impl ShellTerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn create(
        &mut self,
        raw_cwd: &str,
        cols: u16,
        rows: u16,
        profile_id: &str,
        on_event: Channel<ShellTerminalEvent>,
    ) -> Result<ShellTerminalCreateResult, String> {
        let cwd = validate_terminal_cwd(raw_cwd)?;
        let (session, shell_title, warning) = ShellTerminalSession::spawn(
            &cwd,
            clamp(cols, MIN_COLS, MAX_COLS),
            clamp(rows, MIN_ROWS, MAX_ROWS),
            profile_id,
            on_event,
        )?;
        let terminal_id = Uuid::new_v4().to_string();
        self.sessions.insert(terminal_id.clone(), session);
        Ok(ShellTerminalCreateResult {
            terminal_id,
            title: shell_title.label,
            cwd: cwd.to_string_lossy().into_owned(),
            resolved_profile_id: shell_title.profile_id,
            warning,
        })
    }

    pub fn enqueue_write(
        &self,
        terminal_id: &str,
        data: String,
    ) -> Result<ShellTerminalWriteCompletion, String> {
        self.sessions
            .get(terminal_id)
            .ok_or_else(|| "unknown shell terminal".to_string())?
            .enqueue_write(data)
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.sessions
            .get(terminal_id)
            .ok_or_else(|| "unknown shell terminal".to_string())?
            .resize(
                clamp(cols, MIN_COLS, MAX_COLS),
                clamp(rows, MIN_ROWS, MAX_ROWS),
            )
    }

    pub fn close(&mut self, terminal_id: &str) -> bool {
        let Some(session) = self.sessions.remove(terminal_id) else {
            return false;
        };
        session.shutdown();
        true
    }

    pub fn shutdown_all(&mut self) {
        for (_, session) in self.sessions.drain() {
            session.shutdown();
        }
    }
}

impl Drop for ShellTerminalManager {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

fn clamp(value: u16, min: u16, max: u16) -> u16 {
    value.max(min).min(max)
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: clamp(cols, MIN_COLS, MAX_COLS),
        rows: clamp(rows, MIN_ROWS, MAX_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", TERMINAL_TERM);
    command.env("COLORTERM", TERMINAL_COLORTERM);
}

pub(crate) fn validate_terminal_cwd(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("terminal cwd is empty".into());
    }
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return Err("network (UNC) terminal directories are not allowed".into());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("terminal cwd must be absolute".into());
    }
    let cwd = path
        .canonicalize()
        .map_err(|error| format!("terminal cwd is not accessible: {error}"))?;
    if !cwd.is_dir() {
        return Err("terminal cwd must be a directory".into());
    }
    #[cfg(windows)]
    let cwd = crate::pi_host::strip_verbatim_prefix(cwd);
    #[cfg(windows)]
    if cwd.to_string_lossy().starts_with(r"\\") {
        return Err("network (UNC) terminal directories are not allowed".into());
    }
    Ok(cwd)
}

const SUPPORTED_PROFILE_IDS: &[&str] = &[
    "auto",
    "pwsh",
    "windows-powershell",
    "cmd",
    "git-bash",
    "wsl-default",
    "zsh",
    "bash",
    "fish",
    "sh",
];

fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

fn push_profile(
    profiles: &mut Vec<DetectedShellProfile>,
    id: &'static str,
    label: &'static str,
    candidates: impl IntoIterator<Item = PathBuf>,
) {
    if profiles.iter().any(|profile| profile.id == id) {
        return;
    }
    if let Some(executable) = candidates.into_iter().find(|path| path.is_file()) {
        profiles.push(DetectedShellProfile {
            id,
            executable,
            label,
        });
    }
}

#[cfg(windows)]
fn detect_platform_shells() -> Vec<DetectedShellProfile> {
    let mut profiles = Vec::new();
    let mut pwsh = Vec::new();
    for var in ["ProgramW6432", "ProgramFiles"] {
        if let Some(root) = std::env::var_os(var) {
            pwsh.push(PathBuf::from(root).join("PowerShell/7/pwsh.exe"));
        }
    }
    if let Some(path) = find_on_path("pwsh.exe") {
        pwsh.push(path);
    }
    push_profile(&mut profiles, "pwsh", "PowerShell 7", pwsh);

    if let Some(root) = std::env::var_os("SystemRoot") {
        let root = PathBuf::from(root);
        push_profile(
            &mut profiles,
            "windows-powershell",
            "Windows PowerShell",
            [root.join("System32/WindowsPowerShell/v1.0/powershell.exe")],
        );
        push_profile(
            &mut profiles,
            "cmd",
            "Command Prompt",
            [root.join("System32/cmd.exe")],
        );
        push_profile(
            &mut profiles,
            "wsl-default",
            "WSL (default distribution)",
            [root.join("System32/wsl.exe")],
        );
    }
    let mut git_bash = Vec::new();
    for var in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(var) {
            git_bash.push(PathBuf::from(root).join("Git/bin/bash.exe"));
        }
    }
    push_profile(&mut profiles, "git-bash", "Git Bash", git_bash);
    profiles
}

#[cfg(unix)]
fn detect_platform_shells() -> Vec<DetectedShellProfile> {
    let mut profiles = Vec::new();
    for (id, label, paths) in [
        ("zsh", "Zsh", vec![PathBuf::from("/bin/zsh")]),
        ("bash", "Bash", vec![PathBuf::from("/bin/bash")]),
        ("fish", "Fish", find_on_path("fish").into_iter().collect()),
        ("sh", "POSIX Shell", vec![PathBuf::from("/bin/sh")]),
        (
            "pwsh",
            "PowerShell 7",
            find_on_path("pwsh").into_iter().collect(),
        ),
    ] {
        push_profile(&mut profiles, id, label, paths);
    }
    profiles
}

fn shell_args(profile_id: &str, cwd: &Path) -> Vec<String> {
    match profile_id {
        "pwsh" | "windows-powershell" => vec!["-NoLogo".into()],
        "git-bash" => vec!["--login".into(), "-i".into()],
        "wsl-default" => vec!["--cd".into(), cwd.to_string_lossy().into_owned()],
        "zsh" | "bash" | "fish" | "sh" => vec!["-l".into()],
        _ => Vec::new(),
    }
}

fn from_detected(profile: DetectedShellProfile, cwd: &Path) -> ResolvedShell {
    ResolvedShell {
        profile_id: profile.id.into(),
        executable: profile.executable,
        args: shell_args(profile.id, cwd),
        label: profile.label.into(),
    }
}

fn resolve_default_shell(cwd: &Path) -> Result<ResolvedShell, String> {
    #[cfg(unix)]
    if let Some(executable) = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
    {
        let label = executable
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Shell")
            .to_string();
        let profile_id = match label.as_str() {
            "zsh" | "bash" | "fish" | "sh" | "pwsh" => label.clone(),
            _ => "auto".into(),
        };
        return Ok(ResolvedShell {
            args: shell_args(&profile_id, cwd),
            executable,
            label,
            profile_id,
        });
    }

    let profiles = detect_platform_shells();
    #[cfg(windows)]
    let preferred = ["pwsh", "windows-powershell", "cmd"];
    #[cfg(unix)]
    let preferred = ["zsh", "bash", "sh"];
    preferred
        .into_iter()
        .find_map(|id| profiles.iter().find(|profile| profile.id == id).cloned())
        .map(|profile| from_detected(profile, cwd))
        .ok_or_else(|| "No supported shell was found".into())
}

fn resolve_shell(
    requested_profile_id: &str,
    cwd: &Path,
) -> Result<(ResolvedShell, Option<String>), String> {
    if !SUPPORTED_PROFILE_IDS.contains(&requested_profile_id) {
        return Err(format!(
            "Unsupported terminal profile: {requested_profile_id}"
        ));
    }
    if requested_profile_id == "auto" {
        return Ok((resolve_default_shell(cwd)?, None));
    }
    if let Some(profile) = detect_platform_shells()
        .into_iter()
        .find(|profile| profile.id == requested_profile_id)
    {
        return Ok((from_detected(profile, cwd), None));
    }
    let fallback = resolve_default_shell(cwd)?;
    Ok((
        fallback,
        Some(format!(
            "The selected shell '{requested_profile_id}' is unavailable; opened Automatic instead"
        )),
    ))
}

pub fn shell_profile_catalog() -> Result<ShellProfileCatalog, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let automatic = resolve_default_shell(&cwd)?;
    Ok(ShellProfileCatalog {
        profiles: detect_platform_shells()
            .into_iter()
            .map(|profile| ShellProfileSummary {
                id: profile.id.into(),
                label: profile.label.into(),
                path: profile.executable.to_string_lossy().into_owned(),
            })
            .collect(),
        automatic_profile: ShellProfileSummary {
            id: "auto".into(),
            label: automatic.label,
            path: automatic.executable.to_string_lossy().into_owned(),
        },
    })
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> Option<String> {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        output.push_str(unsafe {
                            std::str::from_utf8_unchecked(&self.pending[..valid])
                        });
                        self.pending.drain(..valid);
                    }
                    if let Some(invalid_len) = error.error_len() {
                        output.push('\u{fffd}');
                        self.pending.drain(..invalid_len);
                    } else {
                        break;
                    }
                }
            }
        }
        (!output.is_empty()).then_some(output)
    }

    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        Some(String::from_utf8_lossy(std::mem::take(&mut self.pending).as_slice()).into_owned())
    }
}

#[cfg(windows)]
struct WindowsPtyJob {
    handle: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl WindowsPtyJob {
    fn assign(process_handle: std::os::windows::io::RawHandle) -> Result<Self, String> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw_job.is_null() {
                return Err(format!(
                    "create Shell Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let job = Self {
                handle: OwnedHandle::from_raw_handle(raw_job),
            };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(format!(
                    "configure Shell Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if AssignProcessToJobObject(job.handle.as_raw_handle(), process_handle) == 0 {
                return Err(format!(
                    "assign Shell to Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(job)
        }
    }
}

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct BlockingWriter {
        started: Option<std::sync::mpsc::Sender<()>>,
        release: std::sync::mpsc::Receiver<()>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
                let _ = self.release.recv();
            }
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("lock writes").extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn blocked_pty_write_does_not_hold_manager_lock() {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let writer = Arc::new(
            ShellTerminalWriter::new(Box::new(BlockingWriter {
                started: Some(started_tx),
                release: release_rx,
            }))
            .expect("create terminal writer"),
        );
        let manager_lock = Arc::new(Mutex::new(()));
        let write_thread = {
            let writer = Arc::clone(&writer);
            let manager_lock = Arc::clone(&manager_lock);
            std::thread::spawn(move || {
                let _manager = manager_lock.lock().expect("lock manager");
                let _ = writer.enqueue_write("blocked input".into());
            })
        };

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("writer should start");
        let (progress_tx, progress_rx) = std::sync::mpsc::channel();
        let progress_thread = {
            let manager_lock = Arc::clone(&manager_lock);
            std::thread::spawn(move || {
                let _manager = manager_lock.lock().expect("lock manager for recovery");
                let _ = progress_tx.send(());
            })
        };
        let manager_progressed = progress_rx.recv_timeout(Duration::from_millis(500)).is_ok();
        release_tx.send(()).expect("release writer");
        write_thread.join().expect("join write caller");
        progress_thread.join().expect("join manager caller");

        assert!(
            manager_progressed,
            "the manager lock must be released before PTY I/O completes"
        );
    }

    #[test]
    fn terminal_writer_preserves_request_order() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let writer = ShellTerminalWriter::new(Box::new(RecordingWriter(Arc::clone(&writes))))
            .expect("create terminal writer");

        let first = writer.enqueue_write("first".into()).expect("enqueue first");
        let second = writer
            .enqueue_write("-second".into())
            .expect("enqueue second");

        assert_eq!(first.blocking_recv().expect("receive first"), Ok(()));
        assert_eq!(second.blocking_recv().expect("receive second"), Ok(()));
        assert_eq!(
            writes.lock().expect("lock recorded writes").as_slice(),
            b"first-second"
        );
    }

    #[test]
    fn clamps_pty_dimensions() {
        assert_eq!(pty_size(1, 1).cols, MIN_COLS);
        assert_eq!(pty_size(u16::MAX, u16::MAX).rows, MAX_ROWS);
    }

    #[test]
    fn configures_terminal_color_capabilities() {
        let mut command = CommandBuilder::new("shell");
        configure_terminal_environment(&mut command);

        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
    }

    #[test]
    fn validates_terminal_directories() {
        assert!(validate_terminal_cwd("").is_err());
        assert!(validate_terminal_cwd("relative").is_err());
        assert!(validate_terminal_cwd("//server/share").is_err());
        assert!(validate_terminal_cwd(std::env::temp_dir().to_string_lossy().as_ref()).is_ok());
    }

    #[test]
    fn decodes_utf8_split_across_pty_reads() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(&[0xe4, 0xbd]), None);
        assert_eq!(decoder.push(&[0xa0, 0xe5, 0xa5, 0xbd]), Some("你好".into()));
        assert_eq!(decoder.finish(), None);
    }
}
