//! Desktop window. The page is bundled with the app, so the process does not
//! listen on a network port. The agent host is a child process on stdin and
//! stdout, and it does not listen either.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audit;
mod host;
mod keychain;
mod rpc;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let host = host::HostHandle::start(app).map_err(std::io::Error::other)?;
            app.manage(host);
            open_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host::host_version,
            host::note_displayed_host_version,
            host::widgets,
            host::ollama_status,
            host::audit_log,
            host::approvals,
            host::approval_act,
            host::browser_activity,
            host::browser_stop,
            host::revenue_status,
            host::capabilities,
            host::list_models,
            host::set_models,
            host::chat_state,
            host::chat_send,
            host::chat_stop,
            host::chat_approve,
            host::chat_new,
            host::chat_open,
            host::mail_state,
            host::mail_draft,
            host::memory_list,
            host::memory_page,
            host::memory_remember,
            host::memory_update,
            host::memory_delete,
            host::memory_delete_many,
            host::memory_sweep,
            host::memory_graph,
            host::memory_observations,
            host::memory_reflect,
            host::memory_settings,
            host::memory_save_settings,
            host::memory_enable_encryption,
            host::builder_plan,
            host::builder_install,
            open_link
        ])
        .build(tauri::generate_context!())
        .expect("failed to open the Personal Agents window")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(host) = app.try_state::<host::HostHandle>() {
                    host.stop();
                }
            }
        });
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("only a web link can be opened".into());
    }
    let status = open_command(&url)
        .status()
        .map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("the link could not be opened".into())
    }
}

#[cfg(target_os = "macos")]
fn open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("open");
    command.arg(url);
    command
}

#[cfg(target_os = "windows")]
fn open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", "start", "", url]);
    command
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url);
    command
}

fn open_window(app: &mut tauri::App) -> tauri::Result<()> {
    // Per-user WebView profile, outside the install folder:
    // Windows: %LOCALAPPDATA%\com.personalagents.desktop
    // macOS: ~/Library/Application Support/com.personalagents.desktop
    let data_dir = app.path().app_local_data_dir()?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Personal Agents")
        .inner_size(1180.0, 800.0)
        .data_directory(data_dir)
        .build()?;
    Ok(())
}
