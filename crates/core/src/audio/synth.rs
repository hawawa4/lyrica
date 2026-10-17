use std::io::Cursor;
use std::sync::Arc;

use oxisynth::{MidiEvent, SoundFont, Synth, SynthDescriptor};
use thiserror::Error;

use super::metronome::{self, ClickEvent, ClickSample};
use super::midi_events::{self, MidiEventsError, ScheduledEvent, TempoMapEntry};

#[derive(Debug, Error)]
pub enum SynthError {
    #[error("failed to load soundfont: {0}")]
    SoundFont(String),
    #[error("failed to parse midi: {0}")]
    Midi(#[from] MidiEventsError),
    #[error("failed to create synthesizer: {0}")]
    Synthesizer(#[from] oxisynth::SettingsError),
}

/// Samples per render chunk: MIDI events are dispatched at chunk starts.
/// Matches oxisynth's internal block size (FluidSynth's `FLUID_BUFSIZE`),
/// so an event never waits for a block that's already half-rendered.
const BLOCK_SIZE: usize = 64;

/// MIDI channels oxisynth is configured with (its default).
const MIDI_CHANNELS: u8 = 16;

/// CC 64, the sustain pedal.
const SUSTAIN_PEDAL: u8 = 64;

/// Parses a soundfont (`.sf2`, or Ogg-compressed `.sf3`). This is the slow
/// part of startup — an `.sf3` decodes every sample up front (~2s for
/// MuseScore_General.sf3 on a desktop CPU) — so callers that can't block
/// should do it off-thread and hand the result to `Player::set_soundfont`.
pub fn load_soundfont(soundfont_bytes: &[u8]) -> Result<SoundFont, SynthError> {
    SoundFont::load(&mut Cursor::new(soundfont_bytes))
        .map_err(|e| SynthError::SoundFont(format!("{e:?}")))
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

/// Drives an `oxisynth::Synth` via its own event scheduler — oxisynth has no
/// MIDI-file sequencer at all, and the app needs seek plus an arbitrary A/B
/// loop region (drag-selected measures -> L to
/// loop just that range), so `Player` parses MIDI itself (`midi_events`,
/// reusing the same tick/tempo-map math as `crates/core/src/timeline.rs`'s
/// tempo extraction) and advances its own clock, which can snap back to an
/// arbitrary `loop_start_ms` instead of only time zero.
///
/// Speed control (0.5x/0.75x/1.0x) scales how fast this clock advances per
/// rendered audio block, never resampling audio, so pitch is untouched, and changeable mid-playback with
/// no restart.
pub struct Player {
    synthesizer: Synth,
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
    /// Clicks still sounding. A click sample (~70ms) is far longer than one
    /// synth block (64 samples), so each one plays out across many chunks.
    sounding_clicks: Vec<SoundingClick>,
    metronome_volume: f32,
}

/// A click partway through playback: which sample, and how far into it.
#[derive(Debug, Clone, Copy)]
struct SoundingClick {
    accent: bool,
    position: usize,
}

impl Player {
    pub fn new(soundfont_bytes: &[u8], sample_rate: i32) -> Result<Self, SynthError> {
        let mut player = Self::without_soundfont(sample_rate)?;
        player.set_soundfont(load_soundfont(soundfont_bytes)?);
        Ok(player)
    }

    /// A player that renders silence (metronome clicks aside) until
    /// `set_soundfont` is called — lets the audio stream start immediately
    /// while the soundfont is still being parsed off-thread.
    pub fn without_soundfont(sample_rate: i32) -> Result<Self, SynthError> {
        let synthesizer = Synth::new(SynthDescriptor {
            sample_rate: sample_rate as f32,
            // oxisynth's default (0.2, FluidSynth's) is very quiet;
            // 1.0 still peaks well below clipping on dense scores.
            gain: 1.0,
            ..Default::default()
        })?;
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
            sounding_clicks: Vec::new(),
            metronome_volume: 1.0,
        })
    }

    pub fn set_soundfont(&mut self, sound_font: SoundFont) {
        self.synthesizer.add_font(sound_font, true);
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
        self.reset_synth();
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
        self.release_all_notes();
    }

    pub fn stop(&mut self) {
        self.playing = false;
        self.midi = None;
        self.reset_synth();
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
        self.release_all_notes();
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

    /// Click loudness, 0.0 (silent) to 1.0 (the sample's own full level).
    /// Safe to call mid-playback.
    pub fn set_metronome_volume(&mut self, volume: f32) {
        self.metronome_volume = volume.clamp(0.0, 1.0);
    }

    /// Current position in the MIDI file's own timeline, in seconds.
    pub fn position_secs(&self) -> f64 {
        self.position_ms / 1000.0
    }

    pub fn end_of_sequence(&self) -> bool {
        match &self.midi {
            None => true,
            Some(midi) => {
                self.loop_region.is_none()
                    && self.next_event_index >= midi.events.len()
                    && self.position_ms >= midi.duration_ms
            }
        }
    }

    /// Renders the next block of audio into the given stereo buffers (equal
    /// length; called repeatedly by the output stream as it needs more
    /// samples). Internally chunked into `BLOCK_SIZE` frames, dispatching
    /// every scheduled MIDI event due at the *start* of each chunk before
    /// rendering it. The process-then-render ordering matters: doing
    /// it the other way (render the whole buffer, then dispatch events)
    /// would apply every event one buffer late, or never within short
    /// buffers at all. Mixes in metronome clicks per chunk, and wraps back to
    /// `loop_region`'s start once the position passes its end.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        if left.len() != right.len() {
            panic!("left and right output buffers must be the same length");
        }

        let block_size = BLOCK_SIZE;
        let total_len = left.len();
        let mut written = 0;
        while written < total_len {
            let chunk_len = block_size.min(total_len - written);

            if self.playing {
                self.dispatch_due_events();
            }

            let left_chunk = &mut left[written..written + chunk_len];
            let right_chunk = &mut right[written..written + chunk_len];
            self.synthesizer
                .write_f32(chunk_len, left_chunk, 0, 1, right_chunk, 0, 1);
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
                if let Some(event) = to_oxisynth_event(&e) {
                    // Only fails on out-of-range values, which a parsed MIDI
                    // file can't produce; nothing useful to do mid-render.
                    let _ = self.synthesizer.send_event(event);
                }
                self.next_event_index += 1;
            }
            // Also wait for the clock to reach the end: tempo-map-only
            // (PDF) playback has no events at all, and would otherwise
            // stop on its very first chunk.
            if self.loop_region.is_none()
                && self.next_event_index >= midi.events.len()
                && self.position_ms >= midi.duration_ms
            {
                self.playing = false;
            }
        }
    }

    /// Clears every voice and channel (programs, controllers) — playback
    /// starting over from the top re-sends whatever the MIDI sets up.
    fn reset_synth(&mut self) {
        let _ = self.synthesizer.send_event(MidiEvent::SystemReset);
    }

    /// Releases every sounding note (with its natural release tail, not a
    /// hard cut) — for pause/seek/loop-wrap. oxisynth's AllNotesOff alone
    /// leaves pedal-held notes ringing, so the pedal is briefly lifted to
    /// release those too, then restored so notes played after a seek still
    /// sustain if the pedal was down.
    fn release_all_notes(&mut self) {
        for channel in 0..MIDI_CHANNELS {
            let pedal = self
                .synthesizer
                .cc(channel, SUSTAIN_PEDAL as u16)
                .unwrap_or(0);
            let _ = self.synthesizer.send_event(MidiEvent::ControlChange {
                channel,
                ctrl: SUSTAIN_PEDAL,
                value: 0,
            });
            let _ = self
                .synthesizer
                .send_event(MidiEvent::AllNotesOff { channel });
            if pedal != 0 {
                let _ = self.synthesizer.send_event(MidiEvent::ControlChange {
                    channel,
                    ctrl: SUSTAIN_PEDAL,
                    value: pedal,
                });
            }
        }
    }

    fn handle_loop_wrap(&mut self) {
        if let Some((loop_start_ms, loop_end_ms)) = self.loop_region {
            if self.position_ms >= loop_end_ms {
                self.position_ms = loop_start_ms;
                self.release_all_notes();
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
        self.sounding_clicks.clear();
    }

    fn rebuild_clicks(&mut self) {
        self.clicks = match (&self.midi, self.metronome_enabled) {
            (Some(midi), true) => metronome::generate_clicks(&midi.tempo_map, midi.duration_ms),
            _ => Vec::new(),
        };
        self.next_click_index = 0;
        self.sounding_clicks.clear();
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
        // Tails of clicks that started in earlier chunks.
        let mut sounding = std::mem::take(&mut self.sounding_clicks);
        for click in &mut sounding {
            click.position += self.render_click(left, right, 0, *click);
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
                let mut started = SoundingClick {
                    accent: click.accent,
                    position: 0,
                };
                started.position += self.render_click(left, right, start_sample, started);
                sounding.push(started);
            }
            self.next_click_index += 1;
        }

        sounding.retain(|c| c.position < self.sample_for(c.accent).samples.len());
        self.sounding_clicks = sounding;
    }

    fn sample_for(&self, accent: bool) -> &ClickSample {
        if accent {
            &self.accent_sample
        } else {
            &self.click_sample
        }
    }

    /// Adds `click`'s sample, from its current position, into the buffers
    /// starting at `start_sample`, stopping at the buffer's end. Returns how
    /// many sample frames were written.
    fn render_click(
        &self,
        left: &mut [f32],
        right: &mut [f32],
        start_sample: usize,
        click: SoundingClick,
    ) -> usize {
        let remaining = self
            .sample_for(click.accent)
            .samples
            .get(click.position..)
            .unwrap_or(&[]);
        let room = left.len().saturating_sub(start_sample);
        let count = remaining.len().min(room);
        for (i, &value) in remaining[..count].iter().enumerate() {
            let value = value * self.metronome_volume;
            left[start_sample + i] += value;
            right[start_sample + i] += value;
        }
        count
    }
}

/// Converts a raw channel-voice message (as `midi_events` stores it) to
/// oxisynth's event type. A NoteOn with velocity 0 is a NoteOff by MIDI
/// convention — oxisynth doesn't apply that rule itself.
fn to_oxisynth_event(e: &ScheduledEvent) -> Option<MidiEvent> {
    let channel = e.channel as u8;
    let (data1, data2) = (e.data1 as u8, e.data2 as u8);
    Some(match e.command {
        0x80 => MidiEvent::NoteOff {
            channel,
            key: data1,
        },
        0x90 if data2 == 0 => MidiEvent::NoteOff {
            channel,
            key: data1,
        },
        0x90 => MidiEvent::NoteOn {
            channel,
            key: data1,
            vel: data2,
        },
        0xA0 => MidiEvent::PolyphonicKeyPressure {
            channel,
            key: data1,
            value: data2,
        },
        0xB0 => MidiEvent::ControlChange {
            channel,
            ctrl: data1,
            value: data2,
        },
        0xC0 => MidiEvent::ProgramChange {
            channel,
            program_id: data1,
        },
        0xD0 => MidiEvent::ChannelPressure {
            channel,
            value: data1,
        },
        0xE0 => MidiEvent::PitchBend {
            channel,
            value: data1 as u16 | (data2 as u16) << 7,
        },
        _ => return None,
    })
}
