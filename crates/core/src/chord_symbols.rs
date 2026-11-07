//! Chord-symbol playback: finding the MIDI streams webmscore renders chord
//! symbols onto, and guessing whether they should sound by default.
//!
//! webmscore (MuseScore's own export) plays every chord symbol as a block
//! chord on a dedicated "harmony" MIDI channel, in the track of the staff the
//! symbol sits on. That channel is the *last* one of its part's channel list,
//! and the part only has one if it contains at least one chord symbol (both
//! checked against real exports, see `tests/chord_symbols_integration.rs`).
//! The channel numbers themselves aren't predictable (they depend on how many
//! articulation channels earlier parts have, and on MIDI ports), so they're
//! read off the MIDI: the first track of each part opens by initialising each
//! of the part's channels in list order, at tick 0.
//!
//! The score XML only says *which parts* have chord symbols. The text is
//! always drawn by the page renderer; muting only silences these streams.

use std::collections::{HashMap, HashSet};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use thiserror::Error;

use crate::audio::midi_events::{MidiStream, ScheduledEvent};

#[derive(Debug, Error)]
pub enum ChordSymbolsError {
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
}

/// A part's staff count and whether any of them carries a chord symbol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartChords {
    pub staves: usize,
    pub has_chord_symbols: bool,
}

/// One entry per `<Part>`, in score order (the same order webmscore exports
/// its tracks in: one per staff, parts one after another).
pub fn parse_part_chords(mscx_contents: &str) -> Result<Vec<PartChords>, ChordSymbolsError> {
    let mut reader = Reader::from_str(mscx_contents);
    reader.config_mut().trim_text(true);

    let mut stack: Vec<Vec<u8>> = Vec::new();
    // Staff ids of each part, in order.
    let mut parts: Vec<Vec<String>> = Vec::new();
    // The score-level `<Staff id>` we're inside, and which ones have a `<Harmony>`.
    let mut current_staff: Option<String> = None;
    let mut staves_with_chords: HashSet<String> = HashSet::new();

    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                let name = e.name().as_ref().to_vec();
                let parent = stack.last().map(Vec::as_slice);
                if name == b"Part" {
                    parts.push(Vec::new());
                } else if name == b"Staff" && parent == Some(b"Part") {
                    if let (Some(part), Some(id)) = (parts.last_mut(), id_attr(&e)) {
                        part.push(id);
                    }
                } else if name == b"Staff" && is_score_level(&stack) {
                    current_staff = id_attr(&e);
                } else if name == b"Harmony" {
                    if let Some(id) = &current_staff {
                        staves_with_chords.insert(id.clone());
                    }
                }
                stack.push(name);
            }
            Event::Empty(e) => {
                if e.name().as_ref() == b"Staff" && stack.last().map(Vec::as_slice) == Some(b"Part")
                {
                    if let (Some(part), Some(id)) = (parts.last_mut(), id_attr(&e)) {
                        part.push(id);
                    }
                }
            }
            Event::End(_) => {
                if let Some(name) = stack.pop() {
                    if name == b"Staff" && is_score_level(&stack) {
                        current_staff = None;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(parts
        .into_iter()
        // Staff-less parts have no track (see `staff_layout`).
        .filter(|ids| !ids.is_empty())
        .map(|ids| PartChords {
            staves: ids.len(),
            has_chord_symbols: ids.iter().any(|id| staves_with_chords.contains(id)),
        })
        .collect())
}

/// `<museScore><Score>` is the open stack when a score-level `<Staff>` starts
/// (a part's staves sit under `<Part>`; excerpt scores nest deeper).
fn is_score_level(stack: &[Vec<u8>]) -> bool {
    stack.len() == 2 && stack[1] == b"Score"
}

fn id_attr(e: &BytesStart) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == b"id")
        .and_then(|a| String::from_utf8(a.value.into_owned()).ok())
}

/// The `(track, channel)` streams carrying chord symbols: for each part that
/// has any, its harmony channel on every one of its tracks. Empty when the
/// layout can't be trusted (track count differs from the staff count) or the
/// MIDI doesn't show a harmony channel for a part.
pub fn find_chord_streams(
    parts: &[PartChords],
    events: &[ScheduledEvent],
    track_count: usize,
) -> Vec<MidiStream> {
    if parts.iter().map(|p| p.staves).sum::<usize>() != track_count {
        return Vec::new();
    }

    let mut streams = Vec::new();
    let mut first_track = 0;
    for part in parts {
        if part.has_chord_symbols {
            let channels = init_channels(events, first_track);
            // One channel only means there's no separate harmony one.
            if let (true, Some(&channel)) = (channels.len() >= 2, channels.last()) {
                streams.extend(
                    (first_track..first_track + part.staves).map(|track| MidiStream {
                        track,
                        channel: channel as u8,
                    }),
                );
            }
        }
        first_track += part.staves;
    }
    streams
}

/// The channels a track initialises at tick 0 (reset-controllers or program
/// change), in order of first appearance — i.e. a part's channel list.
fn init_channels(events: &[ScheduledEvent], track: usize) -> Vec<i32> {
    const RESET_ALL_CONTROLLERS: i32 = 121;
    let mut channels = Vec::new();
    for e in events {
        if e.time_ms > 0.0 {
            break; // events are time-sorted
        }
        let is_init = e.track == track
            && (e.command == 0xC0 || (e.command == 0xB0 && e.data1 == RESET_ALL_CONTROLLERS));
        if is_init && !channels.contains(&e.channel) {
            channels.push(e.channel);
        }
    }
    channels
}

/// Fraction of the time notes are sounding (outside the chord streams and
/// percussion) during which two or more sound at once, at most this for a
/// score to count as a lead sheet.
const LEAD_SHEET_MAX_POLYPHONY: f64 = 0.1;

/// Whether chord symbols should sound by default: only for a lead sheet,
/// where they are the whole accompaniment — chord symbols and at most a
/// single melody line (or none at all). With a written-out accompaniment
/// (piano, bass, ...) the chord symbols are just annotations, and playing
/// them would double it up.
pub fn chords_default_on(events: &[ScheduledEvent], chord_streams: &[MidiStream]) -> bool {
    if chord_streams.is_empty() {
        return false;
    }
    const PERCUSSION_CHANNEL: i32 = 9;

    let mut held: HashMap<(usize, i32, i32), usize> = HashMap::new();
    let mut sounding = 0usize;
    let (mut any_ms, mut poly_ms) = (0.0_f64, 0.0_f64);
    let mut last_ms = 0.0_f64;

    for e in events {
        let is_note = matches!(e.command, 0x80 | 0x90);
        if !is_note
            || e.channel == PERCUSSION_CHANNEL
            || chord_streams
                .iter()
                .any(|s| s.track == e.track && i32::from(s.channel) == e.channel)
        {
            continue;
        }
        let span = e.time_ms - last_ms;
        if sounding >= 1 {
            any_ms += span;
        }
        if sounding >= 2 {
            poly_ms += span;
        }
        last_ms = e.time_ms;

        let key = (e.track, e.channel, e.data1);
        if e.command == 0x90 && e.data2 > 0 {
            *held.entry(key).or_insert(0) += 1;
            sounding += 1;
        } else if let Some(count) = held.get_mut(&key) {
            if *count > 0 {
                *count -= 1;
                sounding -= 1;
            }
        }
    }

    any_ms == 0.0 || poly_ms / any_ms <= LEAD_SHEET_MAX_POLYPHONY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_report_their_staves_and_chord_symbols() {
        let mscx = r#"<museScore><Score>
            <Part><Staff id="1"/><Staff id="2"/></Part>
            <Part><Staff id="3"><StaffType/></Staff></Part>
            <Staff id="1"><Measure><voice><Chord/></voice></Measure></Staff>
            <Staff id="2"><Measure><voice><Harmony><name>C</name></Harmony></voice></Measure></Staff>
            <Staff id="3"><Measure/></Staff>
          </Score></museScore>"#;
        assert_eq!(
            parse_part_chords(mscx).unwrap(),
            vec![
                PartChords {
                    staves: 2,
                    has_chord_symbols: true
                },
                PartChords {
                    staves: 1,
                    has_chord_symbols: false
                },
            ]
        );
    }

    fn note(time_ms: f64, key: i32, on: bool) -> ScheduledEvent {
        ScheduledEvent {
            time_ms,
            track: 0,
            channel: 0,
            command: 0x90,
            data1: key,
            data2: if on { 80 } else { 0 },
        }
    }

    #[test]
    fn no_chord_streams_never_default_on() {
        assert!(!chords_default_on(&[note(0.0, 60, true)], &[]));
    }

    #[test]
    fn a_lone_melody_is_a_lead_sheet_but_stacked_notes_are_not() {
        let streams = [MidiStream {
            track: 0,
            channel: 1,
        }];
        let melody = [
            note(0.0, 60, true),
            note(500.0, 60, false),
            note(500.0, 62, true),
            note(1000.0, 62, false),
        ];
        assert!(chords_default_on(&melody, &streams));

        let two_hands = [
            note(0.0, 60, true),
            note(0.0, 48, true),
            note(1000.0, 60, false),
            note(1000.0, 48, false),
        ];
        assert!(!chords_default_on(&two_hands, &streams));
        assert!(chords_default_on(&[], &streams));
    }
}
