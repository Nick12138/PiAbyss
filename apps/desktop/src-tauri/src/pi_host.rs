use crate::desktop_settings::DesktopSettingsStore;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub(crate) const HOST_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
pub(crate) const APP_EXIT_HOST_SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
pub(crate) const IDLE_HOST_RETENTION: Duration = Duration::from_secs(30 * 60);
/// Minimum idle time before a background Host is probed for RSS. Younger
/// hosts can only be retired by the base retention rule, so probing them is
/// wasted work.
pub(crate) const RSS_PROBE_MIN_IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTransportFrame {
    pub route_id: String,
    pub line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostActivitySnapshot {
    pub cwd: String,
    /// Pool keys of every workspace bound to this Host, the entry's own key
    /// first. One element in dedicated mode; grows in shared-host mode. Old
    /// renderers only read `cwd`, which mirrors the first binding.
    pub cwds: Vec<String>,
    pub busy: bool,
    /// Busy sessions attributed to the workspace cwd that owns them
    /// (sessionId → cwd), so the workspace list can show which workspace's
    /// Host still has a turn running in shared-host mode. Sessions that
    /// cannot be attributed yet — the Host has not broadcast its workspace
    /// bindings, or the envelope carried no workspaceId — are skipped, and
    /// the whole map is omitted from the JSON while empty.
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub busy_sessions: HashMap<String, String>,
    pub has_been_busy: bool,
    /// Unacknowledged failed sessions (red dot).
    pub error_count: usize,
    /// Unacknowledged completed sessions (gray dot).
    pub done_count: usize,
    /// Per-session terminal markers let the renderer rebuild the session dots
    /// after returning to a workspace whose Host kept running in background.
    pub terminal_sessions: HashMap<String, HostTerminalActivity>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTerminalActivity {
    pub state: String,
    /// Monotonic within this Host. A later run of the same session gets a new
    /// generation, so an acknowledgement for an older run cannot hide it.
    pub generation: u64,
    /// Workspace cwd the session was bound to when it settled, resolved from
    /// the session's runtime envelope plus the Host's `host.statusChanged`
    /// bindings. `None` (and omitted from JSON) while the Host has not
    /// announced bindings for that session's workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_cwd: Option<String>,
}

#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, process::CommandExt};
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(unix)]
use std::sync::atomic::AtomicU8;
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(crate) const MAX_HOST_STDOUT_LINE_BYTES: usize = 32 * 1024 * 1024;
const MAX_HOST_STDERR_LINE_BYTES: usize = 1024 * 1024;
const HOST_STDIN_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct HostLineTooLong {
    max_bytes: usize,
}

impl std::fmt::Display for HostLineTooLong {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "line exceeds {} byte limit", self.max_bytes)
    }
}

impl std::error::Error for HostLineTooLong {}

fn is_host_line_too_long(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .and_then(|source| source.downcast_ref::<HostLineTooLong>())
        .is_some()
}

async fn discard_through_newline<R>(reader: &mut R) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(());
        }
    }
}

pub(crate) async fn write_host_stdin<W>(
    writer: &mut W,
    payload: &[u8],
    deadline: Duration,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    match tokio::time::timeout(deadline, async {
        writer
            .write_all(payload)
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        writer.flush().await.map_err(|e| {
            format!(
                "flush stdin: {e} — Host process likely crashed. Check Settings → Restart Host after `pnpm build`."
            )
        })?;
        Ok(())
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "write stdin timed out after {} ms — Host is not reading requests; use Settings → Restart Host",
            deadline.as_millis()
        )),
    }
}

pub(crate) async fn read_bounded_utf8_line<R>(
    reader: &mut R,
    buffer: &mut String,
    max_bytes: usize,
) -> std::io::Result<usize>
where
    R: AsyncBufRead + Unpin,
{
    // Reuse the caller's allocation. `take(max + 1)` bounds this buffer; only
    // the remainder of an oversized line is discarded without allocation.
    let mut bytes = std::mem::take(buffer).into_bytes();
    bytes.clear();
    let bytes_read = {
        let mut limited = (&mut *reader).take((max_bytes as u64).saturating_add(1));
        limited.read_until(b'\n', &mut bytes).await?
    };
    if bytes_read > max_bytes {
        if bytes.last() != Some(&b'\n') {
            discard_through_newline(reader).await?;
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            HostLineTooLong { max_bytes },
        ));
    }
    *buffer = String::from_utf8(bytes).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("line is not valid UTF-8: {error}"),
        )
    })?;
    Ok(bytes_read)
}

pub(crate) async fn read_bounded_lossy_line<R>(
    reader: &mut R,
    buffer: &mut String,
    max_bytes: usize,
) -> std::io::Result<usize>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    let bytes_read = {
        let mut limited = (&mut *reader).take((max_bytes as u64).saturating_add(1));
        limited.read_until(b'\n', &mut bytes).await?
    };
    if bytes_read > max_bytes {
        if bytes.last() != Some(&b'\n') {
            discard_through_newline(reader).await?;
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            HostLineTooLong { max_bytes },
        ));
    }
    buffer.clear();
    buffer.push_str(&String::from_utf8_lossy(&bytes));
    Ok(bytes_read)
}

#[cfg(windows)]
pub(crate) struct WindowsHostJob {
    handle: OwnedHandle,
}

#[cfg(windows)]
impl WindowsHostJob {
    pub(crate) fn assign(child: &Child) -> Result<Self, String> {
        unsafe {
            let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw_job.is_null() {
                return Err(format!(
                    "create Host Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let job = Self {
                handle: OwnedHandle::from_raw_handle(raw_job),
            };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let job_handle = job.handle.as_raw_handle();
            if SetInformationJobObject(
                job_handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(format!(
                    "configure Host Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let process_handle = child
                .raw_handle()
                .ok_or_else(|| "Host exited before Job Object assignment".to_string())?;
            if AssignProcessToJobObject(job_handle, process_handle) == 0 {
                return Err(format!(
                    "assign Host to Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(job)
        }
    }
}

#[cfg(unix)]
const UNIX_HOST_GROUP_TERM_GRACE: std::time::Duration = std::time::Duration::from_millis(500);
#[cfg(unix)]
const UNIX_HOST_GROUP_CLEANUP_UNCLAIMED: u8 = 0;
#[cfg(unix)]
const UNIX_HOST_GROUP_CLEANUP_CLAIMED: u8 = 1;
#[cfg(unix)]
const UNIX_HOST_GROUP_CLEANUP_SIGNALED: u8 = 2;

#[cfg(unix)]
#[derive(Clone)]
pub(crate) struct UnixHostProcessGroup {
    id: libc::pid_t,
    cleanup_state: Arc<AtomicU8>,
}

#[cfg(unix)]
pub(crate) struct UnixHostGroupCleanup {
    id: libc::pid_t,
    cleanup_state: Arc<AtomicU8>,
    finished: bool,
}

#[cfg(unix)]
impl UnixHostProcessGroup {
    fn from_child_id(child_id: Option<u32>) -> Result<Self, String> {
        let child_id = child_id.ok_or_else(|| "Host exited before PID capture".to_string())?;
        let id = libc::pid_t::try_from(child_id)
            .map_err(|_| format!("Host PID {child_id} exceeds Unix pid_t"))?;
        if id <= 0 {
            return Err(format!("Host returned invalid Unix PID {id}"));
        }
        Ok(Self {
            id,
            cleanup_state: Arc::new(AtomicU8::new(UNIX_HOST_GROUP_CLEANUP_UNCLAIMED)),
        })
    }

    fn claim_cleanup(&self) -> Option<UnixHostGroupCleanup> {
        self.cleanup_state
            .compare_exchange(
                UNIX_HOST_GROUP_CLEANUP_UNCLAIMED,
                UNIX_HOST_GROUP_CLEANUP_CLAIMED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .ok()
            .map(|_| UnixHostGroupCleanup {
                id: self.id,
                cleanup_state: Arc::clone(&self.cleanup_state),
                finished: false,
            })
    }

    // A successful claim is not enough for a reaper: the owner must publish
    // that its final group signal has returned before the leader PID is freed.
    async fn wait_until_cleanup_signaled(&self) {
        while self.cleanup_state.load(Ordering::Acquire) != UNIX_HOST_GROUP_CLEANUP_SIGNALED {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }

    fn wait_until_cleanup_signaled_blocking(&self) {
        while self.cleanup_state.load(Ordering::Acquire) != UNIX_HOST_GROUP_CLEANUP_SIGNALED {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}

#[cfg(unix)]
impl UnixHostGroupCleanup {
    fn finish(&mut self) {
        self.finished = true;
        self.cleanup_state
            .store(UNIX_HOST_GROUP_CLEANUP_SIGNALED, Ordering::Release);
    }

    fn signal(&self, signal: libc::c_int) -> Result<(), String> {
        if unsafe { libc::kill(-self.id, signal) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(format!(
            "signal Host process group {} with {signal}: {error}",
            self.id
        ))
    }

    fn exists(&self) -> bool {
        if unsafe { libc::kill(-self.id, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    fn force_kill(&mut self) {
        let _ = self.signal(libc::SIGKILL);
        self.finish();
    }

    #[allow(dead_code)] // synchronous HostChildSession test harness
    fn terminate_blocking(&mut self) {
        let _ = self.signal(libc::SIGTERM);
        let deadline = std::time::Instant::now() + UNIX_HOST_GROUP_TERM_GRACE;
        while std::time::Instant::now() < deadline {
            if !self.exists() {
                self.finish();
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        self.force_kill();
    }
}

#[cfg(unix)]
impl Drop for UnixHostGroupCleanup {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.signal(libc::SIGKILL);
            self.finish();
        }
    }
}

#[cfg(unix)]
fn force_cleanup_unix_host_group(group: &UnixHostProcessGroup) {
    if let Some(mut cleanup) = group.claim_cleanup() {
        cleanup.force_kill();
    }
}

#[cfg(unix)]
async fn force_cleanup_unix_host_group_slot_before_reap(slot: &mut Option<UnixHostProcessGroup>) {
    if let Some(group) = slot.take() {
        if let Some(mut cleanup) = group.claim_cleanup() {
            cleanup.force_kill();
        } else {
            group.wait_until_cleanup_signaled().await;
        }
    }
}

#[cfg(unix)]
fn force_cleanup_unix_host_group_slot_before_reap_blocking(
    slot: &mut Option<UnixHostProcessGroup>,
) {
    if let Some(group) = slot.take() {
        if let Some(mut cleanup) = group.claim_cleanup() {
            cleanup.force_kill();
        } else {
            group.wait_until_cleanup_signaled_blocking();
        }
    }
}

#[cfg(unix)]
async fn terminate_unix_host_group(cleanup: &mut UnixHostGroupCleanup) {
    let _ = cleanup.signal(libc::SIGTERM);
    let deadline = tokio::time::Instant::now() + UNIX_HOST_GROUP_TERM_GRACE;
    while tokio::time::Instant::now() < deadline {
        if !cleanup.exists() {
            cleanup.finish();
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    cleanup.force_kill();
}

#[cfg(unix)]
fn configure_unix_host_command(command: &mut std::process::Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(unix)]
pub(crate) fn unix_child_exited_without_reaping(child_id: Option<u32>) -> Result<bool, String> {
    let child_id = child_id.ok_or_else(|| "Host exited before PID observation".to_string())?;
    let pid = libc::pid_t::try_from(child_id)
        .map_err(|_| format!("Host PID {child_id} exceeds Unix pid_t"))?;
    if pid <= 0 {
        return Err(format!("Host returned invalid Unix PID {pid}"));
    }
    let id =
        libc::id_t::try_from(pid).map_err(|_| format!("Host PID {child_id} exceeds Unix id_t"))?;

    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // WNOWAIT retains an exited group leader as a zombie, preventing PID
        // reuse until its process group has been signaled and Child::wait reaps it.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                id,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            let info = unsafe { info.assume_init() };
            let observed_pid = unsafe { info.si_pid() };
            return Ok(observed_pid == pid);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(format!(
            "observe Host PID {child_id} without reaping: {error}"
        ));
    }
}

#[cfg(unix)]
async fn wait_for_unix_child_exit_without_reaping(
    child_id: Option<u32>,
    timeout: std::time::Duration,
) -> Result<bool, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if unix_child_exited_without_reaping(child_id)? {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// Manages the Node Pi Host sidecar process.
/// Rust owns process lifecycle only — no Pi business logic.
pub struct PiHostManager {
    app: AppHandle,
    route_id: String,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    agent_dir: PathBuf,
    /// Workspace the Host preloads before announcing ready, so the expensive
    /// first graph build overlaps WebView/frontend startup.
    initial_workspace: Option<PathBuf>,
    /// Restarts performed for the current host epoch (reset after stable ready).
    restart_count: Arc<AtomicU32>,
    auto_restart_once: bool,
    shutting_down: Arc<AtomicBool>,
    last_stderr: Arc<Mutex<Vec<String>>>,
    last_ready_line: Arc<Mutex<Option<String>>>,
    /// In-flight request ids → sender, so Rust can await a Host response without
    /// routing through the renderer (used to bootstrap a background workspace).
    pending_requests: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    activity: Arc<StdMutex<HostActivity>>,
    /// Real hostInstanceId from host.ready / hello — never use "*" for shutdown.
    host_instance_id: Option<String>,
    /// When true, unexpected exit may auto-restart once this epoch.
    auto_restart_armed: Arc<AtomicBool>,
    /// Plugin library configuration (plugin id → env name → value), injected
    /// into the Host process environment at spawn time. Snapshot taken from
    /// desktop settings; applied on the next Host start.
    plugin_env: BTreeMap<String, BTreeMap<String, String>>,
    /// Idle Session hot-queue policy, applied to the next spawned Host.
    idle_session_cache_limit: u32,
    idle_session_timeout_minutes: u32,
    /// Shared-host mode: when true the next spawned Host is told (via
    /// `PIABYSS_MAX_BOUND_WORKSPACES`) to keep every workspace graph bound so
    /// in-place switches return instantly.
    shared_host_mode: bool,
    /// Monotonic child generation used to retire delayed stdout/stderr monitors.
    child_generation: Arc<AtomicU32>,
    stdout_task: Option<JoinHandle<()>>,
    stderr_task: Option<JoinHandle<()>>,
    #[cfg(windows)]
    windows_job: Option<WindowsHostJob>,
    #[cfg(unix)]
    unix_process_group: Option<UnixHostProcessGroup>,
}

/// Pure pool bookkeeping — which route serves which workspace, which entry
/// is active, and which workspaces each entry serves — kept free of Tauri and
/// manager types so the shared-host routing decisions stay unit-testable
/// without an app handle. Every key in `entries` has a matching `hosts` slot.
pub(crate) struct PoolBook {
    pub(crate) entries: HashMap<String, BookEntry>,
    pub(crate) route_to_key: HashMap<String, String>,
    pub(crate) active_key: String,
}

#[derive(Clone)]
pub(crate) struct BookEntry {
    pub(crate) route_id: String,
    pub(crate) canonical_cwd: PathBuf,
    /// Pool keys of every workspace this entry serves, including the entry's
    /// own `entries` key first. One element in dedicated mode; shared-host
    /// mode appends a key on every in-place rebind instead of re-keying.
    pub(crate) workspaces: Vec<String>,
}

impl PoolBook {
    pub(crate) fn new(key: String, route_id: String, canonical_cwd: PathBuf) -> Self {
        let mut entries = HashMap::new();
        entries.insert(
            key.clone(),
            BookEntry {
                route_id: route_id.clone(),
                canonical_cwd,
                workspaces: vec![key.clone()],
            },
        );
        Self {
            entries,
            route_to_key: HashMap::from([(route_id, key.clone())]),
            active_key: key,
        }
    }

    /// Which entry should serve a workspace activation request under the given
    /// mode. Dedicated mode reuses an exact key match (1:1 entry ↔ workspace);
    /// shared-host mode reuses the ACTIVE entry whenever one exists, so the
    /// pool never grows a second Host — only the cold bootstrap (no active
    /// entry at all) returns `Spawn`.
    pub(crate) fn activation_target(&self, key: &str, shared_host_mode: bool) -> ActivationTarget {
        if shared_host_mode {
            return if self.entries.contains_key(&self.active_key) {
                ActivationTarget::Reuse(self.active_key.clone())
            } else {
                ActivationTarget::Spawn
            };
        }
        if self.entries.contains_key(key) {
            ActivationTarget::Reuse(key.to_string())
        } else {
            ActivationTarget::Spawn
        }
    }

    /// The pool key of the entry serving `key`: a direct map hit first, then a
    /// scan of every entry's bound workspaces. The fallback matters in
    /// shared-host mode where one entry registers several workspace keys.
    pub(crate) fn key_for_workspace<'a>(&'a self, key: &str) -> Option<&'a String> {
        if self.entries.contains_key(key) {
            return self.entries.get_key_value(key).map(|(found, _)| found);
        }
        self.entries
            .iter()
            .find(|(_, entry)| entry.workspaces.iter().any(|bound| bound == key))
            .map(|(found, _)| found)
    }

    /// Registers a freshly spawned Host under `key` (bookkeeping only; the
    /// active route is set separately by `set_active_route`).
    pub(crate) fn register_spawn(&mut self, key: String, route_id: String, canonical_cwd: PathBuf) {
        self.route_to_key.insert(route_id.clone(), key.clone());
        self.entries.insert(
            key.clone(),
            BookEntry {
                route_id,
                canonical_cwd,
                workspaces: vec![key],
            },
        );
    }

    /// Shared-host rebind: register `target_key` as another workspace served
    /// by the active entry. The entry key, route and `route_to_key` mapping
    /// stay untouched — this is registration, not re-keying. The bootstrap
    /// entry is born with an empty `canonical_cwd` when the last workspace
    /// could not be canonicalized at startup; the first successful shared-mode
    /// binding fills it so the activity snapshot chain has a display cwd.
    pub(crate) fn register_workspace_on_active(
        &mut self,
        target_key: String,
        canonical_cwd: PathBuf,
    ) {
        let entry = self
            .entries
            .get_mut(&self.active_key)
            .expect("active HostPool entry must exist");
        if entry.canonical_cwd.as_os_str().is_empty() {
            entry.canonical_cwd = canonical_cwd;
        }
        if !entry.workspaces.iter().any(|bound| bound == &target_key) {
            entry.workspaces.push(target_key);
        }
    }

    /// Dedicated-mode rebind: move the active entry to `target_key` (1:1
    /// entry ↔ workspace), returning the entry's unchanged route id.
    pub(crate) fn rekey_active(&mut self, target_key: String, canonical_cwd: PathBuf) -> String {
        let mut entry = self
            .entries
            .remove(&self.active_key)
            .expect("active HostPool entry must exist");
        self.route_to_key.remove(&entry.route_id);
        entry.canonical_cwd = canonical_cwd;
        entry.workspaces = vec![target_key.clone()];
        self.route_to_key
            .insert(entry.route_id.clone(), target_key.clone());
        self.entries.insert(target_key.clone(), entry);
        self.active_key = target_key;
        self.entries[&self.active_key].route_id.clone()
    }

    pub(crate) fn remove_entry(&mut self, key: &str) -> Option<String> {
        let entry = self.entries.remove(key)?;
        self.route_to_key.remove(&entry.route_id);
        Some(entry.route_id)
    }

    pub(crate) fn set_active_route(&mut self, route_id: &str) -> Result<(), String> {
        let key = self
            .route_to_key
            .get(route_id)
            .cloned()
            .ok_or_else(|| "unknown Host route".to_string())?;
        self.active_key = key;
        Ok(())
    }
}

/// Activation decision returned by `PoolBook::activation_target`.
pub(crate) enum ActivationTarget {
    /// An existing entry (by pool key) serves the workspace — reuse it.
    Reuse(String),
    /// No entry serves the workspace; the caller may spawn a fresh Host.
    Spawn,
}

struct PoolHost {
    manager: Arc<Mutex<PiHostManager>>,
    activity: Arc<StdMutex<HostActivity>>,
}

pub struct WorkspaceHostActivation {
    pub route_id: String,
    pub manager: Arc<Mutex<PiHostManager>>,
    pub created: bool,
}

pub struct WorkspaceHostRebind {
    pub manager: Arc<Mutex<PiHostManager>>,
    pub canonical_workspace: PathBuf,
    pub retired: Vec<Arc<Mutex<PiHostManager>>>,
}

pub(crate) struct HostActivity {
    busy_sessions: HashSet<String>,
    idle_since: Instant,
    /// True once any session has entered a busy state, so the workspace list
    /// can distinguish "all sessions finished" from "no session ever ran".
    has_been_busy: bool,
    /// Unacknowledged terminal states (sessionId → "error" | "done").
    /// Cleared when the renderer acknowledges by returning to the session.
    terminal_sessions: HashMap<String, HostTerminalActivity>,
    next_terminal_generation: u64,
    /// Most recent announced state per session, used to tell a real
    /// busy→idle completion from a plain idle announcement for a restored
    /// session that never ran.
    last_state: HashMap<String, String>,
    /// workspaceId → cwd, rebuilt wholesale from each `host.statusChanged`
    /// broadcast's `boundWorkspaces` list. Attribution source for busy
    /// sessions and terminal markers in shared-host mode.
    pub(crate) workspace_cwds: HashMap<String, String>,
    /// sessionId → workspaceId, recorded from the top-level `workspaceId`
    /// envelope field of `session.runtimeChanged` events.
    pub(crate) session_workspace: HashMap<String, String>,
}

impl HostActivity {
    /// Test hook: age the idle clock so expiry rules are testable without
    /// waiting out `IDLE_HOST_RETENTION` (which would stall the suite).
    #[cfg(test)]
    pub(crate) fn set_idle_since_for_test(&mut self, idle_since: Instant) {
        self.idle_since = idle_since;
    }
}

impl Default for HostActivity {
    fn default() -> Self {
        Self {
            busy_sessions: HashSet::new(),
            idle_since: Instant::now(),
            has_been_busy: false,
            terminal_sessions: HashMap::new(),
            next_terminal_generation: 0,
            last_state: HashMap::new(),
            workspace_cwds: HashMap::new(),
            session_workspace: HashMap::new(),
        }
    }
}

/// Owns one isolated Node Host per canonical workspace. Switching the active
/// route changes only renderer IPC routing; inactive Hosts keep running.
/// In shared-host mode it owns ONE Host serving every workspace instead.
pub struct PiHostPool {
    app: AppHandle,
    book: PoolBook,
    hosts: HashMap<String, PoolHost>,
}

impl PiHostPool {
    pub fn new(app: AppHandle, settings: &DesktopSettingsStore) -> Self {
        let initial = PiHostManager::initial_workspace_from(settings)
            .and_then(|path| path.canonicalize().ok())
            .map(strip_verbatim_prefix);
        let key = initial
            .as_ref()
            .map(|path| workspace_pool_key(path))
            .unwrap_or_else(|| "__bootstrap__".to_string());
        let route_id = uuid::Uuid::new_v4().to_string();
        let canonical_cwd = initial.clone().unwrap_or_default();
        let manager = PiHostManager::new_routed(app.clone(), settings, route_id.clone(), initial);
        let activity = Arc::clone(&manager.activity);
        let manager = Arc::new(Mutex::new(manager));
        let book = PoolBook::new(key.clone(), route_id, canonical_cwd);
        let hosts = HashMap::from([(key, PoolHost { manager, activity })]);
        Self { app, book, hosts }
    }

    pub fn active_manager(&self) -> Arc<Mutex<PiHostManager>> {
        Arc::clone(
            &self
                .hosts
                .get(&self.book.active_key)
                .expect("active HostPool entry must exist")
                .manager,
        )
    }

    pub fn active_route_id(&self) -> String {
        self.book
            .entries
            .get(&self.book.active_key)
            .expect("active HostPool entry must exist")
            .route_id
            .clone()
    }

    /// Live per-workspace activity for the renderer's workspace list. The
    /// active workspace's Host streams events to the renderer, but background
    /// Hosts do not — this snapshot is the only view the UI has into whether
    /// another workspace still has sessions running.
    pub fn activity_snapshot(&self) -> Vec<HostActivitySnapshot> {
        self.book
            .entries
            .iter()
            .filter_map(|(key, entry)| {
                let host = self.hosts.get(key)?;
                host_activity_snapshot(&entry.canonical_cwd, &entry.workspaces, &host.activity)
            })
            .collect()
    }

    /// The renderer calls this when the user returns to a session, clearing
    /// its unacknowledged terminal marker so the workspace dot downgrades.
    pub fn acknowledge_session_terminal(&self, cwd: &Path, session_id: &str) -> bool {
        let key = workspace_pool_key(cwd);
        let Some(book_key) = self.book.key_for_workspace(&key) else {
            return false;
        };
        let Some(host) = self.hosts.get(book_key) else {
            return false;
        };
        if !acknowledge_session_terminal_in_activity(&host.activity, session_id) {
            return false;
        }
        let route_id = self.book.entries[book_key].route_id.clone();
        let _ = self.app.emit("pi-host-activity", route_id);
        true
    }

    pub fn manager_for_route(&self, route_id: &str) -> Option<Arc<Mutex<PiHostManager>>> {
        let key = self.book.route_to_key.get(route_id)?;
        self.hosts.get(key).map(|host| Arc::clone(&host.manager))
    }

    pub fn activate_workspace(
        &mut self,
        cwd: &Path,
        settings: &DesktopSettingsStore,
        force_dedicated: bool,
    ) -> Result<(String, Arc<Mutex<PiHostManager>>, bool), String> {
        let canonical = strip_verbatim_prefix(
            cwd.canonicalize()
                .map_err(|error| format!("workspace does not exist: {error}"))?,
        );
        if !canonical.is_dir() {
            return Err("workspace path is not a directory".into());
        }
        let key = workspace_pool_key(&canonical);
        match self.book.activation_target(
            &key,
            // Telegram bootstrap forces a dedicated Host: `/telegram-connect`
            // must run in its own preloaded workspace, never in whatever
            // workspace the shared foreground Host currently serves.
            settings.settings.shared_host_mode && !force_dedicated,
        ) {
            ActivationTarget::Reuse(book_key) => {
                // Shared-host mode: the pool must never grow a second Host —
                // the active entry serves the requested workspace too; the
                // renderer switches in place via `workspace.setCurrent` and
                // registers the workspace through `rebind_active_workspace`.
                let entry = &self.book.entries[&book_key];
                let route_id = entry.route_id.clone();
                let host = self
                    .hosts
                    .get(&book_key)
                    .expect("hosts map mirrors the book");
                return Ok((route_id, Arc::clone(&host.manager), false));
            }
            ActivationTarget::Spawn => {}
        }

        let route_id = uuid::Uuid::new_v4().to_string();
        let manager = PiHostManager::new_routed(
            self.app.clone(),
            settings,
            route_id.clone(),
            Some(canonical.clone()),
        );
        let activity = Arc::clone(&manager.activity);
        let manager = Arc::new(Mutex::new(manager));
        self.book
            .register_spawn(key.clone(), route_id.clone(), canonical);
        self.hosts.insert(
            key,
            PoolHost {
                manager: Arc::clone(&manager),
                activity,
            },
        );
        Ok((route_id, manager, true))
    }

    pub fn prepare_workspace_switch(
        &mut self,
        cwd: &Path,
        renderer_reports_busy: bool,
        settings: &DesktopSettingsStore,
    ) -> Result<Option<WorkspaceHostActivation>, String> {
        let canonical = canonical_workspace(cwd)?;
        let target_key = workspace_pool_key(&canonical);
        if settings.settings.shared_host_mode {
            // Shared-host mode: never prepare a dedicated Host — the active
            // entry serves every workspace, and the renderer switches in place
            // via `workspace.setCurrent` + `rebind_active_workspace`. Kept safe
            // for any caller that still asks: reuse the active route, never
            // spawn. Only the cold bootstrap (no active entry at all) may
            // still spawn below.
            match self.book.activation_target(&target_key, true) {
                ActivationTarget::Reuse(book_key) => {
                    let entry = &self.book.entries[&book_key];
                    let route_id = entry.route_id.clone();
                    let host = self
                        .hosts
                        .get(&book_key)
                        .expect("hosts map mirrors the book");
                    return Ok(Some(WorkspaceHostActivation {
                        route_id,
                        manager: Arc::clone(&host.manager),
                        created: false,
                    }));
                }
                ActivationTarget::Spawn => {
                    let (route_id, manager, created) =
                        self.activate_workspace(&canonical, settings, false)?;
                    return Ok(Some(WorkspaceHostActivation {
                        route_id,
                        manager,
                        created,
                    }));
                }
            }
        }
        if target_key == self.book.active_key {
            return Ok(None);
        }

        if let Some(entry) = self.book.entries.get(&target_key) {
            let route_id = entry.route_id.clone();
            let host = self
                .hosts
                .get(&target_key)
                .expect("hosts map mirrors the book");
            return Ok(Some(WorkspaceHostActivation {
                route_id,
                manager: Arc::clone(&host.manager),
                created: false,
            }));
        }

        let active_busy = renderer_reports_busy
            || host_activity_busy(
                &self
                    .hosts
                    .get(&self.book.active_key)
                    .expect("active HostPool entry must exist")
                    .activity,
            );
        if !should_activate_workspace_host(active_busy, false) {
            return Ok(None);
        }

        let (route_id, manager, created) = self.activate_workspace(&canonical, settings, false)?;
        Ok(Some(WorkspaceHostActivation {
            route_id,
            manager,
            created,
        }))
    }

    /// Re-point the pool at a workspace the ACTIVE Host will serve in place.
    ///
    /// Dedicated mode re-keys the active entry (1:1 entry ↔ workspace).
    /// Shared-host mode instead REGISTERS the workspace on the entry: the
    /// route, entry key and `route_to_key` mapping stay untouched, the target
    /// key joins the entry's bound workspaces, and the canonical path is
    /// returned so the command layer can keep it as the manager's initial
    /// workspace for the next app start.
    pub fn rebind_active_workspace(
        &mut self,
        cwd: &Path,
        shared_host_mode: bool,
    ) -> Result<WorkspaceHostRebind, String> {
        let canonical = canonical_workspace(cwd)?;
        let target_key = workspace_pool_key(&canonical);
        if target_key == self.book.active_key {
            return Ok(WorkspaceHostRebind {
                manager: self.active_manager(),
                canonical_workspace: canonical,
                retired: Vec::new(),
            });
        }
        if shared_host_mode {
            self.book
                .register_workspace_on_active(target_key, canonical.clone());
            return Ok(WorkspaceHostRebind {
                manager: self.active_manager(),
                canonical_workspace: canonical,
                retired: Vec::new(),
            });
        }
        if self.book.entries.contains_key(&target_key) {
            return Err("target workspace already has a Host route".to_string());
        }

        let old_active_key = self.book.active_key.clone();
        let host = self
            .hosts
            .remove(&old_active_key)
            .expect("active HostPool entry must exist");
        let active_manager = Arc::clone(&host.manager);
        self.book
            .rekey_active(target_key.clone(), canonical.clone());
        self.hosts.insert(target_key, host);
        Ok(WorkspaceHostRebind {
            manager: active_manager,
            canonical_workspace: canonical,
            retired: Vec::new(),
        })
    }

    /// Collect Hosts to retire this GC tick:
    /// - base rule: not the active route, no unacknowledged terminal markers,
    ///   no busy sessions, and idle for at least `IDLE_HOST_RETENTION`;
    /// - RSS accelerator (opt-in, `rss_retire_mb > 0`): a background Host idle
    ///   for at least `RSS_PROBE_MIN_IDLE` whose observed child working set
    ///   exceeds the threshold retires early instead of waiting out the full
    ///   retention. Unacknowledged terminal markers pin a Host against both
    ///   rules.
    ///
    /// The probe runs at most once per entry per tick and never blocks: a
    /// manager mutex held by another task simply skips that entry until the
    /// next tick (`try_lock`), so the 60 s GC cadence stays cheap.
    pub fn take_expired_idle_hosts(
        &mut self,
        rss_retire_mb: u32,
    ) -> Vec<Arc<Mutex<PiHostManager>>> {
        let mut expired_keys = self
            .book
            .entries
            .keys()
            .filter_map(|key| {
                let host = self.hosts.get(key)?;
                (key != &self.book.active_key && host_activity_expired(&host.activity))
                    .then_some(key.clone())
            })
            .collect::<Vec<_>>();
        if rss_retire_mb > 0 {
            let threshold_bytes = u64::from(rss_retire_mb) * 1024 * 1024;
            for key in self.book.entries.keys() {
                if key == &self.book.active_key || expired_keys.contains(key) {
                    continue;
                }
                let Some(host) = self.hosts.get(key) else {
                    continue;
                };
                if !host_activity_rss_eligible(&host.activity) {
                    continue;
                }
                let Ok(manager) = host.manager.try_lock() else {
                    continue;
                };
                match manager.probe_child_rss_bytes() {
                    Some(bytes) if bytes > threshold_bytes => {
                        eprintln!(
                            "[piabyss] retiring idle background Host {}: working set {} MiB > {} MiB limit",
                            key,
                            bytes / (1024 * 1024),
                            rss_retire_mb
                        );
                        expired_keys.push(key.clone());
                    }
                    // Quiet probe hits stay silent: the GC ticks every 60 s and
                    // a healthy background Host must not spam the log.
                    _ => {}
                }
            }
        }
        let mut retired = Vec::with_capacity(expired_keys.len());
        for key in expired_keys {
            if let Some(host) = self.hosts.remove(&key) {
                self.book.remove_entry(&key);
                retired.push(host.manager);
            }
        }
        retired
    }

    pub fn set_active_route(&mut self, route_id: &str) -> Result<(), String> {
        self.book.set_active_route(route_id)
    }

    pub async fn update_settings(&self, settings: &DesktopSettingsStore) {
        for host in self.hosts.values() {
            let mut manager = host.manager.lock().await;
            manager.set_agent_dir(settings.resolved_agent_dir());
            manager.set_auto_restart_once(settings.settings.auto_restart_host_once);
            manager.set_plugin_env(settings.settings.plugin_env.clone());
            manager.set_idle_session_policy(
                settings.settings.idle_session_cache_limit,
                settings.settings.idle_session_timeout_minutes,
            );
            manager.set_shared_host_mode(settings.settings.shared_host_mode);
        }
    }

    pub async fn shutdown_all(&self, app_exit: bool) {
        let managers = self
            .hosts
            .values()
            .map(|host| Arc::clone(&host.manager))
            .collect::<Vec<_>>();
        for manager in managers {
            let mut manager = manager.lock().await;
            if app_exit {
                manager.shutdown_for_app_exit().await;
            } else {
                manager.shutdown().await;
            }
        }
    }
}

pub(crate) fn workspace_pool_key(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn canonical_workspace(cwd: &Path) -> Result<PathBuf, String> {
    let canonical = strip_verbatim_prefix(
        cwd.canonicalize()
            .map_err(|error| format!("workspace does not exist: {error}"))?,
    );
    if !canonical.is_dir() {
        return Err("workspace path is not a directory".into());
    }
    Ok(canonical)
}

fn host_activity_busy(activity: &StdMutex<HostActivity>) -> bool {
    !activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .busy_sessions
        .is_empty()
}

/// Pure core of `PiHostPool::activity_snapshot` (unit-testable without a
/// manager). `None` for the bootstrap entry that has no workspace yet.
pub(crate) fn host_activity_snapshot(
    canonical_cwd: &Path,
    workspaces: &[String],
    activity: &StdMutex<HostActivity>,
) -> Option<HostActivitySnapshot> {
    if canonical_cwd.as_os_str().is_empty() {
        return None;
    }
    let activity = activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Some(HostActivitySnapshot {
        cwd: canonical_cwd.to_string_lossy().to_string(),
        cwds: workspaces.to_vec(),
        busy: !activity.busy_sessions.is_empty(),
        // Same attribution chain as terminal markers (session → workspace →
        // cwd); busy sessions whose links are not yet known are skipped.
        busy_sessions: activity
            .busy_sessions
            .iter()
            .filter_map(|session_id| {
                activity
                    .session_workspace
                    .get(session_id)
                    .and_then(|workspace_id| activity.workspace_cwds.get(workspace_id))
                    .map(|cwd| (session_id.clone(), cwd.clone()))
            })
            .collect(),
        has_been_busy: activity.has_been_busy,
        error_count: activity
            .terminal_sessions
            .values()
            .filter(|terminal| terminal.state == "error")
            .count(),
        done_count: activity
            .terminal_sessions
            .values()
            .filter(|terminal| terminal.state == "done")
            .count(),
        terminal_sessions: activity.terminal_sessions.clone(),
    })
}

/// Testable core of `PiHostPool::acknowledge_session_terminal`: clears the
/// unacknowledged terminal marker for one session. Shared with unit tests so
/// the acknowledgement path and the retirement gate stay provably symmetric —
/// both are keyed on the same `terminal_sessions` map.
pub(crate) fn acknowledge_session_terminal_in_activity(
    activity: &StdMutex<HostActivity>,
    session_id: &str,
) -> bool {
    let mut activity = activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    activity.terminal_sessions.remove(session_id).is_some()
}

/// Idle reclamation gate. Hosts with unacknowledged terminal markers (red /
/// gray dots) are pinned: the renderer is still owed the failure/completion
/// signal, and retiring the Host would drop the only snapshot the workspace
/// list uses to rebuild those dots. They are retired only after the user
/// acknowledges (`acknowledge_session_terminal`) — never on idle time alone.
pub(crate) fn host_activity_expired(activity: &StdMutex<HostActivity>) -> bool {
    let activity = activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    activity.terminal_sessions.is_empty()
        && activity.busy_sessions.is_empty()
        && activity.idle_since.elapsed() >= IDLE_HOST_RETENTION
}

fn host_idle_for(activity: &StdMutex<HostActivity>) -> Duration {
    activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .idle_since
        .elapsed()
}

/// Pins shared by BOTH retirement rules. `idle_since` only refreshes on the
/// busy→idle edge, so elapsed time alone cannot prove a Host is quiet: a Host
/// that started a long turn after its last idle window reports a large
/// `host_idle_for` while `busy_sessions` is non-empty. Same for unacked
/// terminal markers — the RSS accelerator must honor the same pin as the base
/// rule, or it would kill running turns and drop unread red/gray dots.
fn host_activity_pinned(activity: &StdMutex<HostActivity>) -> bool {
    let activity = activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    !activity.busy_sessions.is_empty() || !activity.terminal_sessions.is_empty()
}

/// RSS-accelerated retirement gate: same pins as the base rule, but a shorter
/// idle floor (`RSS_PROBE_MIN_IDLE` instead of `IDLE_HOST_RETENTION`).
pub(crate) fn host_activity_rss_eligible(activity: &StdMutex<HostActivity>) -> bool {
    !host_activity_pinned(activity) && host_idle_for(activity) >= RSS_PROBE_MIN_IDLE
}

/// Resolve the workspace cwd a session belongs to: sessionId → workspaceId
/// (recorded from runtime envelopes) → cwd (rebuilt from `host.statusChanged`
/// bindings). `None` while either link is missing — a normal state before the
/// Host's first status broadcast after (re)start.
fn session_workspace_cwd(activity: &HostActivity, session_id: &str) -> Option<String> {
    activity
        .session_workspace
        .get(session_id)
        .and_then(|workspace_id| activity.workspace_cwds.get(workspace_id))
        .cloned()
}

/// `host.statusChanged` broadcast: the payload's `boundWorkspaces` array is
/// the authoritative workspaceId→cwd binding list for this Host, so it is
/// rebuilt wholesale (an empty or missing array clears every binding).
/// Returns whether bindings changed, so the caller refreshes snapshots.
fn observe_host_status_changed(
    activity: &StdMutex<HostActivity>,
    message: &serde_json::Value,
) -> bool {
    let mut activity = activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut rebuilt = HashMap::new();
    if let Some(bound) = message
        .get("payload")
        .and_then(|payload| payload.get("boundWorkspaces"))
        .and_then(|value| value.as_array())
    {
        for binding in bound {
            let (Some(workspace_id), Some(cwd)) = (
                binding.get("workspaceId").and_then(|value| value.as_str()),
                binding.get("cwd").and_then(|value| value.as_str()),
            ) else {
                continue;
            };
            rebuilt.insert(workspace_id.to_string(), cwd.to_string());
        }
    }
    let changed = rebuilt != activity.workspace_cwds;
    activity.workspace_cwds = rebuilt;
    changed
}

pub(crate) fn observe_host_activity(activity: &StdMutex<HostActivity>, line: &str) -> bool {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    match message.get("event").and_then(|value| value.as_str()) {
        Some("host.statusChanged") => {
            return observe_host_status_changed(activity, &message);
        }
        Some("session.runtimeChanged") => {}
        _ => return false,
    }
    let Some(session_id) = message
        .get("payload")
        .and_then(|payload| payload.get("sessionId"))
        .and_then(|value| value.as_str())
    else {
        return false;
    };
    let Some(state) = message
        .get("payload")
        .and_then(|payload| payload.get("state"))
        .and_then(|value| value.as_str())
    else {
        return false;
    };
    let mut activity = activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Shared hosts interleave several workspaces' events on one stdout
    // stream, so record which workspace this session belongs to — busy
    // sessions and terminal markers are attributed through it.
    if let Some(workspace_id) = message.get("workspaceId").and_then(|value| value.as_str()) {
        activity
            .session_workspace
            .insert(session_id.to_string(), workspace_id.to_string());
    }
    let was_busy = !activity.busy_sessions.is_empty();
    let mut changed = false;
    match state {
        "starting" | "running" | "queued" => {
            changed = activity.busy_sessions.insert(session_id.to_string());
            activity.has_been_busy = true;
            // A new run supersedes any stale unacknowledged terminal marker.
            changed |= activity.terminal_sessions.remove(session_id).is_some();
            activity
                .last_state
                .insert(session_id.to_string(), state.to_string());
        }
        "error" => {
            changed = activity.busy_sessions.remove(session_id);
            let terminal_changed = activity
                .terminal_sessions
                .get(session_id)
                .map(|terminal| terminal.state.as_str())
                != Some("error");
            if terminal_changed {
                activity.next_terminal_generation += 1;
                let generation = activity.next_terminal_generation;
                let workspace_cwd = session_workspace_cwd(&activity, session_id);
                activity.terminal_sessions.insert(
                    session_id.to_string(),
                    HostTerminalActivity {
                        state: "error".to_string(),
                        generation,
                        workspace_cwd,
                    },
                );
                changed = true;
            }
            activity
                .last_state
                .insert(session_id.to_string(), "error".to_string());
        }
        "idle" => {
            changed = activity.busy_sessions.remove(session_id);
            // Only a real busy→idle completion (a session that actually ran)
            // creates the done marker; plain idle announcements for restored
            // sessions never ran and must stay quiet.
            let was_running = matches!(
                activity
                    .last_state
                    .get(session_id)
                    .map(|state| state.as_str()),
                Some("starting" | "running" | "queued")
            );
            if was_running {
                activity.next_terminal_generation += 1;
                let generation = activity.next_terminal_generation;
                let workspace_cwd = session_workspace_cwd(&activity, session_id);
                activity.terminal_sessions.insert(
                    session_id.to_string(),
                    HostTerminalActivity {
                        state: "done".to_string(),
                        generation,
                        workspace_cwd,
                    },
                );
                changed = true;
            }
            activity
                .last_state
                .insert(session_id.to_string(), "idle".to_string());
        }
        _ => {}
    }
    let now_busy = !activity.busy_sessions.is_empty();
    if was_busy && !now_busy {
        activity.idle_since = Instant::now();
    }
    changed
}

/// Drop every busy marker when a Host process exits. Sessions the dead
/// process reported as busy will never emit the settle event that would
/// normally clear them, so without this the workspace list's green dot
/// sticks forever after a crash or host restart. `has_been_busy` is kept
/// so "all sessions finished" still reads as the muted dot.
fn clear_host_activity(activity: &StdMutex<HostActivity>) -> bool {
    let mut activity = activity
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if activity.busy_sessions.is_empty() {
        return false;
    }
    activity.busy_sessions.clear();
    true
}

pub(crate) fn should_activate_workspace_host(active_busy: bool, target_exists: bool) -> bool {
    active_busy || target_exists
}

#[cfg(test)]
mod host_activity_tests {
    use super::*;

    fn runtime_line(session_id: &str, state: &str) -> String {
        serde_json::json!({
            "event": "session.runtimeChanged",
            "payload": { "sessionId": session_id, "state": state }
        })
        .to_string()
    }

    #[test]
    fn tracks_concurrent_sessions_until_the_last_one_settles() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("b", "queued")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        assert!(host_activity_busy(&activity));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("b", "error")
        ));
        assert!(!host_activity_busy(&activity));
    }

    #[test]
    fn repeated_settle_reports_are_no_ops() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        // A second idle for the same session changes nothing.
        assert!(!observe_host_activity(
            &activity,
            &runtime_line("a", "idle")
        ));
    }

    #[test]
    fn remembers_that_sessions_have_run_after_settling() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(!host_activity_busy(&activity));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        assert!(!host_activity_busy(&activity));
        let seen = activity.lock().expect("activity lock");
        assert!(seen.has_been_busy);
    }

    #[test]
    fn never_busy_stays_unseen() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(!observe_host_activity(
            &activity,
            &runtime_line("a", "idle")
        ));
        let seen = activity.lock().expect("activity lock");
        assert!(!seen.has_been_busy);
    }

    #[test]
    fn idle_only_marks_sessions_that_actually_ran_as_done() {
        let activity = StdMutex::new(HostActivity::default());
        // A restored session that never ran announces idle → no marker.
        assert!(!observe_host_activity(
            &activity,
            &runtime_line("a", "idle")
        ));
        // A session that ran then settled → done marker (gray dot).
        assert!(observe_host_activity(
            &activity,
            &runtime_line("b", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("b", "idle")));
        let seen = activity.lock().expect("activity lock");
        assert!(!seen.terminal_sessions.contains_key("a"));
        assert_eq!(
            seen.terminal_sessions
                .get("b")
                .map(|terminal| terminal.state.as_str()),
            Some("done")
        );
    }

    #[test]
    fn a_new_run_clears_a_stale_terminal_marker() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        let first_generation = activity
            .lock()
            .expect("activity lock")
            .terminal_sessions
            .get("a")
            .expect("done marker")
            .generation;
        // The session runs again — the previous done marker must go away.
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(!activity
            .lock()
            .expect("activity lock")
            .terminal_sessions
            .contains_key("a"));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        let seen = activity.lock().expect("activity lock");
        assert!(seen.terminal_sessions["a"].generation > first_generation);
    }

    #[test]
    fn error_marker_survives_a_following_idle_announcement() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "error")
        ));
        // The settle-to-idle transition keeps the red marker.
        let _ = observe_host_activity(&activity, &runtime_line("a", "idle"));
        let seen = activity.lock().expect("activity lock");
        assert_eq!(
            seen.terminal_sessions
                .get("a")
                .map(|terminal| terminal.state.as_str()),
            Some("error")
        );
    }

    #[test]
    fn expires_only_after_thirty_idle_minutes() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(!host_activity_expired(&activity));
        activity.lock().expect("activity lock").idle_since =
            Instant::now() - (IDLE_HOST_RETENTION - Duration::from_secs(1));
        assert!(!host_activity_expired(&activity));
        activity.lock().expect("activity lock").idle_since = Instant::now() - IDLE_HOST_RETENTION;
        assert!(host_activity_expired(&activity));
    }

    #[test]
    fn process_exit_clears_stale_busy_markers() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(host_activity_busy(&activity));
        // The Host died before "a" settled — its green dot must not stick.
        assert!(clear_host_activity(&activity));
        assert!(!host_activity_busy(&activity));
        // has_been_busy survives so the workspace still shows the muted dot.
        assert!(activity.lock().expect("activity lock").has_been_busy);
        // Clearing an already-empty set is a no-op.
        assert!(!clear_host_activity(&activity));
    }

    #[test]
    fn process_exit_after_all_sessions_settled_changes_nothing() {
        let activity = StdMutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        assert!(!clear_host_activity(&activity));
        assert!(!host_activity_busy(&activity));
    }

    #[test]
    fn activates_only_for_busy_or_already_allocated_workspaces() {
        assert!(!should_activate_workspace_host(false, false));
        assert!(should_activate_workspace_host(true, false));
        assert!(should_activate_workspace_host(false, true));
    }
}

impl PiHostManager {
    fn emit_stdout(&self, line: String) {
        let _ = self.app.emit(
            "pi-host-stdout",
            HostTransportFrame {
                route_id: self.route_id.clone(),
                line,
            },
        );
    }
}

/// Pure policy for one-shot auto-restart (unit-testable without Tauri).
pub fn should_auto_restart(auto_restart_once: bool, restart_count: u32) -> bool {
    auto_restart_once && restart_count == 0
}

pub fn is_current_child_generation(current: u32, captured: u32) -> bool {
    current == captured
}

pub(crate) async fn finish_monitor_task(slot: &mut Option<JoinHandle<()>>) {
    let Some(mut handle) = slot.take() else {
        return;
    };
    if tokio::time::timeout(std::time::Duration::from_secs(2), &mut handle)
        .await
        .is_err()
    {
        handle.abort();
        let _ = handle.await;
    }
}

/// Shared restart epoch state used by PiHostManager and tests.
#[derive(Debug, Clone)]
#[allow(dead_code)] // exercised by unit tests + PiHostManager restart path
pub struct AutoRestartEpoch {
    pub auto_restart_once: bool,
    pub restart_count: u32,
    pub armed: bool,
}

impl AutoRestartEpoch {
    #[cfg(test)]
    pub fn new(auto_restart_once: bool) -> Self {
        Self {
            auto_restart_once,
            restart_count: 0,
            armed: true,
        }
    }

    /// On unexpected child exit: returns whether to auto-restart once.
    pub fn on_unexpected_exit(&mut self) -> bool {
        if should_auto_restart(self.auto_restart_once, self.restart_count) && self.armed {
            self.armed = false;
            self.restart_count = self.restart_count.saturating_add(1);
            true
        } else {
            false
        }
    }

    /// Manual restart begins a new epoch.
    pub fn on_manual_restart(&mut self) {
        self.restart_count = 0;
        self.armed = true;
    }
}

/// Build typed system.shutdown request line with exact hostInstanceId (never "*").
pub fn build_shutdown_line(host_instance_id: &str, request_id: &str) -> String {
    format!(
        r#"{{"protocolVersion":1,"id":"{request_id}","method":"system.shutdown","context":{{"expectedHostInstanceId":"{host_instance_id}"}},"params":null}}"#
    )
}

/// Split stdout stream into complete lines (same buffering logic as PiHostManager reader).
#[cfg(test)]
pub fn drain_complete_lines(buffer: &mut String, chunk: &str) -> Vec<String> {
    buffer.push_str(chunk);
    let mut lines = Vec::new();
    while let Some(idx) = buffer.find('\n') {
        let mut line = buffer[..idx].to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        buffer.drain(..=idx);
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

/// Bound stderr ring buffer (matches PiHostManager 50-line cap).
pub fn push_stderr_tail(logs: &mut Vec<String>, line: String, max: usize) {
    logs.push(line);
    if logs.len() > max {
        let drain = logs.len() - max;
        logs.drain(0..drain);
    }
}

/// Joins the newest `max` stderr lines (oldest-first) for error reporting.
/// The exit cause lives at the END of the ring; joining the whole buffer and
/// then truncating from the head surfaces stale startup noise instead.
pub fn stderr_tail_joined(logs: &[String], max: usize) -> String {
    let mut tail: Vec<String> = logs.iter().rev().take(max).cloned().collect();
    tail.reverse();
    tail.join(" | ")
}

/// Testable Host child session — process protocol used by PiHostManager.
/// Unit tests drive this type directly (no Tauri AppHandle required).
#[cfg(test)]
pub struct HostChildSession {
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
    stdout: Option<std::io::BufReader<std::process::ChildStdout>>,
    pub host_instance_id: Option<String>,
    pub restart: AutoRestartEpoch,
    pub shutting_down: bool,
    #[cfg(unix)]
    unix_process_group: Option<UnixHostProcessGroup>,
}

#[cfg(test)]
impl HostChildSession {
    pub fn spawn_node_script(script: &str, auto_restart_once: bool) -> Result<Self, String> {
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".into());
        let mut command = std::process::Command::new(node);
        command
            .arg("-e")
            .arg(script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        configure_unix_host_command(&mut command);
        let mut child = command.spawn().map_err(|e| format!("spawn fixture: {e}"))?;
        #[cfg(unix)]
        let unix_process_group = match UnixHostProcessGroup::from_child_id(Some(child.id())) {
            Ok(group) => group,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().map(std::io::BufReader::new);
        Ok(Self {
            child: Some(child),
            stdin,
            stdout,
            host_instance_id: None,
            restart: AutoRestartEpoch::new(auto_restart_once),
            shutting_down: false,
            #[cfg(unix)]
            unix_process_group: Some(unix_process_group),
        })
    }

    pub fn read_line_timeout(&mut self, timeout: std::time::Duration) -> Result<String, String> {
        use std::io::BufRead;
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if let Some(reader) = self.stdout.as_mut() {
                let mut line = String::new();
                // Blocking read — fixtures write promptly
                match reader.read_line(&mut line) {
                    Ok(0) => return Err("stdout closed".into()),
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if trimmed.contains("\"event\":\"host.ready\"")
                            || trimmed.contains("\"event\": \"host.ready\"")
                        {
                            if let Some(id) = extract_host_instance_id(&trimmed) {
                                self.host_instance_id = Some(id);
                            }
                        }
                        return Ok(trimmed);
                    }
                    Err(e) => return Err(format!("read stdout: {e}")),
                }
            } else {
                return Err("no stdout".into());
            }
        }
        Err("timeout waiting for line".into())
    }

    pub fn wait_ready(&mut self, timeout: std::time::Duration) -> Result<String, String> {
        let line = self.read_line_timeout(timeout)?;
        if !line.contains("host.ready") {
            return Err(format!("expected host.ready, got {line}"));
        }
        Ok(line)
    }

    pub fn send_line(&mut self, line: &str) -> Result<(), String> {
        use std::io::Write;
        let stdin = self.stdin.as_mut().ok_or("no stdin")?;
        let payload = if line.ends_with('\n') {
            line.to_string()
        } else {
            format!("{line}\n")
        };
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("write: {e}"))?;
        stdin.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    pub fn shutdown_exact(&mut self) -> Result<(), String> {
        self.shutting_down = true;
        let host_id = self
            .host_instance_id
            .clone()
            .unwrap_or_else(|| "unknown".into());
        let line = build_shutdown_line(&host_id, "shutdown");
        #[cfg(unix)]
        let unix_process_group = self.unix_process_group.take();
        #[cfg(unix)]
        let mut group_cleanup = unix_process_group
            .as_ref()
            .and_then(UnixHostProcessGroup::claim_cleanup);
        let send_error = self.send_line(&line).err();
        let mut wait_error = None;
        if let Some(mut child) = self.child.take() {
            let start = std::time::Instant::now();
            let mut needs_force = send_error.is_some();
            if !needs_force {
                loop {
                    #[cfg(unix)]
                    let exit_probe = unix_child_exited_without_reaping(Some(child.id()));
                    #[cfg(not(unix))]
                    let exit_probe = child
                        .try_wait()
                        .map(|status| status.is_some())
                        .map_err(|error| format!("wait: {error}"));
                    match exit_probe {
                        Ok(true) => break,
                        Ok(false) if start.elapsed() > std::time::Duration::from_secs(5) => {
                            needs_force = true;
                            break;
                        }
                        Ok(false) => std::thread::sleep(std::time::Duration::from_millis(20)),
                        Err(error) => {
                            wait_error = Some(error);
                            needs_force = true;
                            break;
                        }
                    }
                }
            }
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                cleanup.terminate_blocking();
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled_blocking();
            }
            if needs_force {
                let _ = child.kill();
            }
            if let Err(error) = child.wait() {
                wait_error.get_or_insert_with(|| format!("wait: {error}"));
            }
        } else {
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                cleanup.terminate_blocking();
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled_blocking();
            }
        }
        self.stdin = None;
        self.stdout = None;
        if let Some(error) = send_error.or(wait_error) {
            return Err(error);
        }
        Ok(())
    }

    pub fn kill_and_reap(&mut self) -> Result<std::process::ExitStatus, String> {
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            child.wait().map_err(|e| format!("reap: {e}"))
        } else {
            Err("no child".into())
        }
    }

    /// Simulate unexpected exit handling (same policy as PiHostManager stdout-close path).
    pub fn on_unexpected_exit(&mut self) -> bool {
        if self.shutting_down {
            return false;
        }
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.restart.on_unexpected_exit()
    }

    #[cfg(all(test, unix))]
    pub(crate) fn claim_unix_group_cleanup_for_test(&self) -> Option<UnixHostGroupCleanup> {
        self.unix_process_group.as_ref()?.claim_cleanup()
    }
}

#[cfg(test)]
impl Drop for HostChildSession {
    fn drop(&mut self) {
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl PiHostManager {
    pub fn new(app: AppHandle, settings: &DesktopSettingsStore) -> Self {
        Self::new_routed(app, settings, "primary".into(), None)
    }

    pub fn new_routed(
        app: AppHandle,
        settings: &DesktopSettingsStore,
        route_id: String,
        initial_workspace: Option<PathBuf>,
    ) -> Self {
        Self {
            app,
            route_id,
            child: None,
            stdin: None,
            agent_dir: settings.resolved_agent_dir(),
            initial_workspace: initial_workspace.or_else(|| Self::initial_workspace_from(settings)),
            plugin_env: settings.settings.plugin_env.clone(),
            idle_session_cache_limit: settings.settings.idle_session_cache_limit,
            idle_session_timeout_minutes: settings.settings.idle_session_timeout_minutes,
            shared_host_mode: settings.settings.shared_host_mode,
            restart_count: Arc::new(AtomicU32::new(0)),
            auto_restart_once: settings.settings.auto_restart_host_once,
            shutting_down: Arc::new(AtomicBool::new(false)),
            last_stderr: Arc::new(Mutex::new(Vec::new())),
            last_ready_line: Arc::new(Mutex::new(None)),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            activity: Arc::new(StdMutex::new(HostActivity::default())),
            host_instance_id: None,
            auto_restart_armed: Arc::new(AtomicBool::new(true)),
            child_generation: Arc::new(AtomicU32::new(0)),
            stdout_task: None,
            stderr_task: None,
            #[cfg(windows)]
            windows_job: None,
            #[cfg(unix)]
            unix_process_group: None,
        }
    }

    pub fn route_id(&self) -> &str {
        &self.route_id
    }

    /// Replay the last `host.ready` line to a renderer that attached late (e.g.
    /// after a window reload) and therefore missed the live event. Best-effort:
    /// on a cold start the Host is still booting, so there is nothing to replay
    /// yet — the live `host.ready` line arrives on the stdout stream shortly.
    /// Only a process that is already gone is a hard failure worth surfacing.
    pub async fn replay_ready_event(&mut self) -> Result<(), String> {
        if let Some(line) = self.last_ready_line.lock().await.clone() {
            self.emit_stdout(line);
            return Ok(());
        }
        if self.is_running() {
            Ok(())
        } else {
            Err("Host has not announced ready yet".to_string())
        }
    }

    pub fn set_agent_dir(&mut self, dir: PathBuf) {
        self.agent_dir = dir;
    }

    pub fn set_plugin_env(&mut self, plugin_env: BTreeMap<String, BTreeMap<String, String>>) {
        self.plugin_env = plugin_env;
    }

    pub fn set_idle_session_policy(&mut self, limit: u32, timeout_minutes: u32) {
        self.idle_session_cache_limit = limit;
        self.idle_session_timeout_minutes = timeout_minutes;
    }

    pub fn set_shared_host_mode(&mut self, shared: bool) {
        self.shared_host_mode = shared;
    }

    pub fn set_initial_workspace_path(&mut self, path: PathBuf) {
        self.initial_workspace = Some(path);
    }

    fn initial_workspace_from(settings: &DesktopSettingsStore) -> Option<PathBuf> {
        settings
            .settings
            .default_workspace
            .clone()
            .or_else(|| settings.settings.last_workspace.clone())
            .map(PathBuf::from)
    }

    pub fn set_initial_workspace(&mut self, settings: &DesktopSettingsStore) {
        self.initial_workspace = Self::initial_workspace_from(settings);
    }

    pub fn set_auto_restart_once(&mut self, v: bool) {
        self.auto_restart_once = v;
    }

    pub fn host_instance_id(&self) -> Option<&str> {
        self.host_instance_id.as_deref()
    }

    /// Working-set size of the Host child process, when observable. Returns
    /// `None` when no child is running, the handle is gone, or the OS query
    /// fails — callers must treat "unknown" as "keep the base retention rule".
    /// Cheap single syscall, safe to call once per GC tick per entry.
    #[cfg(windows)]
    pub(crate) fn probe_child_rss_bytes(&self) -> Option<u64> {
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        let handle = self.child.as_ref()?.raw_handle()?;
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        // SAFETY: `handle` is the live process handle owned by the child and
        // `counters` is a valid, correctly sized buffer for this query.
        if unsafe { GetProcessMemoryInfo(handle, &mut counters, counters.cb) } == 0 {
            return None;
        }
        Some(counters.WorkingSetSize as u64)
    }

    /// Non-Windows: no cheap child-RSS probe wired up yet (would need sysinfo
    /// or procfs); RSS-aware retirement stays a Windows accelerator until a
    /// platform port is needed.
    #[cfg(not(windows))]
    pub(crate) fn probe_child_rss_bytes(&self) -> Option<u64> {
        None
    }

    pub fn restart_count(&self) -> u32 {
        self.restart_count.load(Ordering::SeqCst)
    }

    pub fn note_host_ready_identity(&mut self, host_instance_id: String) {
        self.host_instance_id = Some(host_instance_id);
        // Stable ready: keep restart_count for epoch, re-arm is epoch-scoped
    }

    fn resolve_node(app: &AppHandle) -> Result<PathBuf, String> {
        // Release: only bundled runtime under resource_dir / next to exe — no PATH/global.
        // Tauri's resource_dir derives from a canonicalized exe path, which on
        // Windows is a \\?\ verbatim path. node.exe itself launches fine with
        // it, but the runtime directory also feeds the Host's controlled PATH,
        // where cmd.exe (npm.cmd and any batch shim) cannot resolve \\?\ paths
        // — npm installs then fail with "The system cannot find the path
        // specified". Always hand out stripped paths.
        if let Ok(res_dir) = app.path().resource_dir() {
            for candidate in node_runtime_candidates(&res_dir) {
                if is_executable_file(&candidate) {
                    return Ok(strip_verbatim_prefix(candidate));
                }
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in node_runtime_candidates(dir) {
                    if is_executable_file(&candidate) {
                        return Ok(strip_verbatim_prefix(candidate));
                    }
                }
            }
        }

        // Dev only: PATH / monorepo tooling
        #[cfg(debug_assertions)]
        {
            if let Ok(path) = which_node() {
                return Ok(path);
            }
            Ok(PathBuf::from(if cfg!(windows) {
                "node.exe"
            } else {
                "node"
            }))
        }

        #[cfg(not(debug_assertions))]
        {
            Err(
                "Release build: bundled Node not found under resource_dir. Re-run package:sidecar:with-node / prepare:runtime."
                    .into(),
            )
        }
    }

    #[cfg(not(windows))]
    fn resolve_portable_git(_app: &AppHandle) -> Result<Option<PathBuf>, String> {
        Ok(None)
    }

    #[cfg(windows)]
    fn resolve_portable_git(app: &AppHandle) -> Result<Option<PathBuf>, String> {
        let mut candidates = Vec::new();
        if let Ok(res_dir) = app.path().resource_dir() {
            candidates.push(res_dir.join("git").join("cmd"));
            candidates.push(res_dir.join("resources").join("git").join("cmd"));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("git").join("cmd"));
                candidates.push(dir.join("resources").join("git").join("cmd"));
            }
        }
        for candidate in candidates {
            if candidate.join("git.exe").exists() {
                // Same \\?\ concern as resolve_node: these directories go on
                // the Host's controlled PATH, which cmd.exe must understand.
                return Ok(Some(strip_verbatim_prefix(candidate)));
            }
        }

        if cfg!(debug_assertions) {
            Ok(None)
        } else {
            Err("Release build: bundled Portable Git not found under resource_dir. Re-run prepare:runtime.".into())
        }
    }

    /// Portable Git layout: `<root>/cmd/git.exe` → `<root>/bin/bash.exe`.
    /// The result is stripped of `\\?\` so later spawn sites can use it.
    pub(crate) fn bundled_bash_from_git(git_exe: &Path) -> Option<PathBuf> {
        let cmd_dir = git_exe.parent()?;
        let cmd_name = cmd_dir.file_name()?.to_str()?;
        if !cmd_name.eq_ignore_ascii_case("cmd") {
            return None;
        }
        let bash = cmd_dir.parent()?.join("bin").join("bash.exe");
        if bash.is_file() {
            Some(strip_verbatim_prefix(bash))
        } else {
            None
        }
    }

    fn resolve_host_entry(app: &AppHandle) -> Result<PathBuf, String> {
        // Dev first: monorepo built host (most reliable during tauri:dev)
        #[cfg(debug_assertions)]
        {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let dev_entry = manifest.join("../../../packages/pi-host/dist/main.js");
            if dev_entry.exists() {
                return Ok(canonicalize_path(dev_entry));
            }
            let staged = manifest.join("resources/pi-host/main.js");
            if staged.exists() && staged_host_is_runnable(&staged) {
                return Ok(canonicalize_path(staged));
            }
            let dev_src = manifest.join("../../../packages/pi-host/src/main.ts");
            if dev_src.exists() {
                return Ok(canonicalize_path(dev_src));
            }
        }

        // Release: only resource_dir — no monorepo fallback
        if let Ok(res_dir) = app.path().resource_dir() {
            for candidate in [
                res_dir.join("pi-host").join("main.js"),
                res_dir.join("pi-host").join("dist").join("main.js"),
                res_dir.join("resources").join("pi-host").join("main.js"),
            ] {
                if candidate.exists() {
                    return Ok(canonicalize_path(candidate));
                }
            }
        }

        Err(
            "Pi Host entry not found. Dev: run `pnpm build`. Release: stage resources via package:sidecar:with-node."
                .into(),
        )
    }

    pub async fn begin_start(&mut self) -> Result<PendingStart, String> {
        // Ensure previous instance is gone
        if self.child.is_some() {
            self.shutdown().await;
        } else {
            self.join_monitor_tasks().await;
        }

        let child_generation = self.child_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.shutting_down.store(false, Ordering::SeqCst);
        *self
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = HostActivity::default();
        {
            let mut logs = self.last_stderr.lock().await;
            logs.clear();
        }

        let node = Self::resolve_node(&self.app)?;
        let portable_git_cmd = Self::resolve_portable_git(&self.app)?;
        let entry = Self::resolve_host_entry(&self.app)?;
        let agent_dir = self.agent_dir.clone();
        let host_cache_dir = strip_verbatim_prefix(
            self.app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("resolve app cache directory: {e}"))?
                .join("pi-host"),
        );
        let work_dir = entry
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        // Ensure agentDir exists before spawn
        std::fs::create_dir_all(&agent_dir)
            .map_err(|e| format!("create agentDir {}: {e}", agent_dir.display()))?;
        std::fs::create_dir_all(&host_cache_dir).map_err(|e| {
            format!(
                "create Pi Host cache directory {}: {e}",
                host_cache_dir.display()
            )
        })?;

        eprintln!(
            "[piabyss] starting host node={} entry={} cwd={} agentDir={} cacheDir={}",
            node.display(),
            entry.display(),
            work_dir.display(),
            agent_dir.display(),
            host_cache_dir.display()
        );

        let mut cmd = Command::new(&node);
        if entry.extension().and_then(|e| e.to_str()) == Some("ts") {
            // Dev TypeScript entry — requires tsx resolvable from monorepo
            cmd.arg("--import").arg("tsx").arg(&entry);
            // Prefer monorepo root for tsx resolution
            let monorepo_host =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/pi-host");
            if monorepo_host.exists() {
                cmd.current_dir(canonicalize_path(monorepo_host));
            } else {
                cmd.current_dir(&work_dir);
            }
        } else {
            cmd.arg(&entry);
            cmd.current_dir(&work_dir);
        }
        cmd.arg(format!("--agent-dir={}", agent_dir.display()));
        if let Some(ws) = self.initial_workspace.as_ref() {
            if ws.is_dir() {
                cmd.arg(format!("--initial-cwd={}", ws.display()));
            }
        }
        cmd.env("PI_CODING_AGENT_DIR", &agent_dir);
        cmd.env("PIABYSS_HOST_CACHE_DIR", &host_cache_dir);
        cmd.env(
            "PIABYSS_IDLE_SESSION_CACHE_LIMIT",
            self.idle_session_cache_limit.to_string(),
        );
        cmd.env(
            "PIABYSS_IDLE_SESSION_TIMEOUT_MINUTES",
            self.idle_session_timeout_minutes.to_string(),
        );
        if self.shared_host_mode && std::env::var_os("PIABYSS_MAX_BOUND_WORKSPACES").is_none() {
            // Shared-host mode keeps every workspace graph bound for instant
            // in-place return (the Host clamps to 1..20). An explicit env set
            // by the launcher wins over this default.
            cmd.env("PIABYSS_MAX_BOUND_WORKSPACES", "10");
        }
        // Reserved names belong to the launcher; plugin config must not shadow them.
        const RESERVED_ENV: [&str; 11] = [
            "PATH",
            "NODE_PATH",
            "NODE",
            "PI_CODING_AGENT_DIR",
            "PIABYSS_HOST_CACHE_DIR",
            "PIABYSS_IDLE_SESSION_CACHE_LIMIT",
            "PIABYSS_IDLE_SESSION_TIMEOUT_MINUTES",
            "PIABYSS_MAX_BOUND_WORKSPACES",
            "PIABYSS_BUNDLED_NODE",
            "PIABYSS_BUNDLED_GIT",
            "PIABYSS_BUNDLED_BASH",
        ];
        for vars in self.plugin_env.values() {
            for (name, value) in vars {
                if !RESERVED_ENV.contains(&name.as_str()) {
                    cmd.env(name, value);
                }
            }
        }

        // Host inherits the desktop user PATH so Agent Bash and internal
        // children see the user's own environment (mise, nvm, system git, …).
        // Bundled Node/Git dirs are appended as a fallback only, and the
        // exact bundled executables are advertised via PIABYSS_BUNDLED_* so the
        // Host can use them without depending on PATH placement.
        let host_path = build_host_path(
            std::env::var_os("PATH").as_deref(),
            node.parent(),
            portable_git_cmd.as_deref(),
            std::env::var("SystemRoot").ok().as_deref(),
        )?;
        cmd.env("PATH", host_path);

        // Explicit bundled runtime descriptors for internal children.
        cmd.env("PIABYSS_BUNDLED_NODE", &node);
        if let Some(git_cmd) = portable_git_cmd.as_ref() {
            let git_exe = git_cmd.join("git.exe");
            cmd.env("PIABYSS_BUNDLED_GIT", &git_exe);
            if let Some(bash) = Self::bundled_bash_from_git(&git_exe) {
                cmd.env("PIABYSS_BUNDLED_BASH", bash);
            }
        }

        // Help Node resolve monorepo deps when running dist from packages/pi-host
        if let Some(host_pkg) = entry.parent().and_then(|p| p.parent()) {
            // packages/pi-host/dist -> packages/pi-host
            let nm = host_pkg.join("node_modules");
            if nm.exists() {
                cmd.env("NODE_PATH", nm);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Do NOT use kill_on_drop — premature drops were killing the host mid-handshake on Windows.

        #[cfg(windows)]
        {
            // Avoid flashing a console window under the GUI host
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        #[cfg(unix)]
        configure_unix_host_command(cmd.as_std_mut());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn host failed (node={}): {e}", node.display()))?;

        #[cfg(unix)]
        let unix_process_group = match UnixHostProcessGroup::from_child_id(child.id()) {
            Ok(group) => group,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };

        #[cfg(windows)]
        let windows_job = match WindowsHostJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdin = Arc::new(Mutex::new(stdin));

        let stderr_buf = Arc::clone(&self.last_stderr);
        let app_err = self.app.clone();
        let stderr_route_id = self.route_id.clone();
        let stderr_generation = Arc::clone(&self.child_generation);
        self.stderr_task = Some(tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                match read_bounded_lossy_line(&mut reader, &mut line, MAX_HOST_STDERR_LINE_BYTES)
                    .await
                {
                    Ok(0) => break,
                    Ok(_) => {
                        if !is_current_child_generation(
                            stderr_generation.load(Ordering::SeqCst),
                            child_generation,
                        ) {
                            break;
                        }
                        let trimmed = line.trim_end().to_string();
                        {
                            let mut logs = stderr_buf.lock().await;
                            push_stderr_tail(&mut logs, trimmed.clone(), 50);
                        }
                        eprintln!("[pi-host] {trimmed}");
                        let _ = app_err.emit(
                            "pi-host-stderr",
                            HostTransportFrame {
                                route_id: stderr_route_id.clone(),
                                line: trimmed,
                            },
                        );
                    }
                    Err(error) if is_host_line_too_long(&error) => {
                        let message = format!("Pi Host stderr line truncated: {error}");
                        {
                            let mut logs = stderr_buf.lock().await;
                            push_stderr_tail(&mut logs, message.clone(), 50);
                        }
                        eprintln!("[piabyss] {message}");
                        let _ = app_err.emit(
                            "pi-host-stderr",
                            HostTransportFrame {
                                route_id: stderr_route_id.clone(),
                                line: message,
                            },
                        );
                        continue;
                    }
                    Err(error) => {
                        let message = format!("Pi Host stderr transport read failed: {error}");
                        {
                            let mut logs = stderr_buf.lock().await;
                            push_stderr_tail(&mut logs, message.clone(), 50);
                        }
                        eprintln!("[piabyss] {message}");
                        let _ = app_err.emit(
                            "pi-host-stderr",
                            HostTransportFrame {
                                route_id: stderr_route_id.clone(),
                                line: message,
                            },
                        );
                        break;
                    }
                }
            }
        }));

        // Wait until host.ready or process exit (fail fast with stderr)
        let (ready_tx, ready_rx) =
            tokio::sync::oneshot::channel::<Result<Option<String>, String>>();
        let ready_tx = Arc::new(Mutex::new(Some(ready_tx)));
        let app_out = self.app.clone();
        let stdout_route_id = self.route_id.clone();
        let last_ready_line = Arc::clone(&self.last_ready_line);
        let activity = Arc::clone(&self.activity);
        let stderr_for_exit = Arc::clone(&self.last_stderr);
        let shutting_down = Arc::clone(&self.shutting_down);
        let restart_count = Arc::clone(&self.restart_count);
        let auto_restart_armed = Arc::clone(&self.auto_restart_armed);
        let auto_restart_once = self.auto_restart_once;
        let app_for_restart = self.app.clone();
        let stdout_generation = Arc::clone(&self.child_generation);
        let pending_requests = Arc::clone(&self.pending_requests);
        #[cfg(unix)]
        let unix_process_group_for_monitor = unix_process_group.clone();

        {
            let ready_tx = Arc::clone(&ready_tx);
            self.stdout_task = Some(tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                let mut read_failure = None;
                loop {
                    match read_bounded_utf8_line(&mut reader, &mut line, MAX_HOST_STDOUT_LINE_BYTES)
                        .await
                    {
                        Ok(0) => break,
                        Ok(_) => {
                            if !is_current_child_generation(
                                stdout_generation.load(Ordering::SeqCst),
                                child_generation,
                            ) {
                                break;
                            }
                            let payload = line.trim_end_matches(['\r', '\n']).to_string();
                            // Resolve any in-flight Rust-side request awaiting this id
                            // (background workspace bootstrap), independent of renderer
                            // active-route filtering.
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) {
                                if let Some(id) = value.get("id").and_then(|x| x.as_str()) {
                                    if let Some(tx) = pending_requests.lock().await.remove(id) {
                                        let _ = tx.send(payload.clone());
                                    }
                                }
                            }
                            if observe_host_activity(&activity, &payload) {
                                // Busy set changed (a session started or the last
                                // one settled) — tell the renderer to re-read the
                                // workspace activity snapshot. Background Hosts do
                                // not route their stdout, so this is the only live
                                // signal for other workspaces' status.
                                let _ = app_out.emit("pi-host-activity", stdout_route_id.clone());
                            }
                            if payload.contains("\"event\":\"host.ready\"")
                                || payload.contains("\"event\": \"host.ready\"")
                            {
                                *last_ready_line.lock().await = Some(payload.clone());
                                let hid = extract_host_instance_id(&payload);
                                if let Some(tx) = ready_tx.lock().await.take() {
                                    let _ = tx.send(Ok(hid));
                                }
                            }
                            let is_hello_response = payload.contains("\"method\":\"system.hello\"");
                            let emitted = app_out.emit(
                                "pi-host-stdout",
                                HostTransportFrame {
                                    route_id: stdout_route_id.clone(),
                                    line: payload,
                                },
                            );
                            if is_hello_response {
                                eprintln!(
                                    "[piabyss] system.hello response emitted to WebView: {}",
                                    emitted.is_ok()
                                );
                            }
                        }
                        Err(error) if is_host_line_too_long(&error) => {
                            let message = format!("Pi Host stdout frame dropped: {error}");
                            eprintln!("[piabyss] {message}");
                            let _ = app_out.emit(
                                "pi-host-stderr",
                                HostTransportFrame {
                                    route_id: stdout_route_id.clone(),
                                    line: message,
                                },
                            );
                            continue;
                        }
                        Err(error) => {
                            let message = format!("Pi Host stdout transport read failed: {error}");
                            eprintln!("[piabyss] {message}");
                            read_failure = Some(message);
                            break;
                        }
                    }
                }
                // stdout closed — the Host process this task read is gone.
                // Sessions it reported busy will never emit the settle event
                // that would clear them, so drop the stale markers or the
                // workspace list keeps a green dot forever. `has_been_busy`
                // survives so finished workspaces still show the muted dot.
                if clear_host_activity(&activity) {
                    let _ = app_out.emit("pi-host-activity", stdout_route_id.clone());
                }
                // stdout closed — only the active child generation may trigger recovery.
                if is_current_child_generation(
                    stdout_generation.load(Ordering::SeqCst),
                    child_generation,
                ) && !shutting_down.load(Ordering::SeqCst)
                {
                    #[cfg(unix)]
                    force_cleanup_unix_host_group(&unix_process_group_for_monitor);
                    let logs = stderr_for_exit.lock().await;
                    let tail = logs.iter().rev().take(8).cloned().collect::<Vec<_>>();
                    let mut tail = tail;
                    tail.reverse();
                    let detail = match (read_failure, tail.is_empty()) {
                        (Some(error), true) => error,
                        (Some(error), false) => format!("{error}. stderr: {}", tail.join(" | ")),
                        (None, true) => "Pi Host process exited (no stderr)".to_string(),
                        (None, false) => {
                            format!("Pi Host process exited. stderr: {}", tail.join(" | "))
                        }
                    };
                    if let Some(tx) = ready_tx.lock().await.take() {
                        let _ = tx.send(Err(detail.clone()));
                    }

                    // Same AutoRestartEpoch policy unit-tested via HostChildSession
                    let mut epoch = AutoRestartEpoch {
                        auto_restart_once,
                        restart_count: restart_count.load(Ordering::SeqCst),
                        armed: auto_restart_armed.load(Ordering::SeqCst),
                    };
                    let will_restart = epoch.on_unexpected_exit();
                    restart_count.store(epoch.restart_count, Ordering::SeqCst);
                    auto_restart_armed.store(epoch.armed, Ordering::SeqCst);

                    let msg = if will_restart {
                        format!("{detail} — auto-restarting Host once")
                    } else {
                        detail
                    };

                    let _ = app_out.emit(
                        "pi-host-stdout",
                        HostTransportFrame {
                            route_id: stdout_route_id.clone(),
                            line: serde_json::json!({
                            "protocolVersion": 1,
                            "event": "host.fatal",
                            "sequence": 1,
                            "timestamp": chrono_like_now(),
                            "hostInstanceId": "00000000-0000-4000-8000-000000000002",
                            "workspaceId": null,
                            "workspaceRevision": 0,
                            "sessionId": null,
                            "sessionRevision": 0,
                            "packageRevision": 0,
                            "payload": {
                                "error": {
                                    "code": "INTERNAL_ERROR",
                                    "message": msg,
                                    "retryable": will_restart
                                }
                            }
                            })
                            .to_string(),
                        },
                    );

                    if will_restart {
                        // Request app-level restart via event (lib.rs listens)
                        let _ =
                            app_for_restart.emit("pi-host-auto-restart", stdout_route_id.clone());
                    }
                }
            }));
        }

        self.stdin = Some(Arc::clone(&stdin));
        self.child = Some(child);
        #[cfg(windows)]
        {
            self.windows_job = Some(windows_job);
        }
        #[cfg(unix)]
        {
            self.unix_process_group = Some(unix_process_group);
        }

        Ok(PendingStart {
            ready_rx,
            generation: child_generation,
            node,
            entry,
        })
    }

    /// Commit or roll back a startup whose ready-wait ran outside the manager lock.
    pub async fn complete_start(&mut self, done: CompletedStart) -> Result<(), String> {
        if !is_current_child_generation(
            self.child_generation.load(Ordering::SeqCst),
            done.generation,
        ) {
            // A newer start/shutdown superseded this attempt while the ready-wait
            // ran unlocked; that flow owns the child state now — don't touch it.
            return Err("host start superseded by a newer restart or shutdown".into());
        }
        match done.outcome {
            StartWaitOutcome::Ready(hid) => {
                eprintln!("[piabyss] host.ready received");
                if let Some(id) = hid {
                    self.host_instance_id = Some(id);
                }
                // New process ready: re-arm only if this was a fresh epoch (restart_count reset on manual restart start)
                Ok(())
            }
            StartWaitOutcome::Failed(e) => {
                self.cleanup_dead_child().await;
                Err(e)
            }
            StartWaitOutcome::ChannelClosed => {
                self.cleanup_dead_child().await;
                Err("host ready channel closed".into())
            }
            StartWaitOutcome::TimedOut => {
                let tail = {
                    let logs = self.last_stderr.lock().await;
                    stderr_tail_joined(&logs, 8)
                };
                self.cleanup_dead_child().await;
                Err(format!(
                    "timeout waiting for host.ready (180s). node={} entry={} stderr={}",
                    done.node.display(),
                    done.entry.display(),
                    if tail.is_empty() { "(empty)" } else { &tail }
                ))
            }
        }
    }

    async fn join_monitor_tasks(&mut self) {
        finish_monitor_task(&mut self.stdout_task).await;
        finish_monitor_task(&mut self.stderr_task).await;
    }

    async fn cleanup_dead_child(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.child_generation.fetch_add(1, Ordering::SeqCst);
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap(&mut self.unix_process_group).await;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.stdin = None;
        #[cfg(windows)]
        {
            self.windows_job = None;
        }
        self.join_monitor_tasks().await;
    }

    pub async fn send_line(&mut self, line: String) -> Result<(), String> {
        // Detect dead child before write
        #[cfg(unix)]
        if let Some(child) = self.child.as_ref() {
            let exited = unix_child_exited_without_reaping(child.id())
                .map_err(|error| format!("host wait error: {error}"))?;
            if exited {
                force_cleanup_unix_host_group_slot_before_reap(&mut self.unix_process_group).await;
                let status = self
                    .child
                    .as_mut()
                    .expect("Host child exists after exit observation")
                    .wait()
                    .await
                    .map_err(|error| format!("host wait error: {error}"))?;
                self.stdin = None;
                self.child = None;
                let detail = {
                    let logs = self.last_stderr.lock().await;
                    if logs.is_empty() {
                        "(empty — run pnpm build and check packages/pi-host/dist)".to_string()
                    } else {
                        stderr_tail_joined(&logs, 8)
                    }
                };
                return Err(format!("Pi Host exited ({status}). stderr: {detail}"));
            }
        }
        #[cfg(not(unix))]
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.stdin = None;
                    self.child = None;
                    #[cfg(windows)]
                    {
                        self.windows_job = None;
                    }
                    let detail = {
                        let logs = self.last_stderr.lock().await;
                        if logs.is_empty() {
                            "(empty — run pnpm build and check packages/pi-host/dist)".to_string()
                        } else {
                            stderr_tail_joined(&logs, 8)
                        }
                    };
                    return Err(format!("Pi Host exited ({status}). stderr: {detail}"));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("host wait error: {e}")),
            }
        }

        let stdin = self.stdin.as_ref().cloned().ok_or_else(|| {
            "host not running — use Settings → Restart Host (ensure `pnpm build` first)".to_string()
        })?;
        let mut guard = stdin.lock().await;
        let payload = if line.ends_with('\n') {
            line
        } else {
            format!("{line}\n")
        };
        if payload.contains("\"method\":\"system.hello\"") {
            eprintln!("[piabyss] writing system.hello request to Host");
        }
        let result =
            write_host_stdin(&mut *guard, payload.as_bytes(), HOST_STDIN_WRITE_TIMEOUT).await;
        drop(guard);
        if result.is_err() {
            self.stdin = None;
        }
        result
    }

    /// Send a single JSONL request line and await the Host's response with a
    /// matching `id`. Bypasses the renderer's active-route routing so a
    /// background workspace host can be driven directly.
    pub async fn request(&mut self, request: String, timeout: Duration) -> Result<String, String> {
        let id =
            extract_request_id(&request).ok_or_else(|| "request line has no id".to_string())?;
        let (tx, rx) = oneshot::channel::<String>();
        self.pending_requests.lock().await.insert(id.clone(), tx);
        if let Err(error) = self.send_line(request).await {
            self.pending_requests.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(line)) => Ok(line),
            Ok(Err(_)) => Err("request response channel closed".into()),
            Err(_) => {
                self.pending_requests.lock().await.remove(&id);
                Err(format!("request timed out after {}ms", timeout.as_millis()))
            }
        }
    }

    pub async fn shutdown(&mut self) {
        self.shutdown_with_grace(HOST_SHUTDOWN_GRACE).await;
    }

    pub async fn shutdown_for_app_exit(&mut self) {
        self.shutdown_with_grace(APP_EXIT_HOST_SHUTDOWN_GRACE).await;
    }

    async fn shutdown_with_grace(&mut self, graceful_timeout: Duration) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.child_generation.fetch_add(1, Ordering::SeqCst);
        if self.stdin.is_some() {
            let host_id = self
                .host_instance_id
                .clone()
                .unwrap_or_else(|| "unknown".into());
            let line = build_shutdown_line(&host_id, "shutdown");
            if self.host_instance_id.is_none() {
                eprintln!(
                    "[piabyss] shutdown without hostInstanceId — sending expectedHostInstanceId=unknown then terminate"
                );
            }
            let _ = self.send_line(line).await;
        }

        #[cfg(unix)]
        let unix_process_group = self.unix_process_group.take();
        #[cfg(unix)]
        let mut group_cleanup = unix_process_group
            .as_ref()
            .and_then(UnixHostProcessGroup::claim_cleanup);
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            // Child::wait reaps on Unix, so graceful exit must be observed
            // without releasing the PID needed for process-group cleanup.
            let needs_force = !matches!(
                wait_for_unix_child_exit_without_reaping(child.id(), graceful_timeout,).await,
                Ok(true)
            );
            #[cfg(not(unix))]
            let needs_force = {
                let wait = tokio::time::timeout(graceful_timeout, child.wait()).await;
                !matches!(wait, Ok(Ok(_)))
            };
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                terminate_unix_host_group(cleanup).await;
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled().await;
            }
            if needs_force {
                let _ = child.kill().await;
                #[cfg(not(unix))]
                {
                    let _ = child.wait().await;
                }
            }
            #[cfg(unix)]
            {
                let _ = child.wait().await;
            }
        } else {
            #[cfg(unix)]
            if let Some(cleanup) = group_cleanup.as_mut() {
                terminate_unix_host_group(cleanup).await;
            } else if let Some(group) = unix_process_group.as_ref() {
                group.wait_until_cleanup_signaled().await;
            }
        }
        self.stdin = None;
        #[cfg(windows)]
        {
            self.windows_job = None;
        }
        self.join_monitor_tasks().await;
    }

    /// Manual restart: new host epoch — reset one-shot auto-restart arming.
    pub async fn begin_manual_restart(&mut self) -> Result<PendingStart, String> {
        self.shutdown().await;
        // Same epoch reset as AutoRestartEpoch::on_manual_restart
        let mut ep = AutoRestartEpoch {
            auto_restart_once: self.auto_restart_once,
            restart_count: self.restart_count.load(Ordering::SeqCst),
            armed: self.auto_restart_armed.load(Ordering::SeqCst),
        };
        ep.on_manual_restart();
        self.restart_count.store(ep.restart_count, Ordering::SeqCst);
        self.auto_restart_armed.store(ep.armed, Ordering::SeqCst);
        self.host_instance_id = None;
        self.begin_start().await
    }

    /// One-shot auto-restart after unexpected exit (does not reset epoch counter to 0).
    pub async fn begin_auto_restart_after_crash(&mut self) -> Result<PendingStart, String> {
        // Reap or terminate the previous child before starting the replacement epoch.
        self.cleanup_dead_child().await;
        self.host_instance_id = None;
        self.shutting_down.store(false, Ordering::SeqCst);
        self.begin_start().await
    }

    pub fn is_running(&mut self) -> bool {
        #[cfg(unix)]
        if let Some(child) = self.child.as_ref() {
            match unix_child_exited_without_reaping(child.id()) {
                Ok(true) => {
                    force_cleanup_unix_host_group_slot_before_reap_blocking(
                        &mut self.unix_process_group,
                    );
                    if let Some(child) = self.child.as_mut() {
                        let _ = child.try_wait();
                    }
                    self.child = None;
                    self.stdin = None;
                    false
                }
                Ok(false) => true,
                Err(_) => false,
            }
        } else {
            false
        }
        #[cfg(not(unix))]
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.child = None;
                    self.stdin = None;
                    #[cfg(windows)]
                    {
                        self.windows_job = None;
                    }
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }
}

impl Drop for PiHostManager {
    fn drop(&mut self) {
        #[cfg(unix)]
        force_cleanup_unix_host_group_slot_before_reap_blocking(&mut self.unix_process_group);
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

/// A spawned host whose `host.ready` wait has not completed yet.
/// Await `wait_ready` WITHOUT holding the manager mutex, then pass the result
/// to `PiHostManager::complete_start` under a fresh (short) lock.
pub struct PendingStart {
    ready_rx: tokio::sync::oneshot::Receiver<Result<Option<String>, String>>,
    generation: u32,
    node: PathBuf,
    entry: PathBuf,
}

pub enum StartWaitOutcome {
    Ready(Option<String>),
    Failed(String),
    ChannelClosed,
    TimedOut,
}

pub struct CompletedStart {
    generation: u32,
    node: PathBuf,
    entry: PathBuf,
    outcome: StartWaitOutcome,
}

impl PendingStart {
    pub async fn wait_ready(self) -> CompletedStart {
        let outcome =
            match tokio::time::timeout(std::time::Duration::from_secs(180), self.ready_rx).await {
                Ok(Ok(Ok(hid))) => StartWaitOutcome::Ready(hid),
                Ok(Ok(Err(e))) => StartWaitOutcome::Failed(e),
                Ok(Err(_)) => StartWaitOutcome::ChannelClosed,
                Err(_) => StartWaitOutcome::TimedOut,
            };
        CompletedStart {
            generation: self.generation,
            node: self.node,
            entry: self.entry,
            outcome,
        }
    }
}

/// Which startup flow `start_unlocked` runs.
pub enum StartKind {
    Fresh,
    ManualRestart,
    AutoRestartAfterCrash,
}

/// Drive a full host start while holding the manager mutex only for the spawn
/// and commit phases — never across the (up to 180 s) host.ready wait, so IPC
/// commands and app exit stay responsive if the sidecar hangs.
pub async fn start_unlocked(
    host: &tokio::sync::Mutex<PiHostManager>,
    kind: StartKind,
) -> Result<(), String> {
    let pending = {
        let mut mgr = host.lock().await;
        match kind {
            StartKind::Fresh => mgr.begin_start().await?,
            StartKind::ManualRestart => mgr.begin_manual_restart().await?,
            StartKind::AutoRestartAfterCrash => mgr.begin_auto_restart_after_crash().await?,
        }
    };
    let done = pending.wait_ready().await;
    host.lock().await.complete_start(done).await
}

/// Make an absolute path safe to pass to Node on Windows.
///
/// `Path::canonicalize` on Windows returns `\\?\C:\...` extended paths.
/// Node treats those as broken entry points (`EISDIR: lstat 'C:'`) and exits
/// immediately — which surfaces in the UI as "flush stdin: pipe is being closed".
fn canonicalize_path(p: PathBuf) -> PathBuf {
    let resolved = if p.is_absolute() {
        p.canonicalize().unwrap_or(p)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&p))
            .and_then(|abs| abs.canonicalize().or(Ok(abs)))
            .unwrap_or(p)
    };
    strip_verbatim_prefix(resolved)
}

/// Public for bridge unit tests.
pub fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    // \\?\C:\foo  or  \\?\UNC\server\share
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    p
}

/// Host PATH = user PATH first (mise, nvm, system git, …), then bundled
/// Node/Git dirs as a fallback, then System32. Returns a platform PATH string.
pub(crate) fn build_host_path(
    existing_path: Option<&std::ffi::OsStr>,
    node_dir: Option<&Path>,
    git_cmd: Option<&Path>,
    system_root: Option<&str>,
) -> Result<PathBuf, String> {
    let mut host_path = Vec::<PathBuf>::new();
    if let Some(existing) = existing_path {
        host_path.extend(std::env::split_paths(existing));
    }
    if let Some(node_dir) = node_dir {
        host_path.push(node_dir.to_path_buf());
    }
    if let Some(git_cmd) = git_cmd {
        host_path.push(git_cmd.to_path_buf());
        if let Some(git_root) = git_cmd.parent() {
            host_path.push(git_root.join("bin"));
            host_path.push(git_root.join("mingw64").join("bin"));
        }
    }
    if let Some(system_root) = system_root {
        host_path.push(PathBuf::from(system_root).join("System32"));
    }
    std::env::join_paths(host_path)
        .map(PathBuf::from)
        .map_err(|e| format!("build Host PATH: {e}"))
}

/// Extract the `id` field from a JSONL request line (best-effort).
fn extract_request_id(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// Extract hostInstanceId from a host.ready JSON line (best-effort).
pub fn extract_host_instance_id(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("hostInstanceId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            v.get("payload")
                .and_then(|p| p.get("hostInstanceId"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
}

fn staged_host_is_runnable(main_js: &Path) -> bool {
    let dir = match main_js.parent() {
        Some(d) => d,
        None => return false,
    };
    dir.join("model-health.js").exists()
        && dir
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .exists()
}

pub(crate) fn node_executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

pub(crate) fn node_runtime_candidates(base: &Path) -> [PathBuf; 2] {
    let executable = node_executable_name();
    [
        base.join("node").join(executable),
        base.join("resources").join("node").join(executable),
    ]
}

pub(crate) fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn which_node() -> Result<PathBuf, ()> {
    // Try PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(node_executable_name());
            if is_executable_file(&candidate) {
                return Ok(candidate);
            }
        }
    }
    // Common nvm4w / fnm locations on this machine class
    #[cfg(windows)]
    {
        for candidate in [
            PathBuf::from(r"C:\nvm4w\nodejs\node.exe"),
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        ] {
            if is_executable_file(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err(())
}

fn chrono_like_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
