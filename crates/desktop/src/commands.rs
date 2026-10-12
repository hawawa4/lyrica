use mp_core::api::{self, ImportTimelineResponse, OpenFileRequest, OpenFileResponse};
use mp_core::timeline::Positions;
use tauri::State;

use crate::audio_state::AudioState;

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

#[tauri::command]
pub fn playback_position(audio: State<AudioState>) -> f64 {
    audio.position_secs()
}
