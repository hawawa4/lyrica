use super::midi_events::TempoMapEntry;

/// One metronome click, in the flattened (1.0x speed) timeline.
#[derive(Debug, Clone, Copy)]
pub struct ClickEvent {
    pub time_ms: f64,
    /// True on beat 1 of each bar (rendered as a higher-pitched accent click).
    pub accent: bool,
}

/// Generates a quarter-note click track from a tempo/time-signature map,
/// covering `[0, duration_ms]`. One click per beat (quarter note), with the
/// first beat of each bar accented per the map's `numerator` in effect at
/// that point — "click track generated from the time signature and tempo
/// map" per the handoff spec's metronome requirement.
pub fn generate_clicks(tempo_map: &[TempoMapEntry], duration_ms: f64) -> Vec<ClickEvent> {
    if tempo_map.is_empty() || duration_ms <= 0.0 {
        return Vec::new();
    }

    let mut clicks = Vec::new();
    let mut beat_in_bar = 0_u32;
    let mut time_ms = 0.0_f64;
    let mut map_index = 0_usize;

    while time_ms < duration_ms {
        while map_index + 1 < tempo_map.len() && tempo_map[map_index + 1].time_ms <= time_ms {
            map_index += 1;
            beat_in_bar = 0; // a tempo/time-sig change restarts bar counting at that point
        }
        let entry = tempo_map[map_index];
        clicks.push(ClickEvent {
            time_ms,
            accent: beat_in_bar == 0,
        });

        let numerator = entry.numerator.max(1) as u32;
        beat_in_bar = (beat_in_bar + 1) % numerator;
        let ms_per_beat = 60_000.0 / entry.qpm;
        time_ms += ms_per_beat;
    }

    clicks
}
