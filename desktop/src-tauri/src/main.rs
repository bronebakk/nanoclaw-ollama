// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The window points at the static bootstrap (../static/index.html), which
// polls http://127.0.0.1:3030 and redirects once the host is up. No Tauri
// commands or IPC — this binary is purely a webview shell.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
