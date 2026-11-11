//! Desktop window. The page is bundled with the app, so the process does not
//! listen on a network port.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            open_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to open the Personal Agents window");
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
