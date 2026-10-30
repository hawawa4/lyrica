//! Thin Tauri wrappers over `mp_core::updater`. Nothing here runs on its own:
//! the frontend asks for a check (once, when the library view loads) and
//! starts an install only when the user clicks the update notice.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use mp_core::updater::{self, Client, Progress, UpdateInfo};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// One install at a time, and the executable to relaunch once a new version
/// is on disk.
#[derive(Default)]
pub struct UpdateState {
    installing: AtomicBool,
    relaunch: Mutex<Option<PathBuf>>,
}

/// Clears `installing` however the install ends.
struct InstallGuard<'a>(&'a AtomicBool);

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// These block on the network, so they run on the blocking pool: a sync
/// command would stall the main thread (and with it the UI).
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        updater::check(&Client::default(), updater::current_version())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Downloads and installs the latest release, streaming progress over
/// `on_progress`. The running app keeps going; `restart_app` switches to the
/// new version. For `.deb` installs this raises the system password prompt.
#[tauri::command]
pub async fn install_update(
    state: State<'_, UpdateState>,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("an update is already being installed".into());
    }
    let _guard = InstallGuard(&state.installing);

    let path = tauri::async_runtime::spawn_blocking(move || {
        updater::install_latest(&Client::default(), updater::current_version(), &mut |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    *state.relaunch.lock().unwrap() = Some(path);
    Ok(())
}

/// Relaunches Lyrica so an installed update takes effect.
#[tauri::command]
pub fn restart_app(app: AppHandle, state: State<UpdateState>) -> Result<(), String> {
    let path = state
        .relaunch
        .lock()
        .unwrap()
        .clone()
        .ok_or("no update has been installed")?;
    updater::relaunch(&path).map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
