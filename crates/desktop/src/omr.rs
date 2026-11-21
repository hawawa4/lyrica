//! Thin Tauri wrappers over `mp_core::api`'s OMR measure detection (see
//! `mp_core::omr`). Audiveris needs ~1GB of RAM per run, so runs are queued
//! one at a time rather than started side by side for every PDF opened.

use std::path::PathBuf;
use std::sync::Mutex;

use mp_core::api;
use mp_core::omr::{MeasureBox, OmrProgress};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct OmrState {
    running: Mutex<()>,
}

#[tauri::command]
pub fn omr_available() -> bool {
    api::omr_available()
}

/// Recognises the measures of the PDF at `path`, streaming progress over
/// `on_progress`. Runs on the blocking pool: it takes seconds per page.
#[tauri::command]
pub async fn recognise_pdf_measures(
    app: AppHandle,
    file_hash: String,
    path: String,
    on_progress: Channel<OmrProgress>,
) -> Result<Vec<MeasureBox>, String> {
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<OmrState> = app.state();
        let _queue = state.running.lock().unwrap_or_else(|e| e.into_inner());
        api::recognise_pdf_measures(&base_dir, &file_hash, &PathBuf::from(path), &mut |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
