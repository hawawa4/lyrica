use std::io::Cursor;
use std::sync::Arc;

use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
use thiserror::Error;

use super::metronome::{self, ClickEvent, ClickSample};
use super::midi_events::{self, MidiEventsError, ScheduledEvent, TempoMapEntry};

#[derive(Debug, Error)]
pub enum SynthError {
    #[error("failed to load soundfont: {0}")]
    SoundFont(#[from] rustysynth::SoundFontError),
    #[error("failed to parse midi: {0}")]
    Midi(#[from] MidiEventsError),
    #[error("failed to create synthesizer: {0}")]
    Synthesizer(#[from] rustysynth::SynthesizerError),
}

/// One MIDI file's worth of pre-parsed playback data: the flat, time-sorted
/// channel-voice event list and the tempo/time-signature map it was derived
/// against. Built once by `Player::load_midi`, replayed (and looped) by
/// `Player::render`.
pub struct LoadedMidi {
    events: Vec<ScheduledEvent>,
    tempo_map: Vec<TempoMapEntry>,
    duration_ms: f64,
}

/// Drives `rustysynth::Synthesizer` directly via a custom event scheduler,
/// instead of `rustysynth::MidiFileSequencer`. This is deliberate:
/// `MidiFileSequencer` only supports playing once or looping the *entire*
/// file (via embedded RPG-Maker-style loop markers), with no seek or
/// arbitrary-region-loop API, and `MidiFile`'s internal event data is
/// `pub(crate)` (no way to drive it externally either). The app
/// needs an arbitrary A/B loop region (drag-selected measures -> L to
/// loop just that range), so `Player` parses MIDI itself (`midi_events`,
/// reusing the same tick/tempo-map math as `crates/core/src/timeline.rs`'s
/// tempo extraction) and advances its own clock, which can snap back to an
/// arbitrary `loop_start_ms` instead of only time zero.
///
/// Speed control (0.5x/0.75x/1.0x) scales how fast this clock advances per
/// rendered audio block, matching `MidiFileSequencer`'s own model: never
/// resampling audio, so pitch is untouched, and changeable mid-playback with
/// no restart.
pub struct Player {
    synthesizer: Synthesizer,
    sample_rate: i32,
    speed: f64,

    midi: Option<Arc<LoadedMidi>>,
    next_event_index: usize,
    position_ms: f64,
    playing: bool,

    loop_region: Option<(f64, f64)>,

    metronome_enabled: bool,
    clicks: Vec<ClickEvent>,
    next_click_index: usize,
    click_sample: ClickSample,
    accent_sample: ClickSample,
}

impl Player {
    pub fn new(soundfont_bytes: &[u8], sample_rate: i32) -> Result<Self, SynthError> {
        let sound_font = Arc::new(SoundFont::new(&mut Cursor::new(soundfont_bytes))?);
        let settings = SynthesizerSettings::new(sample_rate);
        let synthesizer = Synthesizer::new(&sound_font, &settings)?;
        let (click_sample, accent_sample) = metronome::load_click_samples(sample_rate);
        Ok(Self {
            synthesizer,
            sample_rate,
            speed: 1.0,
            midi: None,
            next_event_index: 0,
            position_ms: 0.0,
            playing: false,
            loop_region: None,
            metronome_enabled: false,
            clicks: Vec::new(),
            next_click_index: 0,
            click_sample,
            accent_sample,
        })
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }

    pub fn load_midi(&self, midi_bytes: &[u8]) -> Result<Arc<LoadedMidi>, SynthError> {
        let (events, tempo_map) = midi_events::parse_midi_events(midi_bytes)?;
        let duration_ms = events.last().map(|e| e.time_ms).unwrap_or(0.0);
        Ok(Arc::new(LoadedMidi {
            events,
            tempo_map,
            duration_ms,
        }))
    }

    /// Builds metronome-only "playback" from a tempo map with no note events
    /// at all — PDF mode has no note data to
    /// synthesize (true audio playback isn't possible without it), only a user-calibrated tempo map. An empty `events` list
    /// is a no-op for every event-dispatch path in `render`/`dispatch_due_events`
    /// (loops zero times) while `rebuild_clicks`/loop-wrap/position-tracking
    /// all key off `tempo_map`/`duration_ms` alone — so this reuses the exact
    /// same clock, A/B loop region, and click-generation machinery as `.mscz`
    /// playback with no changes to any of it.
    pub fn load_tempo_map(
        &self,
        tempo_map: Vec<TempoMapEntry>,
        duration_ms: f64,
    ) -> Arc<LoadedMidi> {
        Arc::new(LoadedMidi {
            events: Vec::new(),
            tempo_map,
            duration_ms,
        })
    }

    pub fn play(&mut self, midi: &Arc<LoadedMidi>, play_loop: bool) {
        self.midi = Some(midi.clone());
        self.next_event_index = 0;
        self.position_ms = 0.0;
        self.playing = true;
        self.loop_region = if play_loop {
            Some((0.0, midi.duration_ms))
        } else {
            None
        };
        self.rebuild_clicks();
        self.synthesizer.reset();
    }

    /// Resumes playback after `pause()` from exactly where it left off — no
    /// position/event-index reset, no `synthesizer.reset()` (which would cut
    /// any ringing notes abruptly rather than just the explicitly stopped
    /// ones `pause()` already silenced). The loaded midi/loop region/clicks
    /// are untouched by `pause()`, so there's nothing else to restore here.
    pub fn resume(&mut self) {
        if self.midi.is_some() {
            self.playing = true;
        }
    }

    /// Stops advancing the clock without discarding playback state (unlike
    /// `stop()`, which clears `self.midi` entirely) — `render()`'s
    /// dispatch/position-advance/click-mixing are all gated on `self.playing`,
    /// so this alone is enough to freeze playback in place. Silences
    /// currently-sounding notes so pausing doesn't leave them ringing.
    pub fn pause(&mut self) {
        self.playing = false;
        self.synthesizer.note_off_all(false);
    }

    pub fn stop(&mut self) {
        self.playing = false;
        self.midi = None;
        self.synthesizer.reset();
    }

    /// Jumps the playback clock to an arbitrary point, in milliseconds
    /// within the MIDI file's own (1.0x) timeline — clamped to
    /// `[0, duration_ms]`, a no-op if no midi is loaded. Safe to call
    /// whether currently playing, paused, or stopped-with-midi-still-loaded
    /// (e.g. moving the always-visible playback-head marker before the user
    /// has pressed play at all). Silences any currently-sounding notes and
    /// resyncs `next_event_index`/`next_click_index` to the new position —
    /// the same snap-forward-or-backward logic `handle_loop_wrap` uses when
    /// wrapping a loop, factored out into `resync_indices_to` since both
    /// need exactly the same "find where this timestamp falls in the
    /// time-sorted event/click lists" step.
    pub fn seek(&mut self, target_ms: f64) {
        let Some(midi) = self.midi.clone() else {
            return;
        };
        let target_ms = target_ms.clamp(0.0, midi.duration_ms);
        self.position_ms = target_ms;
        self.synthesizer.note_off_all(false);
        self.resync_indices_to(target_ms);
    }

    /// Sets (or clears, with `None`) the arbitrary A/B loop region, in
    /// milliseconds within the MIDI file's own (1.0x) timeline. Safe to call
    /// mid-playback — the next time `position_ms` crosses `loop_end_ms` it
    /// snaps back to `loop_start_ms`, same mechanism as the whole-file loop
    /// `play(..., true)` sets up (just with different bounds).
    pub fn set_loop_region(&mut self, region: Option<(f64, f64)>) {
        self.loop_region = region;
    }

    /// Multiplies the playback tempo by this value; 1.0 is the recorded
    /// tempo. Pitch is never affected. Safe to call mid-playback.
    pub fn set_speed(&mut self, speed: f64) {
        self.speed = speed;
    }

    pub fn set_metronome_enabled(&mut self, enabled: bool) {
        self.metronome_enabled = enabled;
        self.rebuild_clicks();
    }

    /// Current position in the MIDI file's own timeline, in seconds.
    pub fn position_secs(&self) -> f64 {
        self.position_ms / 1000.0
    }

    pub fn end_of_sequence(&self) -> bool {
        match &self.midi {
            None => true,
            Some(midi) => self.loop_region.is_none() && self.next_event_index >= midi.events.len(),
        }
    }

    /// Renders the next block of audio into the given stereo buffers (equal
    /// length; called repeatedly by the output stream as it needs more
    /// samples). Internally chunked by the synthesizer's own `block_size`,
    /// dispatching every scheduled MIDI event due at the *start* of each
    /// chunk before rendering it — the same process-then-render ordering
    /// `rustysynth::MidiFileSequencer` itself uses, which matters here: doing
    /// it the other way (render the whole buffer, then dispatch events)
    /// would apply every event one buffer late, or never within short
    /// buffers at all. Mixes in metronome clicks per chunk, and wraps back to
    /// `loop_region`'s start once the position passes its end.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        if left.len() != right.len() {
            panic!("left and right output buffers must be the same length");
        }

        let block_size = self.synthesizer.get_block_size();
        let total_len = left.len();
        let mut written = 0;
        while written < total_len {
            let chunk_len = block_size.min(total_len - written);

            if self.playing {
                self.dispatch_due_events();
            }

            let left_chunk = &mut left[written..written + chunk_len];
            let right_chunk = &mut right[written..written + chunk_len];
            self.synthesizer.render(left_chunk, right_chunk);
            if self.playing {
                self.mix_clicks(left_chunk, right_chunk, chunk_len);
            }

            if self.playing {
                let block_ms = self.speed * chunk_len as f64 / self.sample_rate as f64 * 1000.0;
                self.position_ms += block_ms;
                self.handle_loop_wrap();
            }

            written += chunk_len;
        }
    }

    /// Dispatches every event due at (or before) the current position, then
    /// stops playback once the file's events are exhausted and no loop is set.
    fn dispatch_due_events(&mut self) {
        if let Some(midi) = self.midi.clone() {
            while self.next_event_index < midi.events.len()
                && midi.events[self.next_event_index].time_ms <= self.position_ms
            {
                let e = midi.events[self.next_event_index];
                self.synthesizer
                    .process_midi_message(e.channel, e.command, e.data1, e.data2);
                self.next_event_index += 1;
            }
            if self.loop_region.is_none() && self.next_event_index >= midi.events.len() {
                self.playing = false;
            }
        }
    }

    fn handle_loop_wrap(&mut self) {
        if let Some((loop_start_ms, loop_end_ms)) = self.loop_region {
            if self.position_ms >= loop_end_ms {
                self.position_ms = loop_start_ms;
                self.synthesizer.note_off_all(false);
                self.resync_indices_to(loop_start_ms);
            }
        }
    }

    /// Finds where `target_ms` falls in the time-sorted event/click lists
    /// and points `next_event_index`/`next_click_index` there — the shared
    /// step behind both jumping to an arbitrary position (`seek`) and
    /// wrapping back to a loop's start (`handle_loop_wrap`). Does not touch
    /// `position_ms` or silence notes itself; callers already did both
    /// before calling this.
    fn resync_indices_to(&mut self, target_ms: f64) {
        if let Some(midi) = &self.midi {
            self.next_event_index = midi.events.partition_point(|e| e.time_ms < target_ms);
        }
        self.next_click_index = self.clicks.partition_point(|c| c.time_ms < target_ms);
    }

    fn rebuild_clicks(&mut self) {
        self.clicks = match (&self.midi, self.metronome_enabled) {
            (Some(midi), true) => metronome::generate_clicks(&midi.tempo_map, midi.duration_ms),
            _ => Vec::new(),
        };
        self.next_click_index = 0;
    }

    /// Mixes the recorded click samples directly into the output buffers at
    /// each due `ClickEvent`'s time — deliberately not routed through the
    /// soundfont as an instrument patch, so it works
    /// identically regardless of which soundfont/instrument patches are
    /// loaded. Beat 1 uses the accent sample, other beats the plain click.
    fn mix_clicks(&mut self, left: &mut [f32], right: &mut [f32], chunk_len: usize) {
        if !self.metronome_enabled || self.clicks.is_empty() {
            return;
        }
        // Called before `position_ms` is advanced past this chunk, so
        // `position_ms` itself is this chunk's start time.
        let block_start_ms = self.position_ms;
        let block_ms = self.speed * chunk_len as f64 / self.sample_rate as f64 * 1000.0;
        let block_end_ms = block_start_ms + block_ms;

        while self.next_click_index < self.clicks.len()
            && self.clicks[self.next_click_index].time_ms < block_end_ms
        {
            let click = self.clicks[self.next_click_index];
            if click.time_ms >= block_start_ms {
                let offset_ms = click.time_ms - block_start_ms;
                let start_sample =
                    ((offset_ms / 1000.0) * self.sample_rate as f64 / self.speed) as usize;
                self.render_click(left, right, start_sample, click.accent);
            }
            self.next_click_index += 1;
        }
    }

    fn render_click(&self, left: &mut [f32], right: &mut [f32], start_sample: usize, accent: bool) {
        let sample = if accent { &self.accent_sample } else { &self.click_sample };
        for (i, &value) in sample.samples.iter().enumerate() {
            let sample_index = start_sample + i;
            if sample_index >= left.len() {
                break;
            }
            left[sample_index] += value;
            right[sample_index] += value;
        }
    }
}
