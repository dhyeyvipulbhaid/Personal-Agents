//! Starts the packaged agent host and brings it back if it exits.
//! The host is a child process. It is not given a listening socket.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::audit;
use crate::keychain::SecretStore;
use crate::rpc::{audit_line, encode_request_params, parse_response, FrameParser};

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
    keys: crate::keychain::SessionKeys,
    adopted: AtomicBool,
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
            keys: crate::keychain::SessionKeys::new(),
            adopted: AtomicBool::new(false),
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
        if version.is_empty() || version.len() > 64 || version.chars().any(|ch| ch.is_control()) {
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
            match self
                .inner
                .call_params_timeout(method, params.clone(), timeout)
            {
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

    fn ensure_unlocked(&self) -> Result<(), String> {
        self.inner.ensure_unlocked()
    }

    fn obtain_key_once(&self) -> Result<String, String> {
        self.inner.obtain_key_once()
    }

    fn clear_keys(&self) {
        self.inner.keys.clear();
    }

    fn remember_key(&self, key: String) {
        self.inner.keys.remember(key);
    }

    fn data_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    fn unlock_with(&self, key: &str) -> Result<(), String> {
        self.inner.unlock_host(key)
    }

    /// Wait until the host is up, then run one call. Failures are not retried.
    fn call_once(&self, method: &str, params: Option<serde_json::Value>) -> Result<String, String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            match self.inner.call("version") {
                Ok(_) => {
                    return match params {
                        Some(params) => {
                            self.inner.call_params_timeout(method, params, CALL_TIMEOUT)
                        }
                        None => self.inner.call(method),
                    };
                }
                Err(err) if err == "agent host is not running" => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(err) => return Err(err),
            }
        }
        Err("agent host is not running".into())
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
    tauri::async_runtime::spawn_blocking(move || {
        host.call_params_when_ready("approval_act", params)
    })
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

async fn call_memory(
    host: tauri::State<'_, HostHandle>,
    method: &'static str,
    params: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.ensure_unlocked()?;
        match params {
            Some(params) => host.call_params_when_ready_timeout(method, params, timeout),
            None => host.call_when_ready(method),
        }
    })
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
pub async fn browser_activity(
    host: tauri::State<'_, HostHandle>,
    visible: Option<bool>,
) -> Result<String, String> {
    call_host_params(
        host,
        "browser_activity",
        serde_json::json!({ "visible": visible.unwrap_or(true) }),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn browser_stop(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_host(host, "browser_stop").await
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
    call_memory(host, "memory_list", None, CALL_TIMEOUT).await
}

#[tauri::command]
pub async fn memory_page(
    host: tauri::State<'_, HostHandle>,
    limit: Option<u32>,
    offset: Option<u32>,
    query: Option<String>,
    entity: Option<String>,
    kind: Option<String>,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_page",
        Some(serde_json::json!({
            "limit": limit,
            "offset": offset,
            "query": query.unwrap_or_default(),
            "entity": entity.unwrap_or_default(),
            "kind": kind.unwrap_or_default(),
        })),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_remember(
    host: tauri::State<'_, HostHandle>,
    text: String,
    session_id: Option<String>,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_remember",
        Some(serde_json::json!({ "text": text, "sessionId": session_id.unwrap_or_default() })),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_update(
    host: tauri::State<'_, HostHandle>,
    id: String,
    text: String,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_update",
        Some(serde_json::json!({ "id": id, "text": text })),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_delete(
    host: tauri::State<'_, HostHandle>,
    id: String,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_delete",
        Some(serde_json::json!({ "id": id })),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_delete_many(
    host: tauri::State<'_, HostHandle>,
    ids: Vec<String>,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_delete_many",
        Some(serde_json::json!({ "ids": ids })),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_sweep(
    host: tauri::State<'_, HostHandle>,
    dry_run: Option<bool>,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_sweep",
        Some(serde_json::json!({ "dryRun": dry_run.unwrap_or(true) })),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_graph(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_memory(host, "memory_graph", None, CALL_TIMEOUT).await
}

#[tauri::command]
pub async fn memory_observations(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_memory(host, "memory_observations", None, CALL_TIMEOUT).await
}

#[tauri::command]
pub async fn memory_reflect(
    host: tauri::State<'_, HostHandle>,
    query: Option<String>,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_reflect",
        Some(serde_json::json!({ "query": query.unwrap_or_default() })),
        CHAT_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_settings(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    call_memory(host, "memory_settings", None, CALL_TIMEOUT).await
}

#[tauri::command]
pub async fn memory_save_settings(
    host: tauri::State<'_, HostHandle>,
    embedding_model: Option<String>,
    include_observations: Option<bool>,
) -> Result<String, String> {
    call_memory(
        host,
        "memory_save_settings",
        Some(serde_json::json!({
            "embeddingModel": embedding_model.unwrap_or_default(),
            "includeObservations": include_observations,
        })),
        CALL_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn memory_enable_encryption(
    host: tauri::State<'_, HostHandle>,
) -> Result<String, String> {
    let inner = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        inner.clear_keys();
        match inner.obtain_key_once() {
            Ok(key) => {
                remove_passphrase(inner.data_dir());
                inner.call_once(
                    "memory_adopt_encryption",
                    Some(serde_json::json!({
                        "key": key,
                        "denied": false,
                        "mode": "keychain",
                        "force": true,
                    })),
                )
            }
            Err(err) if crate::keychain::is_keychain_denial(&err) => {
                let _ = inner.call_once(
                    "memory_adopt_encryption",
                    Some(serde_json::json!({ "denied": true })),
                );
                Err(crate::keychain::DENIED_MESSAGE.into())
            }
            Err(err) => Err(err),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn memory_enable_passphrase(
    host: tauri::State<'_, HostHandle>,
    passphrase: String,
) -> Result<String, String> {
    let inner = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (key, seal) = crate::keychain::seal_passphrase(&passphrase)?;
        save_passphrase(inner.data_dir(), &seal)?;
        inner.remember_key(key.clone());
        let result = inner.call_once(
            "memory_adopt_encryption",
            Some(serde_json::json!({
                "key": key,
                "denied": false,
                "mode": "passphrase",
                "force": true,
            })),
        );
        if result.is_err() {
            remove_passphrase(inner.data_dir());
            inner.clear_keys();
        }
        result.map(|value| crate::keychain::redact(&value, &key))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn memory_unlock_passphrase(
    host: tauri::State<'_, HostHandle>,
    passphrase: String,
) -> Result<String, String> {
    let inner = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let seal = load_passphrase(inner.data_dir())?;
        let key = crate::keychain::open_passphrase(&passphrase, &seal)?;
        inner.remember_key(key.clone());
        inner
            .unlock_with(&key)
            .map(|()| crate::keychain::redact("unlocked", &key))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn memory_keep_plaintext(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let inner = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        inner.clear_keys();
        inner.call_once("memory_keep_plaintext", None)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn memory_disable_encryption(
    host: tauri::State<'_, HostHandle>,
) -> Result<String, String> {
    let inner = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = inner.call_once("memory_disable_encryption", None);
        if result.is_ok() {
            inner.clear_keys();
            remove_passphrase(inner.data_dir());
        }
        result
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn memory_retry_keychain(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let inner = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        inner.clear_keys();
        match inner.obtain_key_once() {
            Ok(key) => inner.call_once(
                "memory_adopt_encryption",
                Some(serde_json::json!({
                    "key": key,
                    "denied": false,
                    "mode": "keychain",
                    "force": true,
                })),
            ),
            Err(err) if crate::keychain::is_keychain_denial(&err) => {
                Err(crate::keychain::DENIED_MESSAGE.into())
            }
            Err(err) => Err(err),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn memory_restore_backup(host: tauri::State<'_, HostHandle>) -> Result<String, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.call_when_ready("memory_restore"))
        .await
        .map_err(|err| err.to_string())?
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
                self.log_line(&format!("host-spawn-error: {err} ({})", self.bin.display()));
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
                self.adopt_encryption_once();
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

    fn adopt_encryption_once(&self) {
        if self.adopted.swap(true, Ordering::SeqCst) {
            return;
        }
        let choice = encryption_choice(&self.data_dir);
        if choice == "off" || choice == "passphrase" || passphrase_saved(&self.data_dir) {
            return;
        }
        match self.obtain_key_once() {
            Ok(key) => {
                let params = serde_json::json!({ "key": key, "denied": false, "mode": "keychain" });
                match self.call_params_timeout("memory_adopt_encryption", params, CALL_TIMEOUT) {
                    Ok(_) => self.log_line("memory-encrypt: opened"),
                    Err(err) => self.log_line(&format!(
                        "memory-encrypt: {}",
                        crate::keychain::redact(&err, &key)
                    )),
                }
            }
            Err(err)
                if crate::keychain::is_keychain_denial(&err)
                    || err.contains("macOS Keychain or Windows Credential Manager") =>
            {
                let _ = self.call_params_timeout(
                    "memory_adopt_encryption",
                    serde_json::json!({ "denied": true }),
                    CALL_TIMEOUT,
                );
                self.log_line("memory-unlock: Keychain access was denied");
            }
            Err(err) => self.log_line(&format!("memory-unlock: {err}")),
        }
    }

    /// Create or read the keychain key at most once for this process.
    fn obtain_key_once(&self) -> Result<String, String> {
        match self.keys.retry(&crate::keychain::OsSecretStore) {
            Ok(key) => Ok(key),
            Err(err) if err == crate::keychain::MISSING_KEY_MESSAGE => {
                let created = crate::keychain::generate_key()?;
                if let Err(err) = crate::keychain::OsSecretStore.set(&created) {
                    if crate::keychain::is_keychain_denial(&err) {
                        self.keys.deny();
                    }
                    return Err(err);
                }
                self.keys.clear();
                let read = self.keys.read(&crate::keychain::OsSecretStore)?;
                if read != created {
                    self.keys.clear();
                    return Err(
                        "The memory key could not be read back from the macOS Keychain or Windows Credential Manager. Memory was not encrypted."
                            .into(),
                    );
                }
                Ok(created)
            }
            Err(err) => Err(err),
        }
    }

    fn ensure_unlocked(&self) -> Result<(), String> {
        if !encryption_enabled(&self.data_dir) {
            return Ok(());
        }
        if passphrase_saved(&self.data_dir) || encryption_choice(&self.data_dir) == "passphrase" {
            let Some(key) = self.keys.remembered() else {
                return Err("Enter the memory passphrase to unlock.".into());
            };
            return self.unlock_host(&key);
        }
        let key = self.keys.read(&crate::keychain::OsSecretStore)?;
        self.unlock_host(&key)
    }

    fn unlock_host(&self, key: &str) -> Result<(), String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = "agent host is not running".to_string();
        while Instant::now() < deadline {
            match self.call_params_timeout(
                "memory_unlock",
                serde_json::json!({ "key": key }),
                CALL_TIMEOUT,
            ) {
                Ok(_) => return Ok(()),
                Err(err) if err == "agent host is not running" => {
                    last = err;
                    thread::sleep(Duration::from_millis(50));
                }
                Err(err) => return Err(crate::keychain::redact(&err, key)),
            }
        }
        Err(crate::keychain::redact(&last, key))
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
        let (sender, receiver) = mpsc::sync_channel(1);
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
    let mut parser = FrameParser::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => match parser.push(&chunk[..count]) {
                Ok(frames) => {
                    for body in frames {
                        handle_host_frame(&body, &pending, &audit);
                    }
                }
                Err(_) => parser.clear(),
            },
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
        return Err(format!("agent host binary missing at {}", path.display()));
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

fn encryption_choice(data_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(data_dir.join("memory-settings.json")) else {
        return String::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return String::new();
    };
    value
        .get("encryptionChoice")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string()
}

fn passphrase_path(data_dir: &Path) -> PathBuf {
    data_dir.join("memory-passphrase.json")
}

fn passphrase_saved(data_dir: &Path) -> bool {
    passphrase_path(data_dir).is_file()
}

fn save_passphrase(data_dir: &Path, seal: &crate::keychain::PassphraseSeal) -> Result<(), String> {
    let body = serde_json::json!({ "salt": seal.salt, "check": seal.check });
    std::fs::write(passphrase_path(data_dir), format!("{body}\n")).map_err(|err| err.to_string())
}

fn load_passphrase(data_dir: &Path) -> Result<crate::keychain::PassphraseSeal, String> {
    let text = std::fs::read_to_string(passphrase_path(data_dir))
        .map_err(|_| "Enter the memory passphrase to unlock.".to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| "The passphrase record is not valid.".to_string())?;
    let salt = value
        .get("salt")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    let check = value
        .get("check")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    if salt.is_empty() || check.is_empty() {
        return Err("The passphrase record is not valid.".into());
    }
    Ok(crate::keychain::PassphraseSeal { salt, check })
}

fn remove_passphrase(data_dir: &Path) {
    let _ = std::fs::remove_file(passphrase_path(data_dir));
}

fn encryption_enabled(data_dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(data_dir.join("memory-settings.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    value
        .get("encryptionEnabled")
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
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
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
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
