//! Pieces index: detects when a single `.mscz` file actually contains
//! several distinct pieces concatenated together (common for a combined
//! "album" file — e.g. a game/anime soundtrack bundled as one score), so the
//! UI can list and jump between them.
//!
//! There's no field for this in webmscore's exposed JS API: `metadata()`'s
//! `textFramesData` gives flat title strings with no position/measure-index
//! info, and `measurePositions()`/`segmentPositions()` carry pure geometry
//! with no element-type/text-content field (confirmed by direct inspection
//! of real JSON dumps). The actual signal lives only in the raw `.mscx` XML:
//! MuseScore writes each piece's title as a `<Text><style>title</style>
//! <text>...</text></Text>` inside a `<VBox>` frame, placed immediately
//! before the `<Measure>` where that piece starts. Counting `<Measure>`
//! elements in document order up to each such `VBox` gives exactly the
//! index into `measurePositions().elements[]` (confirmed empirically
//! against a real 17-piece combined file: `metadata().measures` matched
//! `elements.length` 1:1, and ordinal measure counts lined up with expected
//! piece lengths).
//!
//! Deliberately does NOT rely on `<LayoutBreak><subtype>section</subtype>
//! <startWithMeasureOne>1</startWithMeasureOne></LayoutBreak>` (MuseScore's
//! own "reset bar numbers for new section" feature) as the primary signal:
//! real-world files use section breaks for other reasons (e.g. D.C./D.S.
//! jump targets) without ever setting `startWithMeasureOne`, and the title
//! VBox is both more directly indicative of "a new piece starts here" and
//! gives the title text for free.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PiecesError {
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
}

/// One detected piece boundary: `start_measure_index` is 0-based, matching
/// `crates/core/src/timeline.rs`'s `TimelineEvent::measure_index` (both are
/// ultimately indices into webmscore's `measurePositions().elements[]`,
/// document order).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Piece {
    pub start_measure_index: u32,
    pub title: String,
}

/// Scans a score's raw `.mscx` XML (as returned by `mscz::read_rootfile_contents`)
/// for title-style text frames, returning one `Piece` per title found, in
/// document order. A file with a single piece (the common case) returns
/// either an empty list or a single entry at measure 0, depending on whether
/// it has its own title frame — callers should treat a list with 0 or 1
/// entries as "not actually multi-piece" (no boundaries worth showing).
pub fn detect_pieces(mscx_contents: &str) -> Result<Vec<Piece>, PiecesError> {
    let mut reader = Reader::from_str(mscx_contents);
    reader.config_mut().trim_text(true);

    let mut pieces = Vec::new();
    let mut measure_count: u32 = 0;

    // State while inside a <VBox>...</VBox>: are we in a <Text> whose <style>
    // we've confirmed is "title", and if so, what's its <text> content once
    // we reach it. MuseScore writes <style> before <text> within a <Text>
    // element (confirmed in the real fixture), so a single pass suffices.
    let mut in_vbox = false;
    let mut in_text_elem = false;
    let mut current_text_is_title = false;
    let mut pending_title: Option<String> = None;

    loop {
        match reader.read_event()? {
            Event::Start(e) => match e.name().as_ref() {
                b"Measure" => measure_count += 1,
                b"VBox" | b"TBox" => in_vbox = true,
                b"Text" if in_vbox => {
                    in_text_elem = true;
                    current_text_is_title = false;
                }
                b"style" if in_text_elem => {
                    let style = read_text_content(&mut reader)?;
                    current_text_is_title = style == "title";
                }
                b"text" if in_text_elem && current_text_is_title => {
                    pending_title = Some(read_text_content(&mut reader)?);
                }
                _ => {}
            },
            Event::End(e) => match e.name().as_ref() {
                b"Text" => {
                    in_text_elem = false;
                    if current_text_is_title {
                        if let Some(title) = pending_title.take() {
                            pieces.push(Piece {
                                start_measure_index: measure_count,
                                title,
                            });
                        }
                    }
                    current_text_is_title = false;
                }
                b"VBox" | b"TBox" => in_vbox = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(pieces)
}

/// Reads the text content of the current element (cursor just past its
/// `Event::Start`), e.g. `<style>title</style>` -> `"title"`.
fn read_text_content(reader: &mut Reader<&[u8]>) -> Result<String, quick_xml::Error> {
    match reader.read_event()? {
        Event::Text(t) => Ok(t.unescape()?.into_owned()),
        _ => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mscz;
    use std::fs::File;
    use std::path::Path;

    #[test]
    fn single_piece_file_has_at_most_one_boundary() {
        let path = Path::new("/home/hawa/Documents/Musescore/Dark Side Of Fate.mscz");
        if !path.exists() {
            eprintln!("skipping: sample file not present in this environment");
            return;
        }
        let file = File::open(path).unwrap();
        let contents = mscz::read_rootfile_contents(file).unwrap();
        let pieces = detect_pieces(&contents).unwrap();
        assert!(pieces.len() <= 1, "expected a single-piece file to have at most one title frame, got {pieces:?}");
    }

    #[test]
    fn combined_album_file_detects_all_piece_boundaries() {
        let path = Path::new("/home/hawa/Documents/Musescore/EoSD.mscz");
        if !path.exists() {
            eprintln!("skipping: EoSD.mscz fixture not present in this environment");
            return;
        }
        let file = File::open(path).unwrap();
        let contents = mscz::read_rootfile_contents(file).unwrap();
        let pieces = detect_pieces(&contents).unwrap();

        assert_eq!(pieces.len(), 17, "expected 17 piece boundaries, got {}", pieces.len());

        // Spot-check against ordinals independently verified during research
        // (counting <Measure> tags in document order up to each title VBox).
        assert_eq!(pieces[0], Piece { start_measure_index: 0, title: "赤より紅い夢".to_string() });
        assert_eq!(pieces[1], Piece { start_measure_index: 28, title: "ほおずきみたいに紅い魂".to_string() });
        assert_eq!(pieces[16], Piece { start_measure_index: 832, title: "紅楼\u{3000}～ Eastern Dream...".to_string() });

        // Boundaries must be strictly increasing (document order, no duplicates/out-of-order).
        for pair in pieces.windows(2) {
            assert!(
                pair[0].start_measure_index < pair[1].start_measure_index,
                "boundaries must be strictly increasing: {:?} then {:?}",
                pair[0],
                pair[1]
            );
        }
    }
}
