use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

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
/// output plus the raw MIDI bytes from `saveMidi(true, false)`.
///
/// `positions.events[]` already IS the repeats-unrolled sequence — confirmed
/// empirically against real scores containing inline repeats and a D.C./D.S.
/// jump: its `elid` sequence replays repeated sections inline (e.g.
/// `[...,4,5,6,7,4,5,6,8,...]`), with `events.len()` far exceeding
/// `elements.len()` (the printed/non-unrolled measure count) whenever the
/// piece has any repeat structure, while matching 1:1 when it doesn't. This
/// means measure-boundary/repeat-unroll logic does NOT need to be
/// reimplemented against MIDI tick positions — `positions` alone gives
/// `measure_index -> source_elid -> time_ms`, each `source_elid` looked up
/// against `elements[]` for its page/bbox.
///
/// MIDI is parsed here only for the tempo_map (position data carries no
/// tempo information). Redundant consecutive-identical tempo events (seen in
/// practice — one real-world score re-asserted the same tempo 7 times at
/// regular intervals) are deduped to keep the map small.
pub fn build_timeline(positions: &Positions, midi_bytes: &[u8]) -> Result<Timeline, TimelineError> {
    let elements_by_id: HashMap<u32, &PositionElement> =
        positions.elements.iter().map(|el| (el.id, el)).collect();

    let mut events = Vec::with_capacity(positions.events.len());
    for (index, ev) in positions.events.iter().enumerate() {
        let el = elements_by_id
            .get(&ev.elid)
            .ok_or(TimelineError::UnknownElid(ev.elid))?;
        events.push(TimelineEvent {
            measure_index: index as u32,
            source_elid: ev.elid,
            time_ms: ev.position,
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
    let tempo_map = extract_tempo_map(midi_bytes)?;

    Ok(Timeline {
        events,
        duration_ms,
        tempo_map,
    })
}

fn extract_tempo_map(midi_bytes: &[u8]) -> Result<Vec<(f64, f64)>, TimelineError> {
    let smf = midly::Smf::parse(midi_bytes)?;
    let ticks_per_beat: f64 = match smf.header.timing {
        midly::Timing::Metrical(tpb) => u16::from(tpb) as f64,
        // Timecode-based timing (SMPTE) doesn't carry tempo meta-events the
        // same way; none of webmscore's exports use it, but fall back to a
        // sane default rather than panicking if one ever does.
        midly::Timing::Timecode(fps, ticks_per_frame) => fps.as_f32() as f64 * ticks_per_frame as f64,
    };

    // setTempo events carry an absolute µs-per-beat value but only a
    // relative (per-track) delta tick — accumulate to get an absolute tick
    // position, then convert using whatever tempo was in effect up to that
    // point.
    let mut breakpoints: Vec<(u64, f64)> = Vec::new(); // (abs_tick, qpm)
    for track in &smf.tracks {
        let mut abs_tick: u64 = 0;
        for event in track {
            abs_tick += u32::from(event.delta) as u64;
            if let midly::TrackEventKind::Meta(midly::MetaMessage::Tempo(microsperbeat)) = event.kind {
                let qpm = 60_000_000.0 / u32::from(microsperbeat) as f64;
                breakpoints.push((abs_tick, qpm));
            }
        }
    }
    breakpoints.sort_by_key(|(tick, _)| *tick);

    // Convert tick positions to ms using the tempo in effect at each point,
    // and drop consecutive entries with an identical qpm (redundant
    // re-assertions of the same tempo, not real changes).
    let mut tempo_map = Vec::new();
    let mut last_qpm: Option<f64> = None;
    let mut last_tick: u64 = 0;
    let mut time_ms = 0.0;
    for (abs_tick, qpm) in breakpoints {
        if let Some(prev_qpm) = last_qpm {
            let delta_ticks = (abs_tick - last_tick) as f64;
            let ms_per_tick = 60_000.0 / (prev_qpm * ticks_per_beat);
            time_ms += delta_ticks * ms_per_tick;
        }
        if last_qpm != Some(qpm) {
            tempo_map.push((time_ms, qpm));
        }
        last_qpm = Some(qpm);
        last_tick = abs_tick;
    }

    Ok(tempo_map)
}
