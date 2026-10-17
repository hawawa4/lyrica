use std::fs;

use mp_core::timeline::{build_timeline, Positions};

fn load_positions(name: &str) -> Positions {
    let json = fs::read_to_string(format!("tests/fixtures/{name}")).unwrap();
    serde_json::from_str(&json).unwrap()
}

fn load_midi(name: &str) -> Vec<u8> {
    fs::read(format!("tests/fixtures/{name}")).unwrap()
}

#[test]
fn darkside_timeline_unrolls_repeats_and_dedupes_tempo() {
    let positions = load_positions("darkside_measures.json");
    let midi = load_midi("darkside.mid");

    let timeline = build_timeline(&positions, &midi, None).unwrap();

    // Dark Side Of Fate has 46 printed measures but, per real repeat/D.C.
    // structure, performs 112 measure
    // instances when repeats are unrolled.
    assert_eq!(positions.elements.len(), 46);
    assert_eq!(timeline.events.len(), 112);

    // Known-good elid sequence, independently verified by hand against the
    // same measurePositions() dump this fixture is taken from.
    let expected_elids: Vec<u32> = vec![
        0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 8, 9, 10, 11, 12, 9, 10, 13, 14, 15, 16, 17, 18, 15, 16,
        17, 19, 20, 21, 22, 23, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 28, 29, 30, 32, 33,
        34, 35, 36, 33, 34, 35, 36, 37, 38, 39, 40, 37, 38, 39, 41, 42, 43, 44, 45, 42, 43, 44, 45,
        0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
        29, 30, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 43, 44, 45,
    ];
    let actual_elids: Vec<u32> = timeline.events.iter().map(|e| e.source_elid).collect();
    assert_eq!(actual_elids, expected_elids);

    // measure_index is sequential regardless of repeated source_elid.
    for (i, event) in timeline.events.iter().enumerate() {
        assert_eq!(event.measure_index, i as u32);
    }

    // time_ms is monotonically non-decreasing across the unrolled sequence.
    for pair in timeline.events.windows(2) {
        assert!(pair[1].time_ms >= pair[0].time_ms);
    }

    assert_eq!(timeline.duration_ms, 158477.0);

    // All 7 tempo re-assertions in the real MIDI carry the identical value
    // (356930 µs/beat => ~168.1 qpm), so the deduped map should collapse to
    // exactly one breakpoint at time 0.
    assert_eq!(timeline.tempo_map.len(), 1);
    let (time_ms, qpm) = timeline.tempo_map[0];
    assert_eq!(time_ms, 0.0);
    assert!((qpm - 168.100_187_711_876_3).abs() < 1e-6);
}

#[test]
fn youkai_timeline_matches_1to1_when_no_repeats() {
    let positions = load_positions("youkai_measures.json");
    let midi = load_midi("youkai.mid");

    let timeline = build_timeline(&positions, &midi, None).unwrap();

    // Youkai's .mscx has no repeat barlines, so events should match elements 1:1.
    assert_eq!(positions.elements.len(), 83);
    assert_eq!(timeline.events.len(), 83);

    let actual_elids: Vec<u32> = timeline.events.iter().map(|e| e.source_elid).collect();
    let expected_elids: Vec<u32> = (0..83).collect();
    assert_eq!(actual_elids, expected_elids);

    assert_eq!(timeline.duration_ms, 98250.0);

    // A single, constant 160 qpm tempo.
    assert_eq!(timeline.tempo_map.len(), 1);
    assert_eq!(timeline.tempo_map[0], (0.0, 160.0));
}

#[test]
fn unknown_elid_in_events_is_rejected() {
    let positions = Positions {
        elements: vec![mp_core::timeline::PositionElement {
            id: 0,
            x: 0.0,
            y: 0.0,
            sx: 1.0,
            sy: 1.0,
            page: 0,
        }],
        events: vec![mp_core::timeline::PositionEvent {
            elid: 99,
            position: 0.0,
        }],
    };
    let midi = load_midi("youkai.mid");

    let result = build_timeline(&positions, &midi, None);
    assert!(result.is_err());
}

/// Per-measure layout straight from a real score's XML, or `None` (test
/// skipped) when the sample file isn't present in this environment.
fn load_layout(path: &str) -> Option<Vec<mp_core::measure_layout::MeasureInfo>> {
    let file = fs::File::open(path).ok()?;
    let contents = mp_core::mscz::read_rootfile_contents(file).unwrap();
    Some(mp_core::measure_layout::parse_measure_layout(&contents).unwrap())
}

#[test]
fn midi_derived_times_match_positions_when_the_midi_has_no_tempo_drift() {
    let Some(layout) = load_layout("/home/hawa/Documents/Musescore/Dark Side Of Fate.mscz") else {
        eprintln!("skipping: Dark Side Of Fate.mscz not present in this environment");
        return;
    };
    let positions = load_positions("darkside_measures.json");
    let timeline = build_timeline(&positions, &load_midi("darkside.mid"), Some(&layout)).unwrap();
    for (event, pos) in timeline.events.iter().zip(&positions.events) {
        assert!(
            (event.time_ms - pos.position).abs() < 2.0,
            "{} vs {}",
            event.time_ms,
            pos.position
        );
    }
}

/// EoSD's 5th piece has a D.S. back into a 152bpm passage whose tempo
/// marking sits before the segno; webmscore's MIDI replays it at the
/// preceding 132bpm, so the audio runs 12.44s behind `measurePositions()`
/// from there on. The timeline must follow the audio, not `measurePositions()`.
#[test]
fn timeline_follows_midi_after_a_ds_jump_with_tempo_drift() {
    let Some(layout) = load_layout("/home/hawa/Documents/Musescore/EoSD.mscz") else {
        eprintln!("skipping: EoSD.mscz not present in this environment");
        return;
    };
    let positions = load_positions("eosd_measures.json");
    let timeline = build_timeline(&positions, &load_midi("eosd.mid"), Some(&layout)).unwrap();

    // Before the drift: identical to measurePositions() (piece 3's start,
    // including the section pauses between pieces 1-3).
    assert_eq!(timeline.events[139].source_elid, 72);
    assert!((timeline.events[139].time_ms - 254_333.0).abs() < 2.0);

    // Piece 6's first measure (elid 185): measurePositions() says 708505ms,
    // but its first MIDI note sounds at 720945ms.
    assert_eq!(timeline.events[414].source_elid, 185);
    assert!((positions.events[414].position - 708_505.0).abs() < 1.0);
    assert!(
        (timeline.events[414].time_ms - 720_945.0).abs() < 2.0,
        "got {}",
        timeline.events[414].time_ms
    );
}
