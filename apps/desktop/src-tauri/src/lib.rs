//! The desktop shell.
//!
//! Two things the browser cannot do on its own, and the only reasons this
//! wrapper exists:
//!
//!  1. The device token goes into the OS credential store — the macOS Keychain
//!     or the Windows Credential Manager — instead of `localStorage`, where any
//!     script on the page could read it and a disk backup would carry it away
//!     in clear.
//!  2. A tray icon that shows at a glance whether a GPU is running, which is
//!     the one thing worth knowing without opening anything.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// Namespace in the OS credential store.
const SERVICE: &str = "com.runpodlauncher.desktop";
const ACCOUNT: &str = "device-token";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Connection {
    pub base_url: String,
    pub token: String,
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())
}

/// Stores the pairing result. Called once, after pairing succeeds.
#[tauri::command]
fn save_connection(connection: Connection) -> Result<(), String> {
    let payload = serde_json::to_string(&connection).map_err(|error| error.to_string())?;
    entry()?
        .set_password(&payload)
        .map_err(|error| error.to_string())
}

/// Reads the stored connection, or `None` when this device is not paired yet.
#[tauri::command]
fn load_connection() -> Result<Option<Connection>, String> {
    match entry()?.get_password() {
        Ok(payload) => serde_json::from_str(&payload)
            .map(Some)
            .map_err(|error| error.to_string()),
        // A missing entry is the normal state before pairing, not a failure.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Forgets this device's credentials. Used when unpairing.
#[tauri::command]
fn clear_connection() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Updates the tray title with the pod state, so it reads at a glance.
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, running: bool, cost_per_hour: f64) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(());
    };
    // Shown next to the icon on macOS. Deliberately terse: the menu bar is not
    // the place for a sentence.
    let title = if running {
        format!("${cost_per_hour:.2}/h")
    } else {
        String::new()
    };
    tray.set_title(Some(title)).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            save_connection,
            load_connection,
            clear_connection,
            set_tray_status
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open launcher", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the launcher");
}
