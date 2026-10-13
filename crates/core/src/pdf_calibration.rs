//! PDF mode (IMPLEMENTATION_PLAN.md Phase 9): user-calibrated tempo points
//! for scores with no usable `.mscz` — the user taps along (or places points
//! directly) to mark "this position on this page = measure N, beat B", and
//! the app linearly interpolates between consecutive points to derive an
//! approximate tempo map (see `tempo_map` below), since true note data
//! doesn't exist for a plain PDF.
//!
//! Persisted via `sidecar`'s generic item storage at
//! `{base_dir}/pdfs/{file_hash}/calibration.json`, hashed the same way
//! (blake3 of the raw file bytes) as `.mscz` content-hashing — a separate
//! `kind` namespace from `scores/` so a PDF and a `.mscz` can never collide
//! even on an astronomically unlikely hash coincidence.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::audio::midi_events::TempoMapEntry;
use crate::sidecar::{self, SidecarError};

const KIND: &str = "pdfs";
const FILENAME: &str = "calibration.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CalibrationPoint {
    /// 0-based page index.
    pub page: u32,
    /// Position on the page, in PDF points (same unit pdf.js's viewport uses
    /// at scale 1) — not pixels at whatever zoom the UI happens to render
    /// at, so calibration stays valid across window resizes.
    pub x: f64,
    pub y: f64,
    /// Milliseconds since calibration started (tapping along with a
    /// reference metronome) — or, for points placed directly rather than
    /// tapped live, whatever monotonically-increasing sequence the UI
    /// assigns. Only relative ordering/spacing between points matters for
    /// tempo derivation, not any absolute clock.
    pub time_ms: f64,
    pub measure: u32,
    pub beat: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CalibrationMeta {
    #[serde(default)]
    points: Vec<CalibrationPoint>,
}

pub fn list_points(base_dir: &Path, file_hash: &str) -> Result<Vec<CalibrationPoint>, SidecarError> {
    let meta: CalibrationMeta = sidecar::load_item(base_dir, KIND, file_hash, FILENAME)?;
    Ok(meta.points)
}

/// Replaces the full calibration point list (the UI always sends the
/// complete, re-sorted set after an add/remove/adjust — there's no
/// incremental id-based CRUD like markers have, since points are typically
/// edited as a batch while scrubbing through calibration rather than one at
/// a time).
pub fn save_points(
    base_dir: &Path,
    file_hash: &str,
    mut points: Vec<CalibrationPoint>,
) -> Result<Vec<CalibrationPoint>, SidecarError> {
    points.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    let meta = CalibrationMeta { points: points.clone() };
    sidecar::save_item(base_dir, KIND, file_hash, FILENAME, &meta)?;
    Ok(points)
}

/// Derives a piecewise-linear tempo map from calibration points, in the same
/// `Vec<TempoMapEntry>` shape `Player::load_tempo_map`/`generate_clicks`
/// already consume for `.mscz` playback — so the existing metronome/loop
/// machinery works unmodified against PDF mode's derived tempo, with no new
/// audio code (see `crates/core/src/audio/synth.rs`'s `load_tempo_map` docs).
///
/// Between two consecutive points, the local tempo is however many beats
/// elapsed (by `beat`/`measure` numbering, assuming a constant time
/// signature equal to the first point's bar length... see note below)
/// divided by the elapsed `time_ms` — i.e. local qpm = beats / minutes.
/// Needs at least 2 points to derive any tempo; fewer returns an empty map
/// (no tempo info derivable yet, so no clicks/loop should play).
///
/// Simplification: this treats `beat` as always counting within a bar whose
/// length is `numerator` (passed in, since calibration points don't carry
/// their own time signature) — correct as long as the time signature doesn't
/// change between calibration points, which is a reasonable assumption for
/// manual calibration (the user places points more densely around tempo
/// changes anyway, and a time-signature change close to a calibration point
/// just gets the usual linear-interpolation approximation like a tempo
/// change would).
pub fn tempo_map(points: &[CalibrationPoint], numerator: u8) -> Vec<TempoMapEntry> {
    if points.len() < 2 {
        return Vec::new();
    }
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));

    let mut map = Vec::with_capacity(sorted.len().saturating_sub(1));
    for pair in sorted.windows(2) {
        let [a, b] = [pair[0], pair[1]];
        let elapsed_ms = b.time_ms - a.time_ms;
        if elapsed_ms <= 0.0 {
            continue;
        }
        let beats_elapsed = beats_between(a, b, numerator);
        if beats_elapsed <= 0.0 {
            continue;
        }
        let qpm = beats_elapsed / (elapsed_ms / 60_000.0);
        map.push(TempoMapEntry {
            time_ms: a.time_ms,
            qpm,
            numerator,
        });
    }
    map
}

fn beats_between(a: CalibrationPoint, b: CalibrationPoint, numerator: u8) -> f64 {
    let numerator = numerator.max(1) as i64;
    let a_total_beats = a.measure as i64 * numerator + a.beat as i64;
    let b_total_beats = b.measure as i64 * numerator + b.beat as i64;
    (b_total_beats - a_total_beats) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_points_through_save_and_load() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "pdfhash";

        assert_eq!(list_points(tmp.path(), hash).unwrap().len(), 0);

        let points = vec![
            CalibrationPoint { page: 0, x: 10.0, y: 20.0, time_ms: 0.0, measure: 0, beat: 0 },
            CalibrationPoint { page: 0, x: 30.0, y: 20.0, time_ms: 2000.0, measure: 1, beat: 0 },
        ];
        save_points(tmp.path(), hash, points.clone()).unwrap();

        let loaded = list_points(tmp.path(), hash).unwrap();
        assert_eq!(loaded, points);
    }

    #[test]
    fn pdf_and_mscz_sidecars_are_isolated_even_with_the_same_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "sharedhash";

        save_points(
            tmp.path(),
            hash,
            vec![CalibrationPoint { page: 0, x: 0.0, y: 0.0, time_ms: 0.0, measure: 0, beat: 0 }],
        )
        .unwrap();

        // crates/core/src/markers.rs uses the same hash under "scores/" —
        // confirm it sees nothing from the "pdfs/" sidecar.
        let markers: Vec<crate::markers::Marker> = crate::sidecar::load_meta(tmp.path(), hash).unwrap();
        assert_eq!(markers.len(), 0);

        let points = list_points(tmp.path(), hash).unwrap();
        assert_eq!(points.len(), 1);
    }

    #[test]
    fn tempo_map_derives_qpm_from_measure_beat_and_elapsed_time() {
        // 4/4, 2 measures (8 beats) elapsed over exactly 4 seconds => 120 qpm.
        let points = vec![
            CalibrationPoint { page: 0, x: 0.0, y: 0.0, time_ms: 0.0, measure: 0, beat: 0 },
            CalibrationPoint { page: 0, x: 0.0, y: 0.0, time_ms: 4000.0, measure: 2, beat: 0 },
        ];
        let map = tempo_map(&points, 4);
        assert_eq!(map.len(), 1);
        assert_eq!(map[0].time_ms, 0.0);
        assert!((map[0].qpm - 120.0).abs() < 0.001, "expected ~120 qpm, got {}", map[0].qpm);
        assert_eq!(map[0].numerator, 4);
    }

    #[test]
    fn tempo_map_produces_one_entry_per_segment_for_varying_tempo() {
        let points = vec![
            CalibrationPoint { page: 0, x: 0.0, y: 0.0, time_ms: 0.0, measure: 0, beat: 0 },
            CalibrationPoint { page: 0, x: 0.0, y: 0.0, time_ms: 2000.0, measure: 1, beat: 0 }, // 4 beats / 2s = 120qpm
            CalibrationPoint { page: 0, x: 0.0, y: 0.0, time_ms: 6000.0, measure: 2, beat: 0 }, // 4 beats / 4s = 60qpm
        ];
        let map = tempo_map(&points, 4);
        assert_eq!(map.len(), 2);
        assert!((map[0].qpm - 120.0).abs() < 0.001);
        assert!((map[1].qpm - 60.0).abs() < 0.001);
        assert_eq!(map[1].time_ms, 2000.0);
    }

    #[test]
    fn fewer_than_two_points_derives_no_tempo() {
        assert_eq!(tempo_map(&[], 4).len(), 0);
        let one = vec![CalibrationPoint { page: 0, x: 0.0, y: 0.0, time_ms: 0.0, measure: 0, beat: 0 }];
        assert_eq!(tempo_map(&one, 4).len(), 0);
    }
}
