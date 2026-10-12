#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_state;
mod commands;

use audio_state::AudioState;
use tauri::Manager;

/// Locates the bundled GM soundfont. Not committed to git (fetched via
/// `just fetch-soundfont` — see Justfile) and not yet wired into Tauri's
/// resource-bundling for packaged installers (a packaging concern for later;
/// this resolves relative to the workspace root, which only works for
/// `cargo tauri dev`/local debug builds run from the repo).
///
/// Uses FluidR3_GM.sf2, not MuseScore_General.sf2 (the plan's original
/// choice) — both are MIT-licensed, but MuseScore_General.sf2's piano
/// patches render at a fraction of FluidR3's volume through rustysynth
/// (confirmed via a controlled A/B render test: ~7x lower peak amplitude,
/// much less high-frequency content), apparently due to how it layers
/// velocity-crossfaded samples with real but unusually aggressive combined
/// attenuation. Not clearly a rustysynth bug — just a bad pairing with this
/// particular synth. FluidR3_GM renders at a normal, audible level.
fn find_soundfont() -> Option<std::path::PathBuf> {
    let candidates = ["assets/FluidR3_GM.sf2", "../../assets/FluidR3_GM.sf2"];
    candidates
        .iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.exists())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            match find_soundfont() {
                Some(path) => {
                    let bytes = std::fs::read(&path)
                        .unwrap_or_else(|e| panic!("failed to read soundfont at {path:?}: {e}"));
                    let audio_state = AudioState::new(&bytes, 44100)
                        .unwrap_or_else(|e| panic!("failed to initialize audio: {e}"));
                    app.manage(audio_state);
                }
                None => {
                    eprintln!(
                        "warning: no soundfont found (expected assets/FluidR3_GM.sf2); \
                         run `just fetch-soundfont`. Playback commands will fail until then."
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::import_timeline,
            commands::load_midi,
            commands::play,
            commands::stop,
            commands::set_speed,
            commands::playback_position,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
