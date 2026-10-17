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
/// map".
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

const CLICK_WAV: &[u8] = include_bytes!("../../assets/metronome_click.wav");
const ACCENT_WAV: &[u8] = include_bytes!("../../assets/metronome_accent.wav");

/// A recorded click (mono, 16-bit, 24kHz — see `scripts/extract_metronome.py`),
/// decoded to f32 and resampled to the output rate once at synth construction
/// (`rustysynth` doesn't resample, and neither does the click path).
#[derive(Debug, Clone)]
pub struct ClickSample {
    pub samples: Vec<f32>,
}

impl ClickSample {
    fn from_wav(wav: &[u8], out_rate: i32) -> Self {
        // Canonical 44-byte header, written by the extraction script.
        let src_rate = u32::from_le_bytes(wav[24..28].try_into().unwrap()) as f64;
        let pcm: Vec<f32> = wav[44..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();
        let ratio = src_rate / out_rate as f64;
        let out_len = (pcm.len() as f64 / ratio) as usize;
        let samples = (0..out_len)
            .map(|i| {
                let pos = i as f64 * ratio;
                let idx = pos as usize;
                let frac = (pos - idx as f64) as f32;
                let a = pcm[idx];
                let b = *pcm.get(idx + 1).unwrap_or(&0.0);
                a + (b - a) * frac
            })
            .collect();
        Self { samples }
    }
}

/// The (normal, accent) click samples resampled to `out_rate`.
pub fn load_click_samples(out_rate: i32) -> (ClickSample, ClickSample) {
    (
        ClickSample::from_wav(CLICK_WAV, out_rate),
        ClickSample::from_wav(ACCENT_WAV, out_rate),
    )
}
