//! Starts the packaged agent host and brings it back if it exits.
//! The host is a child process. It is not given a listening socket.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::rpc::{encode_request, next_frame, parse_response};

const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct HostHandle {
    inner: Arc<HostInner>,
}

struct HostInner {
    bin: PathBuf,
    log: Mutex<std::fs::File>,
    active: Mutex<Option<Active>>,
    pid: Mutex<Option<u32>>,
    stopped: AtomicBool,
    next_id: AtomicU64,
}

struct Active {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Pending>,
}

type Pending = Mutex<HashMap<u64, SyncSender<Result<String, String>>>>;

impl HostHandle {
    pub fn start(app: &tauri::App) -> Result<Self, String> {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|err| err.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("host.log"))
            .map_err(|err| err.to_string())?;
        let bin = match sidecar_path() {
            Ok(path) => path,
            Err(err) => {
                let _ = writeln!(log, "host-spawn-error: {err}");
                let _ = log.flush();
                return Err(err);
            }
        };
        let inner = Arc::new(HostInner {
            bin,
            log: Mutex::new(log),
            active: Mutex::new(None),
            pid: Mutex::new(None),
            stopped: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
        });
        let supervisor = Arc::clone(&inner);
        thread::Builder::new()
            .name("agent-host-supervisor".into())
            .spawn(move || supervisor.supervise())
            .map_err(|err| err.to_string())?;
        Ok(Self { inner })
    }

    pub fn stop(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        if let Some(pid) = *self.inner.pid.lock().unwrap() {
            kill_pid(pid);
        }
    }

    pub fn note_displayed(&self, version: &str) -> Result<(), String> {
        if version.is_empty()
            || version.len() > 64
            || version.chars().any(|ch| ch.is_control())
        {
            return Err("invalid version".into());
        }
        self.inner
            .log_line(&format!("displayed-host-version: {version}"));
        Ok(())
    }

    fn call_when_ready(&self, method: &str) -> Result<String, String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "agent host is not running".to_string();
        while Instant::now() < deadline {
            match self.inner.call(method) {
                Ok(value) => return Ok(value),
                Err(err) => {
                    last = err;
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
        Err(last)
    }
}

#[tauri::command]
pub async fn host_version(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.call_when_ready("version"))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn widgets(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.call_when_ready("widgets"))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn note_displayed_host_version(
    host: tauri::State<'_, HostHandle>,
    version: String,
) -> Result<(), String> {
    host.note_displayed(&version)
}

impl HostInner {
    fn supervise(self: Arc<Self>) {
        // After a host that stayed up is killed, the next wait is the shortest
        // delay. Repeated failures wait longer, and the wait never reaches 3s.
        let mut delay_index = 0u32;
        while !self.stopped.load(Ordering::SeqCst) {
            let started = Instant::now();
            let healthy = self.run_once();
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }
            let delay = restart_delay(delay_index);
            if healthy && started.elapsed() >= Duration::from_secs(1) {
                delay_index = 0;
            } else {
                delay_index = (delay_index + 1).min(4);
            }
            self.sleep_backoff(delay);
        }
    }

    fn run_once(self: &Arc<Self>) -> bool {
        let mut child = match host_command(&self.bin).spawn() {
            Ok(child) => child,
            Err(err) => {
                self.log_line(&format!(
                    "host-spawn-error: {err} ({})",
                    self.bin.display()
                ));
                return false;
            }
        };
        let pid = child.id();
        *self.pid.lock().unwrap() = Some(pid);

        let Some(stdin) = child.stdin.take() else {
            return self.fail_spawn(&mut child, "stdin was not piped");
        };
        let Some(stdout) = child.stdout.take() else {
            return self.fail_spawn(&mut child, "stdout was not piped");
        };
        let Some(stderr) = child.stderr.take() else {
            return self.fail_spawn(&mut child, "stderr was not piped");
        };

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = Arc::clone(&pending);
        let reader = thread::spawn(move || read_stdout(stdout, reader_pending));
        let stderr_host = Arc::clone(self);
        let stderr_thread = thread::spawn(move || read_stderr(stderr, &stderr_host));

        {
            let mut slot = self.active.lock().unwrap();
            *slot = Some(Active {
                stdin: Mutex::new(stdin),
                pending: Arc::clone(&pending),
            });
        }

        let healthy = match self.call("version") {
            Ok(version) => {
                self.log_line(&format!("host-started pid={pid} version={version}"));
                true
            }
            Err(err) => {
                self.log_line(&format!("host-start-error: {err}"));
                let _ = child.kill();
                false
            }
        };
        let _ = child.wait();
        self.log_line(&format!("host-exit pid={pid}"));
        *self.pid.lock().unwrap() = None;
        self.clear_active();
        let _ = reader.join();
        let _ = stderr_thread.join();
        healthy
    }

    fn fail_spawn(&self, child: &mut std::process::Child, reason: &str) -> bool {
        self.log_line(&format!("host-spawn-error: {reason}"));
        let _ = child.kill();
        let _ = child.wait();
        *self.pid.lock().unwrap() = None;
        false
    }

    fn call(&self, method: &str) -> Result<String, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver): (
            SyncSender<Result<String, String>>,
            Receiver<Result<String, String>>,
        ) = mpsc::sync_channel(1);
        let pending = {
            let slot = self.active.lock().unwrap();
            let Some(active) = slot.as_ref() else {
                return Err("agent host is not running".into());
            };
            let pending = Arc::clone(&active.pending);
            pending.lock().unwrap().insert(id, sender);
            let frame = encode_request(id, method)?;
            let write = {
                let mut stdin = active.stdin.lock().unwrap();
                stdin.write_all(&frame).and_then(|_| stdin.flush())
            };
            if let Err(err) = write {
                pending.lock().unwrap().remove(&id);
                return Err(err.to_string());
            }
            pending
        };
        match receiver.recv_timeout(CALL_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                pending.lock().unwrap().remove(&id);
                Err("agent host timed out".into())
            }
        }
    }

    fn clear_active(&self) {
        let mut slot = self.active.lock().unwrap();
        if let Some(active) = slot.take() {
            active.pending.lock().unwrap().clear();
        }
    }

    fn sleep_backoff(&self, delay: Duration) {
        let step = Duration::from_millis(50);
        let mut left = delay;
        while !left.is_zero() && !self.stopped.load(Ordering::SeqCst) {
            let slice = if left > step { step } else { left };
            thread::sleep(slice);
            left = left.saturating_sub(slice);
        }
    }

    fn log_line(&self, line: &str) {
        let mut file = self.log.lock().unwrap();
        let _ = writeln!(file, "{}", line.replace(['\n', '\r'], " "));
        let _ = file.flush();
    }
}

fn read_stdout(mut stdout: ChildStdout, pending: Arc<Pending>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if buffer.len() > MAX_BUFFER {
            break;
        }
        match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                loop {
                    match next_frame(&mut buffer) {
                        Ok(None) => break,
                        Ok(Some(body)) => deliver(&pending, &body),
                        Err(_) => return,
                    }
                }
            }
        }
    }
}

fn deliver(pending: &Pending, body: &[u8]) {
    let Ok((id, result)) = parse_response(body) else {
        return;
    };
    let Some(sender) = pending.lock().unwrap().remove(&id) else {
        return;
    };
    let _ = sender.send(result);
}

fn read_stderr(stderr: ChildStderr, host: &HostInner) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        let trimmed = line.trim_end();
        if !trimmed.is_empty() {
            let shown: String = trimmed.chars().take(500).collect();
            host.log_line(&format!("host-stderr: {shown}"));
        }
        line.clear();
    }
}

const MAX_BUFFER: usize = 1_000_000;

/// The packaged host sits next to this executable. The bundler copies
/// `binaries/agent-host-<target>` to that plain name.
fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let dir = exe
        .parent()
        .ok_or("missing executable directory")?
        .to_path_buf();
    let name = if cfg!(windows) {
        "agent-host.exe"
    } else {
        "agent-host"
    };
    let path = dir.join(name);
    if !path.is_file() {
        return Err(format!(
            "agent host binary missing at {}",
            path.display()
        ));
    }
    Ok(path)
}

fn host_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = path.parent() {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn kill_pid(pid: u32) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

/// 100ms, 200ms, 400ms, 800ms, then 1000ms. The cap stays under 3 seconds.
fn restart_delay(index: u32) -> Duration {
    let shift = index.min(4);
    let millis = 100u64 << shift;
    Duration::from_millis(millis.min(1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_delay_backs_off_and_stays_under_three_seconds() {
        assert_eq!(restart_delay(0), Duration::from_millis(100));
        assert_eq!(restart_delay(1), Duration::from_millis(200));
        assert_eq!(restart_delay(2), Duration::from_millis(400));
        assert_eq!(restart_delay(3), Duration::from_millis(800));
        assert_eq!(restart_delay(4), Duration::from_millis(1000));
        assert_eq!(restart_delay(9), Duration::from_millis(1000));
        assert!(restart_delay(9) < Duration::from_secs(3));
    }
}
