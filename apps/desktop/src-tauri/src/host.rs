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

use crate::audit;
use crate::rpc::{audit_line, encode_request_params, next_frame, parse_response};

const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct HostHandle {
    inner: Arc<HostInner>,
}

struct HostInner {
    bin: PathBuf,
    data_dir: PathBuf,
    log: Mutex<std::fs::File>,
    audit: PathBuf,
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
        let data_dir = dir.clone();
        let inner = Arc::new(HostInner {
            bin,
            data_dir,
            log: Mutex::new(log),
            audit: dir.join("audit.log"),
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

    fn inner(&self) -> HostHandle {
        self.clone()
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

    fn audit_path(&self) -> PathBuf {
        self.inner.audit.clone()
    }

    fn call_params_when_ready(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<String, String> {
        self.call_params_when_ready_timeout(method, params, CALL_TIMEOUT)
    }

    fn call_params_when_ready_timeout(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<String, String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "agent host is not running".to_string();
        while Instant::now() < deadline {
            match self.inner.call_params_timeout(method, params.clone(), timeout) {
                Ok(value) => return Ok(value),
                Err(err) => {
                    if err == "agent host timed out" {
                        return Err(err);
                    }
                    last = err;
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
        Err(last)
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
pub async fn ollama_status(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.call_when_ready("ollama"))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn audit_log(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let lines = audit::read_audit_newest_first(&host.audit_path())?;
    serde_json::to_string(&lines).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn approvals(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.call_when_ready("approvals"))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn approval_act(
    host: tauri::State<'_, HostHandle>,
    action: String,
    id: String,
    draft: String,
    instruction: String,
    scope: String,
    until: u64,
) -> Result<String, String> {
    let host = host.inner().clone();
    let params = serde_json::json!({
        "action": action,
        "id": id,
        "draft": draft,
        "instruction": instruction,
        "scope": scope,
        "until": until,
    });
    tauri::async_runtime::spawn_blocking(move || host.call_params_when_ready("approval_act", params))
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

const CHAT_TIMEOUT: Duration = Duration::from_secs(120);

async fn call_host(
    host: tauri::State<'_, HostHandle>,
    method: &'static str,
) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.call_when_ready(method))
        .await
        .map_err(|err| err.to_string())?
}

async fn call_host_params(
    host: tauri::State<'_, HostHandle>,
    method: &'static str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.call_params_when_ready_timeout(method, params, timeout)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn revenue_status(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_host(host, "revenue_status").await
}

#[tauri::command]
pub async fn capabilities(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_host(host, "capabilities").await
}

#[tauri::command]
pub async fn list_models(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_host(host, "list_models").await
}

#[tauri::command]
pub async fn set_models(
    host: tauri::State<'_, HostHandle>,
    chat: String,
    agent: String,
    builder: String,
) -> Result<String, String> {
    call_host_params(
        host,
        "set_models",
        serde_json::json!({ "chat": chat, "agent": agent, "builder": builder }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn chat_state(
    host: tauri::State<'_, HostHandle>,
    session_id: Option<String>,
) -> Result<String, String> {
    call_host_params(
        host,
        "chat_state",
        serde_json::json!({ "sessionId": session_id.unwrap_or_default() }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn chat_send(
    host: tauri::State<'_, HostHandle>,
    text: String,
    session_id: Option<String>,
) -> Result<String, String> {
    call_host_params(
        host,
        "chat_send",
        serde_json::json!({ "text": text, "sessionId": session_id.unwrap_or_default() }),
        CHAT_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn chat_stop(
    host: tauri::State<'_, HostHandle>,
    session_id: Option<String>,
) -> Result<String, String> {
    call_host_params(
        host,
        "chat_stop",
        serde_json::json!({ "sessionId": session_id.unwrap_or_default() }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn chat_approve(
    host: tauri::State<'_, HostHandle>,
    id: String,
    action: Option<String>,
) -> Result<String, String> {
    call_host_params(
        host,
        "chat_approve",
        serde_json::json!({
            "id": id,
            "action": action.unwrap_or_else(|| "approve".to_string()),
        }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn chat_new(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_host(host, "chat_new").await
}

#[tauri::command]
pub async fn chat_open(
    host: tauri::State<'_, HostHandle>,
    session_id: String,
) -> Result<String, String> {
    call_host_params(
        host,
        "chat_open",
        serde_json::json!({ "sessionId": session_id }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn mail_state(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_host(host, "mail_state").await
}

#[tauri::command]
pub async fn mail_draft(host: tauri::State<'_, HostHandle>, id: String) -> Result<String, String> {
    call_host_params(
        host,
        "mail_draft",
        serde_json::json!({ "id": id }),
        CHAT_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_list(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_host(host, "memory_list").await
}

#[tauri::command]
pub async fn memory_remember(
    host: tauri::State<'_, HostHandle>,
    text: String,
    session_id: Option<String>,
) -> Result<String, String> {
    call_host_params(
        host,
        "memory_remember",
        serde_json::json!({ "text": text, "sessionId": session_id.unwrap_or_default() }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_delete(
    host: tauri::State<'_, HostHandle>,
    id: String,
) -> Result<String, String> {
    call_host_params(
        host,
        "memory_delete",
        serde_json::json!({ "id": id }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn builder_plan(
    host: tauri::State<'_, HostHandle>,
    prompt: Option<String>,
    template: Option<String>,
) -> Result<String, String> {
    call_host_params(
        host,
        "builder_plan",
        serde_json::json!({
            "prompt": prompt.unwrap_or_default(),
            "template": template.unwrap_or_default(),
        }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn builder_install(
    host: tauri::State<'_, HostHandle>,
    prompt: Option<String>,
    template: Option<String>,
) -> Result<String, String> {
    call_host_params(
        host,
        "builder_install",
        serde_json::json!({
            "prompt": prompt.unwrap_or_default(),
            "template": template.unwrap_or_default(),
        }),
        CALL_TIMEOUT,
    )
    .await
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
        let mut child = match host_command(&self.bin, &self.data_dir).spawn() {
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
        let audit_path = self.audit.clone();
        let reader = thread::spawn(move || read_stdout(stdout, reader_pending, audit_path));
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

    fn call_params(&self, method: &str, params: serde_json::Value) -> Result<String, String> {
        self.call_params_timeout(method, params, CALL_TIMEOUT)
    }

    fn call_params_timeout(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<String, String> {
        self.call_frame(method, Some(params), timeout)
    }

    fn call(&self, method: &str) -> Result<String, String> {
        self.call_frame(method, None, CALL_TIMEOUT)
    }

    fn call_frame(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<String, String> {
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
            let frame = encode_request_params(id, method, params.as_ref())?;
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
        match receiver.recv_timeout(timeout) {
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

fn read_stdout(mut stdout: ChildStdout, pending: Arc<Pending>, audit: PathBuf) {
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
                        Ok(Some(body)) => handle_host_frame(&body, &pending, &audit),
                        Err(_) => return,
                    }
                }
            }
        }
    }
}

fn handle_host_frame(body: &[u8], pending: &Pending, audit: &std::path::Path) {
    if let Some(line) = audit_line(body) {
        let _ = audit::append_audit(audit, &line);
        return;
    }
    deliver(pending, body);
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

fn host_command(path: &Path, data_dir: &Path) -> Command {
    let mut command = Command::new(path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PA_DATA_DIR", data_dir);
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
