//! Per-measure length (and section-break pause) read from a score's raw
//! `.mscx` XML, in document order — the same index space as webmscore's
//! printed, non-unrolled `measurePositions().elements[]` (see `pieces.rs`'s
//! module docs for why that ordinal correspondence holds).
//!
//! Exists so `timeline::build_timeline` can place every unrolled measure at
//! its *MIDI* tick, and therefore at the time the audio actually plays it.
//! `measurePositions().events[].position` is not always that time: webmscore's
//! MIDI export re-applies tempo per repeat segment only from tempo markings
//! *inside* that segment, so after a D.S./D.C. jump to a point whose tempo
//! marking sits before the jump target, the MIDI keeps playing at whatever
//! tempo was in effect at the jump, while `measurePositions()` uses the
//! correct one. Confirmed on EoSD.mscz: a D.S. back into a 152bpm passage
//! plays at the preceding 132bpm in the MIDI, so audio drifts 12.4s behind
//! `measurePositions()` across that pass, and every later piece in the file
//! inherits the offset.

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use thiserror::Error;

/// MuseScore's default section-break pause, used when a `<LayoutBreak>` of
/// subtype `section` has no explicit `<pause>` child (MuseScore only writes
/// the property when it differs from the default).
const DEFAULT_SECTION_PAUSE_SECS: f64 = 3.0;

#[derive(Debug, Error)]
pub enum MeasureLayoutError {
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeasureInfo {
    /// Actual length as a fraction of a whole note (`<Measure len="n/d">`
    /// for an irregular/pickup measure, otherwise the time signature in effect).
    pub whole_notes: f64,
    /// Seconds of silence MuseScore inserts after this measure (a section
    /// break's pause), 0 for none.
    pub pause_secs: f64,
}

#[derive(PartialEq)]
enum TextTarget {
    None,
    SigN,
    SigD,
    BreakSubtype,
    BreakPause,
}

/// Reads the first content staff (a `<Staff>` directly under `<Score>`; the
/// ones under `<Part>` are definitions with no measures) — every staff has
/// the same measures, so one is enough.
pub fn parse_measure_layout(mscx_contents: &str) -> Result<Vec<MeasureInfo>, MeasureLayoutError> {
    let mut reader = Reader::from_str(mscx_contents);
    reader.config_mut().trim_text(true);

    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut in_staff = false;
    let mut measures: Vec<MeasureInfo> = Vec::new();

    let (mut sig_n, mut sig_d) = (4.0_f64, 4.0_f64);
    let mut pending_sig_n: Option<f64> = None;
    let mut in_measure = false;
    let mut measure_len: Option<f64> = None;
    let mut measure_pause = 0.0_f64;
    let mut break_subtype = String::new();
    let mut break_pause: Option<f64> = None;
    let mut text_target = TextTarget::None;

    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                let name = e.name().as_ref().to_vec();
                let parent = stack.last().map(Vec::as_slice);
                if !in_staff && name == b"Staff" && parent == Some(b"Score") {
                    in_staff = true;
                } else if in_staff {
                    match name.as_slice() {
                        b"Measure" if parent == Some(b"Staff") => {
                            in_measure = true;
                            measure_len = len_attribute(&e);
                            measure_pause = 0.0;
                        }
                        b"sigN" => text_target = TextTarget::SigN,
                        b"sigD" => text_target = TextTarget::SigD,
                        b"LayoutBreak" => {
                            break_subtype.clear();
                            break_pause = None;
                        }
                        b"subtype" if parent == Some(b"LayoutBreak") => text_target = TextTarget::BreakSubtype,
                        b"pause" if parent == Some(b"LayoutBreak") => text_target = TextTarget::BreakPause,
                        _ => {}
                    }
                }
                stack.push(name);
            }
            Event::Text(t) if in_staff => {
                let text = t.unescape()?;
                match text_target {
                    TextTarget::SigN => pending_sig_n = text.parse().ok(),
                    TextTarget::SigD => {
                        if let (Some(n), Ok(d)) = (pending_sig_n.take(), text.parse::<f64>()) {
                            sig_n = n;
                            sig_d = d;
                        }
                    }
                    TextTarget::BreakSubtype => break_subtype = text.into_owned(),
                    TextTarget::BreakPause => break_pause = text.parse().ok(),
                    TextTarget::None => {}
                }
                text_target = TextTarget::None;
            }
            Event::End(e) => {
                stack.pop();
                if !in_staff {
                    continue;
                }
                text_target = TextTarget::None;
                match e.name().as_ref() {
                    b"Measure" if stack.last().map(Vec::as_slice) == Some(b"Staff") => {
                        // Computed at the end so a time signature placed in
                        // this very measure already applies to it.
                        in_measure = false;
                        measures.push(MeasureInfo {
                            whole_notes: measure_len.take().unwrap_or(sig_n / sig_d),
                            pause_secs: measure_pause,
                        });
                    }
                    // A section break inside a measure, or on a frame
                    // (VBox/TBox) right after one, both mark the end of that
                    // measure.
                    b"LayoutBreak" if break_subtype == "section" => {
                        let pause = break_pause.unwrap_or(DEFAULT_SECTION_PAUSE_SECS);
                        if in_measure {
                            measure_pause = pause;
                        } else if let Some(last) = measures.last_mut() {
                            last.pause_secs = pause;
                        }
                    }
                    b"Staff" if stack.last().map(Vec::as_slice) == Some(b"Score") => break,
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(measures)
}

/// `<Measure len="3/8">` -> `Some(0.375)`.
fn len_attribute(e: &BytesStart) -> Option<f64> {
    let attr = e.try_get_attribute("len").ok()??;
    let value = attr.unescape_value().ok()?;
    let (n, d) = value.split_once('/')?;
    let (n, d) = (n.trim().parse::<f64>().ok()?, d.trim().parse::<f64>().ok()?);
    (d > 0.0).then_some(n / d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lengths_time_signature_changes_and_section_pauses() {
        let mscx = r#"<museScore><Score>
            <Part><Staff id="1"><StaffType/></Staff></Part>
            <Staff id="1">
              <VBox><Text><style>title</style><text>A</text></Text></VBox>
              <Measure len="1/4"><voice><TimeSig><sigN>3</sigN><sigD>4</sigD></TimeSig></voice></Measure>
              <Measure><voice/></Measure>
              <Measure><voice/><LayoutBreak><subtype>section</subtype></LayoutBreak></Measure>
              <VBox><LayoutBreak><subtype>page</subtype></LayoutBreak></VBox>
              <Measure><voice><TimeSig><sigN>6</sigN><sigD>8</sigD></TimeSig></voice></Measure>
              <VBox><LayoutBreak><subtype>section</subtype><pause>1.5</pause></LayoutBreak></VBox>
              <Measure><voice/></Measure>
            </Staff>
            <Staff id="2"><Measure><voice/></Measure></Staff>
          </Score></museScore>"#;
        let m = parse_measure_layout(mscx).unwrap();
        let got: Vec<(f64, f64)> = m.iter().map(|m| (m.whole_notes, m.pause_secs)).collect();
        assert_eq!(got, vec![(0.25, 0.0), (0.75, 0.0), (0.75, 3.0), (0.75, 1.5), (0.75, 0.0)]);
    }
}
