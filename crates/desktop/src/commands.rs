use mp_core::api::{self, ImportTimelineResponse, OpenFileRequest, OpenFileResponse, StaffSystem};
use mp_core::audio::midi_events::TempoMapEntry;
use mp_core::markers::Marker;
use mp_core::pdf_calibration::CalibrationPoint;
use mp_core::pieces::Piece;
use mp_core::recent_files::RecentFile;
use mp_core::timeline::Positions;
use tauri::{AppHandle, Manager, State};

use crate::audio_state::AudioState;

/// Markers are persisted under Tauri's own app-data directory (not committed
/// to git, survives app updates) — see `mp_core::sidecar`'s module docs for
/// why this is keyed by content hash rather than a path next to the file.
fn markers_base_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file(bytes: Vec<u8>, original_filename: String) -> Result<OpenFileResponse, String> {
    api::open_file(OpenFileRequest {
        bytes,
        original_filename,
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_timeline(
    positions: Positions,
    midi_bytes: Vec<u8>,
) -> Result<ImportTimelineResponse, String> {
    api::import_timeline(api::ImportTimelineRequest {
        positions,
        midi_bytes,
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_midi(audio: State<AudioState>, midi_bytes: Vec<u8>) -> Result<(), String> {
    audio.load_midi(&midi_bytes)
}

/// PDF mode (Phase 9): loads a calibration-derived tempo map for
/// metronome-only "playback" (no note data — see `AudioState::load_tempo_map`'s
/// docs for why this is safe to drive through the same `play`/`stop`/
/// `set_loop_region` commands as `.mscz` MIDI playback).
#[tauri::command]
pub fn load_tempo_map(audio: State<AudioState>, tempo_map: Vec<TempoMapEntry>, duration_ms: f64) {
    audio.load_tempo_map(tempo_map, duration_ms)
}

#[tauri::command]
pub fn play(audio: State<AudioState>, play_loop: bool) -> Result<(), String> {
    audio.play(play_loop)
}

#[tauri::command]
pub fn stop(audio: State<AudioState>) {
    audio.stop()
}

#[tauri::command]
pub fn set_speed(audio: State<AudioState>, speed: f64) {
    audio.set_speed(speed)
}

/// `region` is `(loop_start_ms, loop_end_ms)`; `None` clears the loop (so
/// playback runs to the end rather than wrapping).
#[tauri::command]
pub fn set_loop_region(audio: State<AudioState>, region: Option<(f64, f64)>) {
    audio.set_loop_region(region)
}

#[tauri::command]
pub fn set_metronome_enabled(audio: State<AudioState>, enabled: bool) {
    audio.set_metronome_enabled(enabled)
}

#[tauri::command]
pub fn playback_position(audio: State<AudioState>) -> f64 {
    audio.position_secs()
}

#[tauri::command]
pub fn list_markers(app: AppHandle, file_hash: String) -> Result<Vec<Marker>, String> {
    let base_dir = markers_base_dir(&app)?;
    api::list_markers(&base_dir, &file_hash).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_marker(
    app: AppHandle,
    file_hash: String,
    measure_index: u32,
    text: String,
) -> Result<Vec<Marker>, String> {
    let base_dir = markers_base_dir(&app)?;
    api::add_marker(&base_dir, &file_hash, measure_index, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_marker(app: AppHandle, file_hash: String, marker_id: String) -> Result<Vec<Marker>, String> {
    let base_dir = markers_base_dir(&app)?;
    api::delete_marker(&base_dir, &file_hash, &marker_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn detect_pieces(bytes: Vec<u8>) -> Result<Vec<Piece>, String> {
    api::detect_pieces(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_recent_files(app: AppHandle) -> Result<Vec<RecentFile>, String> {
    let base_dir = markers_base_dir(&app)?;
    api::list_recent_files(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_recent_file(
    app: AppHandle,
    path: String,
    file_hash: String,
    title: String,
) -> Result<Vec<RecentFile>, String> {
    let base_dir = markers_base_dir(&app)?;
    api::record_recent_file(&base_dir, path, file_hash, title).map_err(|e| e.to_string())
}

/// PDF mode (Phase 9): stable content-hash key for a PDF's bytes, same blake3
/// scheme `open_file` uses for `.mscz` (see `api::hash_bytes`'s docs).
#[tauri::command]
pub fn hash_bytes(bytes: Vec<u8>) -> String {
    api::hash_bytes(&bytes)
}

#[tauri::command]
pub fn list_calibration_points(app: AppHandle, file_hash: String) -> Result<Vec<CalibrationPoint>, String> {
    let base_dir = markers_base_dir(&app)?;
    api::list_calibration_points(&base_dir, &file_hash).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_calibration_points(
    app: AppHandle,
    file_hash: String,
    points: Vec<CalibrationPoint>,
) -> Result<Vec<CalibrationPoint>, String> {
    let base_dir = markers_base_dir(&app)?;
    api::save_calibration_points(&base_dir, &file_hash, points).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pdf_tempo_map(points: Vec<CalibrationPoint>, numerator: u8) -> Vec<TempoMapEntry> {
    api::pdf_tempo_map(&points, numerator)
}

/// Optional CV barline-detection assist (see `api::detect_barlines`'s docs).
#[tauri::command]
pub fn detect_barlines(png_bytes: Vec<u8>) -> Result<Vec<StaffSystem>, String> {
    api::detect_barlines(&png_bytes).map_err(|e| e.to_string())
}
