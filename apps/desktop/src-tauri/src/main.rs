//! Desktop window. The page is bundled with the app, so the process does not
//! listen on a network port. The agent host is a child process on stdin and
//! stdout, and it does not listen either.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audit;
mod host;
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
            host::approval_act
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

fn open_window(app: &mut tauri::App) -> tauri::Result<()> {
    // Per-user WebView profile, outside the install folder:
    // Windows: %LOCALAPPDATA%\com.personalagents.desktop
    // macOS: ~/Library/Application Support/com.personalagents.desktop
    let data_dir = app.path().app_local_data_dir()?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Personal Agents")
        .inner_size(800.0, 600.0)
        .data_directory(data_dir)
        .build()?;
    Ok(())
}
