//! Rust bridge tests (R3) — drive shared HostChildSession / PiHostManager helpers.

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use crate::pi_host::WindowsHostJob;
    use crate::pi_host::{
        acknowledge_session_terminal_in_activity, build_host_path, build_shutdown_line,
        drain_complete_lines, extract_host_instance_id, finish_monitor_task, host_activity_expired,
        host_activity_rss_eligible, host_activity_snapshot, is_current_child_generation,
        node_executable_name, node_runtime_candidates, observe_host_activity, push_stderr_tail,
        read_bounded_lossy_line, read_bounded_utf8_line, should_auto_restart,
        strip_verbatim_prefix, write_host_stdin, ActivationTarget, AutoRestartEpoch, HostActivity,
        HostActivitySnapshot, HostChildSession, PoolBook, APP_EXIT_HOST_SHUTDOWN_GRACE,
        HOST_SHUTDOWN_GRACE, IDLE_HOST_RETENTION, MAX_HOST_STDOUT_LINE_BYTES, RSS_PROBE_MIN_IDLE,
    };
    #[cfg(unix)]
    use crate::pi_host::{is_executable_file, unix_child_exited_without_reaping};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[cfg(unix)]
    struct UnixPidGuard(Vec<libc::pid_t>);

    #[cfg(unix)]
    impl Drop for UnixPidGuard {
        fn drop(&mut self) {
            for pid in self.0.drain(..) {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }

    #[cfg(unix)]
    fn unix_descendant_fixture(crash_host: bool) -> String {
        let parent_lifecycle = if crash_host {
            "setTimeout(() => process.exit(17), 75);"
        } else {
            "setInterval(() => {}, 1000);"
        };
        r#"
const { spawn } = require('child_process');
const descendant = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: 'ignore' }
);
process.stdout.write(String(process.pid) + ',' + String(descendant.pid) + '\n');
__PARENT_LIFECYCLE__
"#
        .replace("__PARENT_LIFECYCLE__", parent_lifecycle)
    }

    #[cfg(unix)]
    fn unix_graceful_descendant_fixture() -> String {
        r#"
const { spawn } = require('child_process');
const readline = require('readline');
const descendant = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: 'ignore' }
);
process.stdout.write(String(process.pid) + ',' + String(descendant.pid) + '\n');
readline.createInterface({ input: process.stdin }).once('line', () => process.exit(0));
setInterval(() => {}, 1000);
"#
        .to_string()
    }

    #[cfg(unix)]
    fn read_unix_fixture_pids(session: &mut HostChildSession) -> (libc::pid_t, libc::pid_t) {
        let line = session
            .read_line_timeout(Duration::from_secs(5))
            .expect("fixture PIDs");
        let mut fields = line.split(',');
        let host_pid = fields
            .next()
            .expect("Host PID")
            .parse::<libc::pid_t>()
            .expect("numeric Host PID");
        let descendant_pid = fields
            .next()
            .expect("descendant PID")
            .parse::<libc::pid_t>()
            .expect("numeric descendant PID");
        assert!(
            fields.next().is_none(),
            "unexpected fixture PID payload: {line}"
        );
        (host_pid, descendant_pid)
    }

    #[cfg(unix)]
    fn unix_process_exists(pid: libc::pid_t) -> bool {
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(unix)]
    fn wait_for_unix_process_exit(pid: libc::pid_t, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !unix_process_exists(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        !unix_process_exists(pid)
    }

    #[cfg(unix)]
    fn wait_for_unix_child_exit_without_reaping(pid: libc::pid_t, timeout: Duration) -> bool {
        let child_id = u32::try_from(pid).expect("positive child PID");
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            match unix_child_exited_without_reaping(Some(child_id)) {
                Ok(true) => return true,
                Ok(false) => std::thread::sleep(Duration::from_millis(20)),
                Err(error) => panic!("probe child {pid} without reaping: {error}"),
            }
        }
        unix_child_exited_without_reaping(Some(child_id)).expect("final non-reaping child probe")
    }

    fn fixture_script() -> String {
        r#"
const rl = require('readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({
  protocolVersion:1,event:'host.ready',sequence:1,timestamp:Date.now(),
  hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
  sessionId:null,sessionRevision:0,packageRevision:0,
  payload:{hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,sessionId:null,sessionRevision:0,packageRevision:0,protocolVersion:1,sdkVersion:'0.82.1',nodeVersion:process.version,agentDir:'/tmp',phase:'waitingForWorkspace',capabilities:{packageUpdateCheck:false,extensionUi:true,sessionExport:false},modelConfigHealth:{state:'ok',source:'ModelRegistry.getError'}}
})+'\n');
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    if (req.method === 'system.hello') {
      process.stdout.write(JSON.stringify({
        protocolVersion:1,id:req.id,method:'system.hello',ok:true,
        hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
        sessionId:null,sessionRevision:0,packageRevision:0,
        result:{hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,sessionId:null,sessionRevision:0,packageRevision:0,protocolVersion:1,sdkVersion:'0.82.1',nodeVersion:process.version,agentDir:'/tmp',phase:'waitingForWorkspace',capabilities:{packageUpdateCheck:false,extensionUi:true,sessionExport:false},modelConfigHealth:{state:'ok',source:'ModelRegistry.getError'}}
      })+'\n');
    } else if (req.method === 'system.shutdown') {
      const expected = req.context && req.context.expectedHostInstanceId;
      if (expected !== 'test-host') {
        process.stdout.write(JSON.stringify({
          protocolVersion:1,id:req.id,method:'system.shutdown',ok:false,
          hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
          sessionId:null,sessionRevision:0,packageRevision:0,
          error:{code:'STALE_REVISION',message:'host mismatch',retryable:false}
        })+'\n');
        return;
      }
      process.stdout.write(JSON.stringify({
        protocolVersion:1,id:req.id,method:'system.shutdown',ok:true,
        hostInstanceId:'test-host',workspaceId:null,workspaceRevision:0,
        sessionId:null,sessionRevision:0,packageRevision:0,
        result:{accepted:true}
      })+'\n');
      process.exit(0);
    }
  } catch (e) {
    process.stderr.write(String(e)+'\n');
  }
});
"#
        .to_string()
    }

    #[test]
    fn auto_restart_epoch_exactly_once_then_fatal() {
        let mut ep = AutoRestartEpoch::new(true);
        assert!(ep.on_unexpected_exit()); // first crash → restart
        assert_eq!(ep.restart_count, 1);
        assert!(!ep.armed);
        assert!(!ep.on_unexpected_exit()); // second crash → stay fatal
        assert!(!should_auto_restart(true, 1));
        ep.on_manual_restart();
        assert_eq!(ep.restart_count, 0);
        assert!(ep.armed);
        assert!(ep.on_unexpected_exit());
    }

    #[test]
    fn delayed_monitor_is_retired_when_child_generation_advances() {
        assert!(is_current_child_generation(7, 7));
        assert!(!is_current_child_generation(8, 7));
    }

    #[test]
    fn auto_restart_disabled_never_restarts() {
        let mut ep = AutoRestartEpoch::new(false);
        assert!(!ep.on_unexpected_exit());
    }

    #[test]
    fn strip_verbatim_prefix_from_pi_host() {
        let p = strip_verbatim_prefix(PathBuf::from(r"\\?\C:\foo\bar.js"));
        assert_eq!(p, PathBuf::from(r"C:\foo\bar.js"));
        let unc = strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share"));
        assert_eq!(unc, PathBuf::from(r"\\server\share"));
    }

    #[test]
    fn stripped_runtime_dir_yields_cmd_compatible_controlled_path() {
        // resource_dir on Windows is derived from a canonicalized (\\?\) exe
        // path. The bundled node/git dirs land on the Host's controlled PATH,
        // where cmd.exe resolves npm.cmd — cmd cannot handle \\?\ paths, so a
        // verbatim entry breaks every npm install in the packaged app.
        let node = strip_verbatim_prefix(PathBuf::from(
            r"\\?\C:\Users\Admin\AppData\Local\PiAbyss\resources\node\node.exe",
        ));
        assert_eq!(
            node,
            PathBuf::from(r"C:\Users\Admin\AppData\Local\PiAbyss\resources\node\node.exe"),
        );
        let node_dir = node.parent().expect("node dir");
        assert!(!node_dir.to_string_lossy().starts_with(r"\\?\"));
        let git_cmd = strip_verbatim_prefix(PathBuf::from(
            r"\\?\C:\Users\Admin\AppData\Local\PiAbyss\resources\git\cmd",
        ));
        assert!(!git_cmd.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn bundled_node_candidates_match_the_target_platform() {
        let expected = if cfg!(windows) { "node.exe" } else { "node" };
        assert_eq!(node_executable_name(), expected);
        for candidate in node_runtime_candidates(std::path::Path::new("runtime")) {
            assert_eq!(
                candidate.file_name().and_then(|name| name.to_str()),
                Some(expected)
            );
        }
    }

    #[test]
    fn build_host_path_keeps_user_path_first_then_bundled_fallback() {
        let user_path = std::env::join_paths([
            PathBuf::from("C:\\Users\\me\\AppData\\Local\\mise\\shims"),
            PathBuf::from("C:\\Program Files\\Git\\cmd"),
        ])
        .expect("join user path");
        let host_path = build_host_path(
            Some(user_path.as_os_str()),
            Some(std::path::Path::new(r"C:\PiAbyss\resources\node")),
            Some(std::path::Path::new(r"C:\PiAbyss\resources\git\cmd")),
            Some(r"C:\Windows"),
        )
        .expect("build host path");
        let entries: Vec<String> = std::env::split_paths(&host_path)
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        // User PATH entries come first, so Agent Bash sees mise/system git.
        assert_eq!(entries[0], "C:\\Users\\me\\AppData\\Local\\mise\\shims");
        assert_eq!(entries[1], "C:\\Program Files\\Git\\cmd");
        // Bundled Node/Git are appended as a fallback.
        assert_eq!(entries[2], "C:\\PiAbyss\\resources\\node");
        assert_eq!(entries[3], "C:\\PiAbyss\\resources\\git\\cmd");
        assert!(entries.contains(&"C:\\PiAbyss\\resources\\git\\bin".to_string()));
        assert!(entries.contains(&"C:\\Windows\\System32".to_string()));
    }

    #[test]
    fn build_host_path_without_user_path_only_appends_bundled() {
        let host_path = build_host_path(
            None,
            Some(std::path::Path::new(r"C:\PiAbyss\resources\node")),
            None,
            None,
        )
        .expect("build host path");
        let entries: Vec<String> = std::env::split_paths(&host_path)
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["C:\\PiAbyss\\resources\\node"]);
    }

    #[test]
    fn bundled_bash_from_git_resolves_portable_git_bash() {
        #[cfg(windows)]
        {
            use crate::pi_host::PiHostManager;
            // Fake layout: <root>/cmd/git.exe -> <root>/bin/bash.exe
            let temp =
                std::env::temp_dir().join(format!("piabyss-bash-test-{}", uuid::Uuid::new_v4()));
            let git_cmd = temp.join("cmd");
            std::fs::create_dir_all(&git_cmd).expect("create git cmd dir");
            let git_exe = git_cmd.join("git.exe");
            std::fs::write(&git_exe, b"fixture").expect("write git.exe");
            let bash = temp.join("bin").join("bash.exe");
            std::fs::create_dir_all(bash.parent().expect("bin dir")).expect("create bin dir");
            std::fs::write(&bash, b"fixture").expect("write bash.exe");

            let resolved = PiHostManager::bundled_bash_from_git(&git_exe);
            assert_eq!(resolved, Some(bash.clone()));

            // Missing bash -> None; non-`cmd` layout -> None.
            std::fs::remove_file(&bash).expect("remove bash");
            assert_eq!(PiHostManager::bundled_bash_from_git(&git_exe), None);
            assert_eq!(
                PiHostManager::bundled_bash_from_git(&temp.join("bin").join("bash.exe")),
                None
            );
            std::fs::remove_dir_all(&temp).expect("cleanup temp");
        }
        #[cfg(not(windows))]
        {
            assert!(true); // layout is Windows-only
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_node_candidate_must_be_executable() {
        use std::os::unix::fs::PermissionsExt;

        let path =
            std::env::temp_dir().join(format!("piabyss-node-candidate-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"fixture").expect("write candidate");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("make candidate non-executable");
        assert!(!is_executable_file(&path));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make candidate executable");
        assert!(is_executable_file(&path));

        std::fs::remove_file(path).expect("remove candidate");
    }

    #[test]
    fn extract_host_instance_id_from_ready_line() {
        let line = r#"{"protocolVersion":1,"event":"host.ready","hostInstanceId":"abc-123","payload":{"hostInstanceId":"abc-123"}}"#;
        assert_eq!(extract_host_instance_id(line).as_deref(), Some("abc-123"));
        assert!(extract_host_instance_id("not-json").is_none());
    }

    #[test]
    fn build_shutdown_uses_exact_host_id_not_star() {
        let line = build_shutdown_line("real-host-id", "shutdown");
        assert!(line.contains(r#""expectedHostInstanceId":"real-host-id""#));
        assert!(!line.contains(r#""*""#));
    }

    #[test]
    fn app_exit_uses_a_shorter_host_grace_period_than_restart() {
        assert_eq!(APP_EXIT_HOST_SHUTDOWN_GRACE, Duration::from_secs(1));
        assert!(APP_EXIT_HOST_SHUTDOWN_GRACE < HOST_SHUTDOWN_GRACE);
    }

    #[test]
    fn drain_complete_lines_partial_buffering() {
        let mut buf = String::new();
        let mut lines = drain_complete_lines(&mut buf, r#"{"event":"ho"#);
        assert!(lines.is_empty());
        assert!(!buf.is_empty());
        lines = drain_complete_lines(&mut buf, r#"st.ready","hostInstanceId":"x"}"#);
        assert!(lines.is_empty()); // still no newline
        lines = drain_complete_lines(&mut buf, "\n{\"b\":2}\n");
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("host.ready"));
        assert!(lines[1].contains("\"b\":2"));
        assert!(buf.is_empty());
    }

    #[test]
    fn stderr_tail_bounded() {
        let mut logs = Vec::new();
        for i in 0..60 {
            push_stderr_tail(&mut logs, format!("line{i}"), 50);
        }
        assert_eq!(logs.len(), 50);
        assert_eq!(logs[0], "line10");
    }

    #[tokio::test]
    async fn bounded_jsonl_reader_accepts_limit_and_rejects_oversize_line() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let write_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer
                .write_all(b"12345678\n123456789\nok\n")
                .await
                .unwrap();
        });
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();

        assert_eq!(
            read_bounded_utf8_line(&mut reader, &mut line, 9)
                .await
                .unwrap(),
            9
        );
        assert_eq!(line, "12345678\n");

        let error = read_bounded_utf8_line(&mut reader, &mut line, 8)
            .await
            .expect_err("oversize JSONL line must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("8 byte limit"));

        assert_eq!(
            read_bounded_utf8_line(&mut reader, &mut line, 8)
                .await
                .unwrap(),
            3
        );
        assert_eq!(line, "ok\n");
        write_task.await.unwrap();
    }

    #[tokio::test]
    async fn bounded_stderr_reader_replaces_invalid_utf8_and_keeps_reading() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer
                .write_all(&[b'b', b'a', b'd', 0xff, b'\n', b'o', b'k', b'\n'])
                .await
                .unwrap();
        });
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();

        assert_eq!(
            read_bounded_lossy_line(&mut reader, &mut line, 16)
                .await
                .unwrap(),
            5
        );
        assert_eq!(line, "bad\u{fffd}\n");
        assert_eq!(
            read_bounded_lossy_line(&mut reader, &mut line, 16)
                .await
                .unwrap(),
            3
        );
        assert_eq!(line, "ok\n");
        write_task.await.unwrap();
    }

    #[tokio::test]
    async fn bounded_stderr_reader_rejects_oversize_line_and_keeps_reading() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer.write_all(b"123456789\nok\n").await.unwrap();
        });
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();

        let error = read_bounded_lossy_line(&mut reader, &mut line, 8)
            .await
            .expect_err("oversize stderr line must be reported");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("8 byte limit"));

        assert_eq!(
            read_bounded_lossy_line(&mut reader, &mut line, 8)
                .await
                .unwrap(),
            3
        );
        assert_eq!(line, "ok\n");
        write_task.await.unwrap();
    }

    #[tokio::test]
    async fn host_stdin_write_enforces_its_own_deadline() {
        let (mut writer, _idle_reader) = tokio::io::duplex(1);
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            write_host_stdin(&mut writer, b"blocked", Duration::from_millis(25)),
        )
        .await
        .expect("Host stdin writer must enforce its own deadline");

        let error = result.expect_err("stalled Host stdin must time out");
        assert!(error.contains("timed out"), "unexpected error: {error}");
    }

    #[test]
    fn stdout_jsonl_limit_is_large_but_finite() {
        assert_eq!(MAX_HOST_STDOUT_LINE_BYTES, 32 * 1024 * 1024);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_job_close_terminates_assigned_host() {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = tokio::process::Command::new("cmd.exe");
        command
            .args(["/C", "ping", "-t", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().expect("spawn job fixture");
        let job = WindowsHostJob::assign(&child).expect("assign fixture to Job Object");
        assert!(child.try_wait().expect("probe fixture").is_none());

        drop(job);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("Job Object should terminate child promptly")
            .expect("wait for fixture");
    }

    #[test]
    fn host_child_session_spawn_ready_hello_exact_shutdown() {
        let mut session =
            HostChildSession::spawn_node_script(&fixture_script(), true).expect("spawn");
        let ready = session.wait_ready(Duration::from_secs(5)).expect("ready");
        assert!(ready.contains("host.ready"));
        assert_eq!(session.host_instance_id.as_deref(), Some("test-host"));

        session
            .send_line(
                r#"{"protocolVersion":1,"id":"1","method":"system.hello","context":{},"params":{"clientName":"t","clientVersion":"0","protocolVersion":1}}"#,
            )
            .unwrap();
        let hello = session
            .read_line_timeout(Duration::from_secs(5))
            .expect("hello");
        assert!(hello.contains(r#""ok":true"#));
        assert!(hello.contains("test-host"));

        // Shutdown uses exact id via shared build_shutdown_line path
        session.shutdown_exact().expect("shutdown");
    }

    #[test]
    fn host_child_session_kill_timeout_reaps() {
        let mut session =
            HostChildSession::spawn_node_script("setInterval(()=>{}, 1000)", false).expect("spawn");
        std::thread::sleep(Duration::from_millis(50));
        let status = session.kill_and_reap().expect("reap");
        assert!(!status.success() || status.code().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_uses_an_isolated_session_and_process_group() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(false), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);
        let host_group = unsafe { libc::getpgid(host_pid) };
        let host_session = unsafe { libc::getsid(host_pid) };
        let descendant_group = unsafe { libc::getpgid(descendant_pid) };
        session.kill_and_reap().expect("reap Host fixture");

        assert_eq!(host_group, host_pid, "Host must lead its own process group");
        assert_eq!(
            host_session, host_pid,
            "Host must lead its own Unix session"
        );
        assert_eq!(
            descendant_group, host_pid,
            "descendant must inherit Host group"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_force_cleanup_terminates_descendants() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(false), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);

        session.kill_and_reap().expect("force cleanup");

        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived force cleanup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_exit_probe_preserves_group_leader_until_cleanup() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(true), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);

        assert!(
            wait_for_unix_child_exit_without_reaping(host_pid, Duration::from_secs(2)),
            "Host fixture {host_pid} did not exit"
        );
        assert!(
            unix_process_exists(host_pid),
            "non-reaping exit observation released Host PID {host_pid}"
        );
        assert!(
            unix_child_exited_without_reaping(Some(
                u32::try_from(host_pid).expect("positive Host PID")
            ))
            .expect("repeat non-reaping child probe"),
            "Host exit must remain observable until explicit reap"
        );
        assert_eq!(
            unsafe { libc::kill(-host_pid, 0) },
            0,
            "Host process-group target must still exist before cleanup"
        );

        session.kill_and_reap().expect("cleanup and reap Host");
        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived cleanup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reap_waits_for_claimed_group_cleanup_signal() {
        let mut session =
            HostChildSession::spawn_node_script("setInterval(()=>{}, 1000)", false).expect("spawn");
        let cleanup = session
            .claim_unix_group_cleanup_for_test()
            .expect("claim Unix group cleanup");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let reap_thread = std::thread::spawn(move || {
            started_tx.send(()).expect("announce reaper start");
            result_tx
                .send(session.kill_and_reap())
                .expect("publish reap result");
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reaper started");
        assert!(
            matches!(
                result_rx.recv_timeout(Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "reaper proceeded before the cleanup owner signaled the group"
        );

        drop(cleanup);
        result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reaper resumed after group signal")
            .expect("reap Host fixture");
        reap_thread.join().expect("join reaper");
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_graceful_shutdown_terminates_descendants() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_graceful_descendant_fixture(), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);

        session.shutdown_exact().expect("graceful shutdown");

        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived graceful shutdown"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_host_crash_cleanup_terminates_descendants_without_restart() {
        let mut session =
            HostChildSession::spawn_node_script(&unix_descendant_fixture(true), false)
                .expect("spawn");
        let (host_pid, descendant_pid) = read_unix_fixture_pids(&mut session);
        let _guard = UnixPidGuard(vec![host_pid, descendant_pid]);
        std::thread::sleep(Duration::from_millis(150));

        assert!(!session.on_unexpected_exit(), "restart is disabled");
        let _ = session.kill_and_reap();

        assert!(
            wait_for_unix_process_exit(descendant_pid, Duration::from_secs(2)),
            "Host descendant {descendant_pid} survived Host crash cleanup"
        );
    }

    #[test]
    fn host_child_session_unexpected_exit_auto_restart_once() {
        let mut session =
            HostChildSession::spawn_node_script("process.exit(7)", true).expect("spawn");
        // child exits immediately
        std::thread::sleep(Duration::from_millis(100));
        let will = session.on_unexpected_exit();
        assert!(will, "first unexpected exit should auto-restart");
        let will2 = session.on_unexpected_exit();
        assert!(!will2, "second exit stays fatal");
    }

    #[test]
    fn host_child_session_graceful_flag_skips_auto_restart() {
        let mut session =
            HostChildSession::spawn_node_script(&fixture_script(), true).expect("spawn");
        let _ = session.wait_ready(Duration::from_secs(5));
        session.shutting_down = true;
        assert!(!session.on_unexpected_exit());
        let _ = session.kill_and_reap();
    }

    #[tokio::test]
    async fn retired_generation_monitor_exits_and_is_joined() {
        let generation = Arc::new(AtomicU32::new(7));
        let exited = Arc::new(AtomicBool::new(false));
        let task_generation = Arc::clone(&generation);
        let task_exited = Arc::clone(&exited);
        let mut task = Some(tokio::spawn(async move {
            while is_current_child_generation(task_generation.load(Ordering::SeqCst), 7) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            task_exited.store(true, Ordering::SeqCst);
        }));

        generation.store(8, Ordering::SeqCst);
        finish_monitor_task(&mut task).await;

        assert!(task.is_none());
        assert!(exited.load(Ordering::SeqCst));
    }

    #[test]
    fn invalid_json_does_not_panic() {
        assert!(extract_host_instance_id("{not").is_none());
        assert!(extract_host_instance_id("").is_none());
        let mut buf = String::new();
        let lines = drain_complete_lines(&mut buf, "not json\n");
        assert_eq!(lines.len(), 1);
    }

    fn runtime_line(session_id: &str, state: &str) -> String {
        serde_json::json!({
            "event": "session.runtimeChanged",
            "payload": { "sessionId": session_id, "state": state }
        })
        .to_string()
    }

    #[test]
    fn unacknowledged_terminal_markers_pin_the_host_past_idle_retention() {
        let activity = Mutex::new(HostActivity::default());
        // Red dot: failed session the renderer has not acknowledged yet.
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "error")
        ));
        // Gray dot: completed session, still unacknowledged.
        assert!(observe_host_activity(
            &activity,
            &runtime_line("b", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("b", "idle")));
        activity
            .lock()
            .expect("activity lock")
            .set_idle_since_for_test(std::time::Instant::now() - IDLE_HOST_RETENTION);
        // Past the 30-minute idle retention, but the unread dots pin the Host.
        assert!(!host_activity_expired(&activity));
    }

    #[test]
    fn acknowledging_the_terminal_marker_restores_idle_retirement() {
        let activity = Mutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        activity
            .lock()
            .expect("activity lock")
            .set_idle_since_for_test(std::time::Instant::now() - IDLE_HOST_RETENTION);
        assert!(!host_activity_expired(&activity));
        // The renderer acks by returning to the session — the same clear path
        // as PiHostPool::acknowledge_session_terminal.
        assert!(acknowledge_session_terminal_in_activity(&activity, "a"));
        assert!(host_activity_expired(&activity));
    }

    #[test]
    fn rss_accelerator_respects_busy_and_terminal_pins() {
        // A running session pins the Host against the RSS accelerator even
        // though `idle_since` has aged past the probe floor (idle_since only
        // refreshes on the busy→idle edge).
        let activity = Mutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        activity
            .lock()
            .expect("activity lock")
            .set_idle_since_for_test(std::time::Instant::now() - RSS_PROBE_MIN_IDLE);
        assert!(!host_activity_rss_eligible(&activity));

        // A single unacknowledged red dot pins too.
        let activity = Mutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "error")
        ));
        activity
            .lock()
            .expect("activity lock")
            .set_idle_since_for_test(std::time::Instant::now() - RSS_PROBE_MIN_IDLE);
        assert!(!host_activity_rss_eligible(&activity));

        // Below the probe floor: quiet but not idle long enough.
        let activity = Mutex::new(HostActivity::default());
        activity
            .lock()
            .expect("activity lock")
            .set_idle_since_for_test(
                std::time::Instant::now() - std::time::Duration::from_secs(60),
            );
        assert!(!host_activity_rss_eligible(&activity));

        // Fully quiet + idle past the floor → the accelerator may act.
        let activity = Mutex::new(HostActivity::default());
        activity
            .lock()
            .expect("activity lock")
            .set_idle_since_for_test(std::time::Instant::now() - RSS_PROBE_MIN_IDLE);
        assert!(host_activity_rss_eligible(&activity));
    }

    #[test]
    fn acknowledging_one_marker_keeps_the_host_pinned_while_others_remain() {
        let activity = Mutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));
        assert!(observe_host_activity(&activity, &runtime_line("a", "idle")));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("b", "running")
        ));
        assert!(observe_host_activity(
            &activity,
            &runtime_line("b", "error")
        ));
        activity
            .lock()
            .expect("activity lock")
            .set_idle_since_for_test(std::time::Instant::now() - IDLE_HOST_RETENTION);
        assert!(!host_activity_expired(&activity));
        assert!(acknowledge_session_terminal_in_activity(&activity, "a"));
        // b's red dot is still unacked — the Host stays.
        assert!(!host_activity_expired(&activity));
        assert!(acknowledge_session_terminal_in_activity(&activity, "b"));
        assert!(host_activity_expired(&activity));
    }

    // --- Shared-host mode (B2): pool bookkeeping decisions ---

    fn book_for_workspace(key: &str) -> PoolBook {
        PoolBook::new(
            key.to_string(),
            "route-1".to_string(),
            PathBuf::from("C:\\ws\\a"),
        )
    }

    #[test]
    fn shared_mode_activation_reuses_the_active_entry_and_never_spawns() {
        let book = book_for_workspace("c:\\ws\\a");
        // Unbound workspace under shared mode → reuse the ACTIVE entry, so the
        // pool never grows a second Host.
        match book.activation_target("c:\\ws\\b", true) {
            ActivationTarget::Reuse(key) => assert_eq!(key, "c:\\ws\\a"),
            ActivationTarget::Spawn => {
                panic!("shared mode must never spawn for an unbound workspace")
            }
        }

        // Cold bootstrap (no active entry — app start before PiHostPool::new
        // seeds one) is the only shared-mode path that may still spawn.
        let mut cold = book_for_workspace("c:\\ws\\a");
        cold.entries.remove("c:\\ws\\a");
        assert!(matches!(
            cold.activation_target("c:\\ws\\b", true),
            ActivationTarget::Spawn
        ));

        // Dedicated mode keeps the 1:1 key match semantics.
        assert!(matches!(
            book.activation_target("c:\\ws\\b", false),
            ActivationTarget::Spawn
        ));
        assert!(matches!(
            book.activation_target("c:\\ws\\a", false),
            ActivationTarget::Reuse(key) if key == "c:\\ws\\a"
        ));
    }

    #[test]
    fn shared_mode_rebind_registers_workspaces_without_rekeying() {
        let mut book = book_for_workspace("c:\\ws\\a");
        book.register_workspace_on_active("c:\\ws\\b".to_string());
        // Re-registering the same workspace is a no-op (deduped).
        book.register_workspace_on_active("c:\\ws\\b".to_string());

        let entry = &book.entries[&book.active_key];
        assert_eq!(entry.workspaces, vec!["c:\\ws\\a", "c:\\ws\\b"]);
        assert_eq!(book.active_key, "c:\\ws\\a", "entry key must not change");
        assert_eq!(
            book.route_to_key.get("route-1").map(String::as_str),
            Some("c:\\ws\\a"),
            "route_to_key must stay untouched"
        );
        // Ack lookup reaches a registered (non-key) workspace via the scan.
        assert_eq!(
            book.key_for_workspace("c:\\ws\\b").map(String::as_str),
            Some("c:\\ws\\a")
        );

        // Dedicated-mode rebind still re-keys 1:1: same route, new key, and
        // the workspaces list collapses back to the single bound workspace.
        let route = book.rekey_active("c:\\ws\\c".to_string(), PathBuf::from("C:\\ws\\c"));
        assert_eq!(route, "route-1", "route id must not change on rebind");
        assert_eq!(book.active_key, "c:\\ws\\c");
        assert_eq!(book.entries["c:\\ws\\c"].workspaces, vec!["c:\\ws\\c"]);
        assert!(!book.entries.contains_key("c:\\ws\\a"));
        assert_eq!(
            book.route_to_key.get("route-1").map(String::as_str),
            Some("c:\\ws\\c")
        );
    }

    #[test]
    fn activity_snapshot_reports_every_bound_workspace() {
        let activity = Mutex::new(HostActivity::default());
        assert!(observe_host_activity(
            &activity,
            &runtime_line("a", "running")
        ));

        let snapshot: HostActivitySnapshot = host_activity_snapshot(
            Path::new("C:\\ws\\a"),
            &["c:\\ws\\a".to_string(), "c:\\ws\\b".to_string()],
            &activity,
        )
        .expect("snapshot for a bound entry");
        // cwd mirrors the first binding for old renderers; cwds lists every
        // workspace the shared Host serves.
        assert_eq!(snapshot.cwd, "C:\\ws\\a");
        assert_eq!(snapshot.cwds, vec!["c:\\ws\\a", "c:\\ws\\b"]);
        assert!(snapshot.busy);

        // The bootstrap entry (no workspace yet) is filtered out.
        assert!(host_activity_snapshot(Path::new(""), &[], &activity).is_none());
    }
}
