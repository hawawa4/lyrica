#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_state;
mod commands;

use audio_state::AudioState;
use tauri::Manager;

/// Locates the bundled GM soundfont. Not committed to git (fetched via
/// `just fetch-soundfont` — see Justfile). Checked in two forms: the
/// Tauri-resolved resource path (set via `bundle.resources` in
/// `tauri.conf.json`, present in installed `.deb`/AppImage builds — see
/// `resource_dir`) and workspace-root-relative paths (for `cargo tauri dev`/
/// local debug builds run from the repo, where there is no resource dir).
fn find_soundfont(resource_dir: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("MuseScore_General.sf3"));
    }
    candidates.push(std::path::PathBuf::from("assets/MuseScore_General.sf3"));
    candidates.push(std::path::PathBuf::from(
        "../../assets/MuseScore_General.sf3",
    ));
    candidates.into_iter().find(|p| p.exists())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let audio_state = AudioState::new(44100)
                .unwrap_or_else(|e| panic!("failed to initialize audio: {e}"));
            // Decoding the .sf3 takes a couple of seconds; do it off the
            // startup path so the window doesn't wait on it. Playback started
            // before it finishes renders silence (clicks aside) until then.
            match find_soundfont(app.path().resource_dir().ok()) {
                Some(path) => audio_state.load_soundfont_in_background(path),
                None => eprintln!(
                    "warning: no soundfont found (expected assets/MuseScore_General.sf3); \
                     run `just fetch-soundfont`. Playback will be silent until then."
                ),
            }
            app.manage(audio_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::adapt_score_for_engine,
            commands::import_timeline,
            commands::load_midi,
            commands::load_tempo_map,
            commands::play,
            commands::stop,
            commands::pause,
            commands::resume,
            commands::seek,
            commands::set_speed,
            commands::set_loop_region,
            commands::set_metronome_enabled,
            commands::set_metronome_volume,
            commands::playback_position,
            commands::list_markers,
            commands::add_marker,
            commands::update_marker,
            commands::delete_marker,
            commands::detect_pieces,
            commands::get_knowledge_level,
            commands::set_knowledge_level,
            commands::get_knowledge_levels,
            commands::list_recent_files,
            commands::record_recent_file,
            commands::get_library_settings,
            commands::set_root_folder,
            commands::scan_library,
            commands::list_pinned_files,
            commands::pin_file,
            commands::unpin_file,
            commands::hash_bytes,
            commands::list_calibration_points,
            commands::save_calibration_points,
            commands::pdf_tempo_map,
            commands::detect_barlines,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
