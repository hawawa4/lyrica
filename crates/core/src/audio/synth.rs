use std::io::Cursor;
use std::sync::Arc;

use rustysynth::{MidiFile, MidiFileSequencer, SoundFont, Synthesizer, SynthesizerSettings};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SynthError {
    #[error("failed to load soundfont: {0}")]
    SoundFont(#[from] rustysynth::SoundFontError),
    #[error("failed to parse midi: {0}")]
    Midi(#[from] rustysynth::MidiFileError),
    #[error("failed to create synthesizer: {0}")]
    Synthesizer(#[from] rustysynth::SynthesizerError),
}

/// Wraps rustysynth's `Synthesizer` + `MidiFileSequencer` to play a loaded
/// MIDI file through a soundfont. `MidiFileSequencer::set_speed` is the
/// mechanism behind the 0.5x/0.75x/1.0x speed control in
/// IMPLEMENTATION_PLAN.md Phase 5: it scales the rate at which scheduled
/// events advance, never resampling audio, so pitch is untouched — exactly
/// the "reschedule, not re-derive" behavior the plan calls for, and it
/// already supports changing speed mid-playback (just call `set_speed`
/// again; no restart needed).
pub struct Player {
    sequencer: MidiFileSequencer,
    sample_rate: i32,
}

impl Player {
    pub fn new(soundfont_bytes: &[u8], sample_rate: i32) -> Result<Self, SynthError> {
        let sound_font = Arc::new(SoundFont::new(&mut Cursor::new(soundfont_bytes))?);
        let settings = SynthesizerSettings::new(sample_rate);
        let synthesizer = Synthesizer::new(&sound_font, &settings)?;
        Ok(Self {
            sequencer: MidiFileSequencer::new(synthesizer),
            sample_rate,
        })
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }

    pub fn load_midi(&self, midi_bytes: &[u8]) -> Result<Arc<MidiFile>, SynthError> {
        Ok(Arc::new(MidiFile::new(&mut Cursor::new(midi_bytes))?))
    }

    pub fn play(&mut self, midi_file: &Arc<MidiFile>, play_loop: bool) {
        self.sequencer.play(midi_file, play_loop);
    }

    pub fn stop(&mut self) {
        self.sequencer.stop();
    }

    /// Multiplies the playback tempo by this value; 1.0 is the recorded
    /// tempo. Pitch is never affected. Safe to call mid-playback.
    pub fn set_speed(&mut self, speed: f64) {
        self.sequencer.set_speed(speed);
    }

    /// Current position in the MIDI file's own timeline, in seconds.
    pub fn position_secs(&self) -> f64 {
        self.sequencer.get_position()
    }

    pub fn end_of_sequence(&self) -> bool {
        self.sequencer.end_of_sequence()
    }

    /// Renders the next block of audio into the given interleaved-free
    /// stereo buffers (equal length; called repeatedly by the output stream
    /// as it needs more samples).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.sequencer.render(left, right);
    }
}
