use std::sync::{Arc, Mutex};
use std::thread;

use mp_core::audio::output_cpal;
use mp_core::audio::synth::Player;
use mp_core::rustysynth::MidiFile;

/// Holds the shared synth `Player` (behind a `Mutex`, safe to share across
/// Tauri's command-handling threads) and the currently-loaded MIDI file (so
/// play/stop/speed commands don't need to re-pass MIDI bytes on every call).
///
/// The `cpal::Stream` that actually pulls audio from `Player` is NOT held
/// here: cpal's `Stream` is deliberately `!Send + !Sync` on every backend
/// (platform audio handles aren't safe to share across threads), which is
/// incompatible with Tauri's managed state (shared across its async command
/// threads). Instead it's created and kept alive for the whole app lifetime
/// on a dedicated, parked thread spawned in `AudioState::new` — the thread
/// does nothing but hold the stream open; all actual control (play/stop/
/// speed) happens through the shared `Player` the stream's callback reads
/// from, not through the stream handle itself.
pub struct AudioState {
    pub player: Arc<Mutex<Player>>,
    pub current_midi: Mutex<Option<Arc<MidiFile>>>,
}

impl AudioState {
    /// `sample_rate` is ignored if the output device reports its own native
    /// rate (see `output_cpal::default_output_sample_rate`'s doc comment for
    /// why matching it exactly matters) — kept as a fallback for the rare
    /// case no output device is found at all, letting the synth still
    /// construct even though playback won't work until one appears.
    pub fn new(soundfont_bytes: &[u8], fallback_sample_rate: i32) -> Result<Self, String> {
        let sample_rate = output_cpal::default_output_sample_rate()
            .map(|r| r as i32)
            .unwrap_or_else(|e| {
                eprintln!(
                    "warning: could not query output device sample rate ({e}), \
                     falling back to {fallback_sample_rate}Hz"
                );
                fallback_sample_rate
            });

        let player = Arc::new(Mutex::new(
            Player::new(soundfont_bytes, sample_rate).map_err(|e| e.to_string())?,
        ));

        let player_for_stream = player.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        thread::spawn(move || {
            let stream_result = output_cpal::start_output_stream(player_for_stream);
            match stream_result {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    // Park forever: `stream` staying alive (never dropped)
                    // is this thread's entire job — dropping it would stop
                    // audio output. `stream` is kept alive simply by still
                    // being in scope across the parking loop.
                    loop {
                        thread::park();
                        std::hint::black_box(&stream);
                    }
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                }
            }
        });
        ready_rx
            .recv()
            .map_err(|e| format!("audio thread died before starting: {e}"))??;

        Ok(Self {
            player,
            current_midi: Mutex::new(None),
        })
    }

    pub fn load_midi(&self, midi_bytes: &[u8]) -> Result<(), String> {
        let midi_file = self
            .player
            .lock()
            .unwrap()
            .load_midi(midi_bytes)
            .map_err(|e| e.to_string())?;
        *self.current_midi.lock().unwrap() = Some(midi_file);
        Ok(())
    }

    pub fn play(&self, play_loop: bool) -> Result<(), String> {
        let midi_file = self
            .current_midi
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no midi file loaded".to_string())?;
        self.player.lock().unwrap().play(&midi_file, play_loop);
        Ok(())
    }

    pub fn stop(&self) {
        self.player.lock().unwrap().stop();
    }

    pub fn set_speed(&self, speed: f64) {
        self.player.lock().unwrap().set_speed(speed);
    }

    pub fn position_secs(&self) -> f64 {
        self.player.lock().unwrap().position_secs()
    }
}
