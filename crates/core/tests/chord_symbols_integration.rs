//! Chord-symbol detection against real webmscore exports (MusicXML fixtures
//! imported and exported by webmscore 1.2.1, so they show exactly where it
//! puts chord symbols):
//!
//! - `chords_lead`: one staff, melody + chord symbols (a lead sheet).
//! - `chords_multi`: piano (2 staves) / bass (6 channels) / drums / guitar,
//!   chord symbols on piano, bass and guitar.
//! - `chords_bassonly`: the same, with chord symbols on the bass only.

use std::fs;
use std::io::Cursor;

use mp_core::audio::midi_events::{parse_midi_events, MidiStream};
use mp_core::chord_symbols::{chords_default_on, find_chord_streams, parse_part_chords};
use mp_core::mscz;

struct Fixture {
    streams: Vec<MidiStream>,
    default_on: bool,
}

fn analyse(name: &str) -> Fixture {
    let mscz_bytes = fs::read(format!("tests/fixtures/{name}.mscz")).unwrap();
    let midi = fs::read(format!("tests/fixtures/{name}.mid")).unwrap();
    let xml = mscz::read_rootfile_contents(Cursor::new(mscz_bytes)).unwrap();
    let parts = parse_part_chords(&xml).unwrap();
    let (events, _, track_count) = parse_midi_events(&midi).unwrap();
    let streams = find_chord_streams(&parts, &events, track_count);
    let default_on = chords_default_on(&events, &streams);
    Fixture {
        streams,
        default_on,
    }
}

fn stream(track: usize, channel: u8) -> MidiStream {
    MidiStream { track, channel }
}

#[test]
fn lead_sheet_chords_are_found_and_default_on() {
    let f = analyse("chords_lead");
    assert_eq!(f.streams, vec![stream(0, 1)]);
    assert!(f.default_on);
}

#[test]
fn chord_channels_are_found_per_part_whatever_their_number() {
    let f = analyse("chords_multi");
    // Piano's harmony channel is on both of its tracks (0 and 1), the bass's is
    // its 6th channel (after 5 articulation channels), drums have none, and the
    // guitar's lands on 7 even though its own notes are on 2.
    assert_eq!(
        f.streams,
        vec![stream(0, 1), stream(1, 1), stream(2, 6), stream(4, 7)]
    );
    // Written-out piano/bass/guitar: the chord symbols are just annotations.
    assert!(!f.default_on);
}

#[test]
fn parts_without_chord_symbols_have_no_chord_stream() {
    let f = analyse("chords_bassonly");
    assert_eq!(f.streams, vec![stream(2, 6)]);
}
