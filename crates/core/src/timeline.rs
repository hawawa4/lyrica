use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::measure_layout::MeasureInfo;

/// A bounding box in SVG page-pixel space, matching webmscore's
/// `PositionElement` shape ({x, y, sx, sy}).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub sx: f64,
    pub sy: f64,
}

/// Mirrors webmscore's `PositionElement` (one measure's printed bbox).
#[derive(Debug, Clone, Deserialize)]
pub struct PositionElement {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub sx: f64,
    pub sy: f64,
    pub page: u32,
}

/// Mirrors webmscore's `PositionEvent` (one measure instance's timing,
/// already repeats-unrolled — see module docs on `build_timeline`).
#[derive(Debug, Clone, Deserialize)]
pub struct PositionEvent {
    pub elid: u32,
    pub position: f64,
}

/// Mirrors webmscore's `Positions` (the return shape of `measurePositions()`),
/// as received from the JS layer via the `import_timeline` API call. Rust
/// never calls webmscore itself — this is already-exported JSON handed over
/// the API boundary (see IMPLEMENTATION_PLAN.md's API boundary section).
#[derive(Debug, Clone, Deserialize)]
pub struct Positions {
    pub elements: Vec<PositionElement>,
    pub events: Vec<PositionEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    /// Logical measure number, post-repeat-unroll (a repeated measure
    /// appears multiple times with increasing `time_ms` but the same
    /// `source_elid`).
    pub measure_index: u32,
    /// The webmscore `PositionElement.id` this instance maps back to, for
    /// page/bbox lookup against the printed (non-unrolled) page.
    pub source_elid: u32,
    /// Start time in the flattened (1.0x speed) timeline, in milliseconds.
    pub time_ms: f64,
    pub page: u32,
    pub bbox: Rect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timeline {
    pub events: Vec<TimelineEvent>,
    pub duration_ms: f64,
    /// (time_ms, quarter-notes-per-minute) breakpoints.
    pub tempo_map: Vec<(f64, f64)>,
}

#[derive(Debug, Error)]
pub enum TimelineError {
    #[error("measurePositions() event references unknown elid {0}")]
    UnknownElid(u32),
    #[error("midi parse error: {0}")]
    Midi(#[from] midly::Error),
}

/// Builds the flattened playback timeline from webmscore's `measurePositions()`
/// output plus the raw MIDI bytes from `saveMidi(true, false)`, and (when
/// available) the per-measure layout read from the score's own XML.
///
/// `positions.events[]` already IS the repeats-unrolled sequence — confirmed
/// empirically against real scores containing inline repeats and a D.C./D.S.
/// jump: its `elid` sequence replays repeated sections inline (e.g.
/// `[...,4,5,6,7,4,5,6,8,...]`), with `events.len()` far exceeding
/// `elements.len()` (the printed/non-unrolled measure count) whenever the
/// piece has any repeat structure, while matching 1:1 when it doesn't. This
/// means measure-boundary/repeat-unroll logic does NOT need to be
/// reimplemented — `positions` alone gives `measure_index -> source_elid`,
/// each `source_elid` looked up against `elements[]` for its page/bbox.
///
/// Each event's `time_ms`, though, is taken from the MIDI whenever `measures`
/// is given: walking the unrolled sequence while summing each measure's
/// length (plus any section-break pause, which MuseScore's MIDI export
/// inserts as extra ticks) gives every measure's MIDI tick, converted to ms
/// with the MIDI's own tempo map. That keeps seeking/the cursor in lockstep
/// with what the audio actually plays — `measurePositions()`' own `position`
/// can disagree with the MIDI after a D.S./D.C. (see `measure_layout`'s
/// module docs). Falls back to `measurePositions()`' times if the layout
/// doesn't line up with `positions` (measure count mismatch, or running past
/// the end of the MIDI).
///
/// The tempo_map output deduplicates redundant consecutive-identical tempo
/// events (seen in practice — one real-world score re-asserted the same tempo
/// 7 times at regular intervals) to keep it small.
pub fn build_timeline(
    positions: &Positions,
    midi_bytes: &[u8],
    measures: Option<&[MeasureInfo]>,
) -> Result<Timeline, TimelineError> {
    let elements_by_id: HashMap<u32, &PositionElement> =
        positions.elements.iter().map(|el| (el.id, el)).collect();

    let clock = MidiClock::parse(midi_bytes)?;
    let midi_times = measures.and_then(|m| midi_measure_times(positions, m, &clock));

    let mut events = Vec::with_capacity(positions.events.len());
    for (index, ev) in positions.events.iter().enumerate() {
        let el = elements_by_id
            .get(&ev.elid)
            .ok_or(TimelineError::UnknownElid(ev.elid))?;
        events.push(TimelineEvent {
            measure_index: index as u32,
            source_elid: ev.elid,
            time_ms: midi_times.as_ref().map_or(ev.position, |t| t[index]),
            page: el.page,
            bbox: Rect {
                x: el.x,
                y: el.y,
                sx: el.sx,
                sy: el.sy,
            },
        });
    }

    let duration_ms = events.last().map(|e| e.time_ms).unwrap_or(0.0);
    let tempo_map = clock.tempo_map_ms();

    Ok(Timeline {
        events,
        duration_ms,
        tempo_map,
    })
}

/// Each unrolled measure's start time in the MIDI's own timeline, or `None`
/// if `measures` can't be trusted to describe this score (see `build_timeline`).
fn midi_measure_times(positions: &Positions, measures: &[MeasureInfo], clock: &MidiClock) -> Option<Vec<f64>> {
    if measures.len() != positions.elements.len() {
        return None;
    }
    let mut tick = 0.0_f64;
    let mut times = Vec::with_capacity(positions.events.len());
    for ev in &positions.events {
        if tick > clock.end_tick {
            return None;
        }
        times.push(clock.tick_to_ms(tick));
        let measure = measures.get(ev.elid as usize)?;
        tick += measure.whole_notes * 4.0 * clock.ticks_per_beat;
        // MuseScore's MIDI export only inserts the pause when the section
        // break actually falls inside the repeat segment being played; that
        // always comes with a tempo event exactly at the pause's start tick
        // (the pause is encoded as extra ticks at its own tempo).
        if measure.pause_secs > 0.0 && clock.has_tempo_at(tick) {
            tick += (measure.pause_secs * clock.qpm_at(tick) * clock.ticks_per_beat / 60.0).round();
        }
    }
    Some(times)
}

/// A MIDI file's tick->ms mapping, from its tempo meta-events.
struct MidiClock {
    ticks_per_beat: f64,
    /// (abs_tick, qpm), sorted by tick, NOT deduplicated (a repeated tempo
    /// event still marks a point MuseScore's export cared about, see
    /// `midi_measure_times`).
    breakpoints: Vec<(u64, f64)>,
    end_tick: f64,
}

const DEFAULT_QPM: f64 = 120.0;

impl MidiClock {
    fn parse(midi_bytes: &[u8]) -> Result<Self, TimelineError> {
        let smf = midly::Smf::parse(midi_bytes)?;
        let ticks_per_beat: f64 = match smf.header.timing {
            midly::Timing::Metrical(tpb) => u16::from(tpb) as f64,
            // Timecode-based timing (SMPTE) doesn't carry tempo meta-events the
            // same way; none of webmscore's exports use it, but fall back to a
            // sane default rather than panicking if one ever does.
            midly::Timing::Timecode(fps, ticks_per_frame) => fps.as_f32() as f64 * ticks_per_frame as f64,
        };

        // setTempo events carry an absolute µs-per-beat value but only a
        // relative (per-track) delta tick — accumulate to get an absolute
        // tick position.
        let mut breakpoints: Vec<(u64, f64)> = Vec::new();
        let mut end_tick: u64 = 0;
        for track in &smf.tracks {
            let mut abs_tick: u64 = 0;
            for event in track {
                abs_tick += u32::from(event.delta) as u64;
                if let midly::TrackEventKind::Meta(midly::MetaMessage::Tempo(microsperbeat)) = event.kind {
                    breakpoints.push((abs_tick, 60_000_000.0 / u32::from(microsperbeat) as f64));
                }
            }
            end_tick = end_tick.max(abs_tick);
        }
        breakpoints.sort_by_key(|(tick, _)| *tick);

        Ok(Self {
            ticks_per_beat,
            breakpoints,
            end_tick: end_tick as f64,
        })
    }

    fn tick_to_ms(&self, tick: f64) -> f64 {
        let mut time_ms = 0.0;
        let mut last_tick = 0.0;
        let mut qpm = DEFAULT_QPM;
        for &(bp_tick, bp_qpm) in &self.breakpoints {
            let bp_tick = bp_tick as f64;
            if bp_tick > tick {
                break;
            }
            time_ms += (bp_tick - last_tick) * 60_000.0 / (qpm * self.ticks_per_beat);
            last_tick = bp_tick;
            qpm = bp_qpm;
        }
        time_ms + (tick - last_tick) * 60_000.0 / (qpm * self.ticks_per_beat)
    }

    fn qpm_at(&self, tick: f64) -> f64 {
        self.breakpoints
            .iter()
            .take_while(|(bp_tick, _)| *bp_tick as f64 <= tick)
            .last()
            .map_or(DEFAULT_QPM, |(_, qpm)| *qpm)
    }

    fn has_tempo_at(&self, tick: f64) -> bool {
        self.breakpoints.iter().any(|(bp_tick, _)| *bp_tick as f64 == tick)
    }

    /// (time_ms, qpm) breakpoints, consecutive identical tempos dropped
    /// (redundant re-assertions of the same tempo, not real changes).
    fn tempo_map_ms(&self) -> Vec<(f64, f64)> {
        let mut tempo_map = Vec::new();
        let mut last_qpm: Option<f64> = None;
        for &(tick, qpm) in &self.breakpoints {
            if last_qpm != Some(qpm) {
                tempo_map.push((self.tick_to_ms(tick as f64), qpm));
            }
            last_qpm = Some(qpm);
        }
        tempo_map
    }
}
