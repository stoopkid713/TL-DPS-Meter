// TL-DPS-Meter party overlay — Tauri v2 shell.
//
// A transparent, frameless, always-on-top window that loads ../src/index.html (the
// room-spectator scoreboard) with ?code=&name= from CLI args. Click-through is owned
// here in Rust: `set_ignore_cursor_events` toggled by a button (IPC) or the global
// Ctrl+Shift+O hotkey, mirroring the original Electron overlay's behaviour.
//
// Launched by the main app's open_overlay command as a separate process:
//   tldps-overlay.exe --code ABCD --name "Player"

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Click-through state. true = locked = clicks pass through to the game.
struct LockState(AtomicBool);

fn apply_lock(app: &tauri::AppHandle, locked: bool) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_ignore_cursor_events(locked);
    }
    app.state::<LockState>().0.store(locked, Ordering::SeqCst);
    // Notify the renderer so it can update the lock icon / hint.
    let _ = app.emit("lock-changed", locked);
}

#[tauri::command]
fn toggle_lock(app: tauri::AppHandle) -> bool {
    let next = !app.state::<LockState>().0.load(Ordering::SeqCst);
    apply_lock(&app, next);
    next
}

#[tauri::command]
fn get_lock_state(app: tauri::AppHandle) -> bool {
    app.state::<LockState>().0.load(Ordering::SeqCst)
}

#[tauri::command]
fn close_overlay(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse `--code <CODE>` / `--name <NAME>` (matches the original overlay.exe contract).
    let args: Vec<String> = std::env::args().collect();
    let mut code = String::new();
    let mut name = String::from("Overlay");
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--code" => {
                if i + 1 < args.len() {
                    code = args[i + 1].clone();
                    i += 1;
                }
            }
            "--name" => {
                if i + 1 < args.len() {
                    name = args[i + 1].clone();
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let url_path = format!(
        "index.html?code={}&name={}",
        urlencoding::encode(&code),
        urlencoding::encode(&name)
    );

    tauri::Builder::default()
        .manage(LockState(AtomicBool::new(false)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            toggle_lock,
            get_lock_state,
            close_overlay
        ])
        .setup(move |app| {
            let win = WebviewWindowBuilder::new(
                app,
                "overlay",
                WebviewUrl::App(url_path.clone().into()),
            )
            .title("Party DPS Overlay")
            .inner_size(340.0, 520.0)
            .min_inner_size(260.0, 300.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(false)
            .resizable(true)
            .build()?;

            // Park it top-right of the primary monitor (the original did the same).
            if let Ok(Some(mon)) = win.primary_monitor() {
                let size = mon.size();
                let scale = mon.scale_factor();
                let win_w = 340.0 * scale;
                let x = (size.width as f64) - win_w - 24.0;
                let _ = win.set_position(PhysicalPosition::new(x.max(0.0), 48.0));
            }

            // Global hotkey: Ctrl+Shift+O toggles click-through (the only way back to
            // interactive once locked, since clicks pass through while locked).
            let handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut("CmdOrCtrl+Shift+O", move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let cur = handle.state::<LockState>().0.load(Ordering::SeqCst);
                        apply_lock(&handle, !cur);
                    }
                })?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tldps-overlay");
}
