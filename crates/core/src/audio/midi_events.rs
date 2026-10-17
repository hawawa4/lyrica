use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MidiEventsError {
    #[error("midi parse error: {0}")]
    Midi(#[from] midly::Error),
}

/// A channel-voice MIDI event (note on/off, controller, program change, pitch
/// bend, ...) at an absolute time in the flattened (1.0x speed) timeline,
/// as raw status/data bytes (`Player` converts them to oxisynth events).
#[derive(Debug, Clone, Copy)]
pub struct ScheduledEvent {
    pub time_ms: f64,
    pub channel: i32,
    pub command: i32,
    pub data1: i32,
    pub data2: i32,
}

/// One tempo/time-signature breakpoint in the flattened timeline.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TempoMapEntry {
    pub time_ms: f64,
    pub qpm: f64,
    /// Beats per bar (MIDI time signature numerator), used for metronome accents.
    pub numerator: u8,
}

/// Parses raw MIDI bytes (as produced by webmscore's `saveMidi(true, false)`,
/// i.e. already repeats-unrolled) into a flat, time-sorted list of
/// channel-voice events plus a combined tempo/time-signature map — the data
/// `Player`'s custom scheduler needs to drive the synth directly (with
/// seek and arbitrary-region looping; see `Player`'s docs).
pub fn parse_midi_events(
    midi_bytes: &[u8],
) -> Result<(Vec<ScheduledEvent>, Vec<TempoMapEntry>), MidiEventsError> {
    let smf = midly::Smf::parse(midi_bytes)?;
    let ticks_per_beat: f64 = match smf.header.timing {
        midly::Timing::Metrical(tpb) => u16::from(tpb) as f64,
        midly::Timing::Timecode(fps, ticks_per_frame) => {
            fps.as_f32() as f64 * ticks_per_frame as f64
        }
    };

    // First pass: collect every tempo/time-signature meta-event's absolute
    // tick position across all tracks (format-1 MIDI keeps these on track 0,
    // but don't assume that — merge-sort from whichever track(s) have them).
    let mut raw_breakpoints: Vec<(u64, Option<f64>, Option<u8>)> = Vec::new();
    for track in &smf.tracks {
        let mut abs_tick: u64 = 0;
        for event in track {
            abs_tick += u32::from(event.delta) as u64;
            match event.kind {
                midly::TrackEventKind::Meta(midly::MetaMessage::Tempo(microsperbeat)) => {
                    let qpm = 60_000_000.0 / u32::from(microsperbeat) as f64;
                    raw_breakpoints.push((abs_tick, Some(qpm), None));
                }
                midly::TrackEventKind::Meta(midly::MetaMessage::TimeSignature(num, _, _, _)) => {
                    raw_breakpoints.push((abs_tick, None, Some(num)));
                }
                _ => {}
            }
        }
    }
    raw_breakpoints.sort_by_key(|(tick, _, _)| *tick);

    // Walk ticks in order, converting to ms using whichever tempo was in
    // effect, carrying forward the last-known qpm/numerator across entries
    // that only update one of the two (tempo-only or time-sig-only events).
    let mut tempo_map: Vec<TempoMapEntry> = Vec::new();
    let mut last_qpm = 120.0_f64;
    let mut last_numerator = 4_u8;
    let mut last_tick = 0_u64;
    let mut time_ms = 0.0_f64;
    for (abs_tick, qpm, numerator) in raw_breakpoints {
        let delta_ticks = (abs_tick - last_tick) as f64;
        let ms_per_tick = 60_000.0 / (last_qpm * ticks_per_beat);
        time_ms += delta_ticks * ms_per_tick;
        last_tick = abs_tick;

        let qpm_changed = qpm.is_some_and(|q| q != last_qpm);
        let numerator_changed = numerator.is_some_and(|n| n != last_numerator);
        if let Some(q) = qpm {
            last_qpm = q;
        }
        if let Some(n) = numerator {
            last_numerator = n;
        }
        if qpm_changed || numerator_changed {
            tempo_map.push(TempoMapEntry {
                time_ms,
                qpm: last_qpm,
                numerator: last_numerator,
            });
        }
    }
    if tempo_map.is_empty() {
        tempo_map.push(TempoMapEntry {
            time_ms: 0.0,
            qpm: last_qpm,
            numerator: last_numerator,
        });
    }

    // Second pass: convert every channel-voice event to an absolute time_ms,
    // using the same tick-walk/tempo-lookup approach.
    let mut events: Vec<ScheduledEvent> = Vec::new();
    for track in &smf.tracks {
        let mut abs_tick: u64 = 0;
        let mut cursor = 0_usize; // index into tempo_map, advanced monotonically per track
        let mut cur_time_ms = 0.0_f64;
        let mut cur_tick = 0_u64;
        let mut cur_qpm = tempo_map[0].qpm;
        for event in track {
            abs_tick += u32::from(event.delta) as u64;

            while cursor + 1 < tempo_map.len() {
                // Peek the tick position of the next tempo breakpoint by
                // re-deriving it isn't possible directly (tempo_map only
                // stores time_ms), so advance using elapsed ms instead: walk
                // forward in ms using cur_qpm until we'd reach this event's
                // tick, applying any breakpoint crossed along the way.
                let next_entry_time_ms = tempo_map[cursor + 1].time_ms;
                let ms_per_tick = 60_000.0 / (cur_qpm * ticks_per_beat);
                let delta_ticks = (abs_tick - cur_tick) as f64;
                let projected_time_ms = cur_time_ms + delta_ticks * ms_per_tick;
                if projected_time_ms < next_entry_time_ms {
                    break;
                }
                // Crossed into the next tempo region: advance cur_* to that
                // breakpoint exactly, then continue the loop in case this
                // single delta spans multiple breakpoints.
                let ticks_to_breakpoint = (next_entry_time_ms - cur_time_ms) / ms_per_tick;
                cur_tick += ticks_to_breakpoint.round() as u64;
                cur_time_ms = next_entry_time_ms;
                cur_qpm = tempo_map[cursor + 1].qpm;
                cursor += 1;
            }
            let ms_per_tick = 60_000.0 / (cur_qpm * ticks_per_beat);
            let event_time_ms = cur_time_ms + (abs_tick - cur_tick) as f64 * ms_per_tick;

            if let midly::TrackEventKind::Midi { channel, message } = event.kind {
                let channel = u8::from(channel) as i32;
                let (command, data1, data2) = match message {
                    midly::MidiMessage::NoteOff { key, vel } => {
                        (0x80, u8::from(key) as i32, u8::from(vel) as i32)
                    }
                    midly::MidiMessage::NoteOn { key, vel } => {
                        (0x90, u8::from(key) as i32, u8::from(vel) as i32)
                    }
                    midly::MidiMessage::Aftertouch { key, vel } => {
                        (0xA0, u8::from(key) as i32, u8::from(vel) as i32)
                    }
                    midly::MidiMessage::Controller { controller, value } => {
                        (0xB0, u8::from(controller) as i32, u8::from(value) as i32)
                    }
                    midly::MidiMessage::ProgramChange { program } => {
                        (0xC0, u8::from(program) as i32, 0)
                    }
                    midly::MidiMessage::ChannelAftertouch { vel } => {
                        (0xD0, u8::from(vel) as i32, 0)
                    }
                    midly::MidiMessage::PitchBend { bend } => {
                        let raw = bend.0.as_int();
                        (0xE0, (raw & 0x7F) as i32, (raw >> 7) as i32)
                    }
                };
                events.push(ScheduledEvent {
                    time_ms: event_time_ms,
                    channel,
                    command,
                    data1,
                    data2,
                });
            }
        }
    }
    events.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));

    Ok((events, tempo_map))
}
