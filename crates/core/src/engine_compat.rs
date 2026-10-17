//! Rewrites newer-MuseScore `.mscz` content into the form webmscore's
//! engine (MuseScore 4.0.0's core, inside webmscore 1.2.1) understands, for
//! constructs it would otherwise silently drop.
//!
//! Key signatures: MuseScore 4.1+ writes `<KeySig><concertKey>N</concertKey>
//! [<actualKey>M</actualKey>]</KeySig>`; 4.0 wrote `<accidental>N</accidental>`.
//! The 4.0 reader skips the unknown tags, leaving every key signature at C
//! major — none drawn at any system start, every flat/sharp drawn as an
//! explicit accidental instead (notes keep their own spelling, so pitches and
//! audio are unaffected). Confirmed on EoSD.mscz/Dark Side Of Fate.mscz
//! (saved by MuseScore 4.5.2): 0 `KeySig` elements rendered before this
//! rewrite, 6 flats on every system after, matching MuseScore's own PDF.
//!
//! Only the score rootfile is rewritten; every other archive entry is copied
//! through byte-for-byte. Never touches the user's file on disk — the result
//! only goes to the in-memory engine.

use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::mscz::{self, MsczError};

/// The rewritten archive, or `None` if nothing in it needed adapting (the
/// caller then keeps using its original bytes).
pub fn adapt_for_engine(mscz_bytes: &[u8]) -> Result<Option<Vec<u8>>, MsczError> {
    let mut archive = ZipArchive::new(Cursor::new(mscz_bytes))?;
    let rootfile_path = mscz::find_rootfile_path(&mut archive)?;
    let mut contents = String::new();
    archive.by_name(&rootfile_path)?.read_to_string(&mut contents)?;

    let Some(adapted) = adapt_key_signatures(&contents) else {
        return Ok(None);
    };

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index)?;
        if entry.name()? == rootfile_path {
            drop(entry);
            writer.start_file(rootfile_path.as_str(), SimpleFileOptions::default())?;
            writer.write_all(adapted.as_bytes())?;
        } else {
            writer.raw_copy_file(entry)?;
        }
    }
    Ok(Some(writer.finish()?.into_inner()))
}

/// Rewrites every `<KeySig>` using `<concertKey>`/`<actualKey>` into 4.0's
/// `<accidental>` form, or `None` if the score has none. The key to show is
/// the written (`actualKey`) one for a transposing staff, unless the score is
/// displayed in concert pitch — `concertKey` otherwise (no `actualKey` means
/// the two are the same).
fn adapt_key_signatures(mscx: &str) -> Option<String> {
    if !mscx.contains("<concertKey>") {
        return None;
    }
    let concert_pitch = tag_value(mscx, "concertPitch").is_some_and(|v| v == "1");

    let mut out = String::with_capacity(mscx.len());
    let mut rest = mscx;
    while let Some(start) = rest.find("<KeySig>") {
        let Some(len) = rest[start..].find("</KeySig>") else { break };
        let end = start + len + "</KeySig>".len();
        out.push_str(&rest[..start]);
        out.push_str(&adapt_key_sig_element(&rest[start..end], concert_pitch));
        rest = &rest[end..];
    }
    out.push_str(rest);
    Some(out)
}

fn adapt_key_sig_element(element: &str, concert_pitch: bool) -> String {
    let concert = tag_value(element, "concertKey");
    let actual = tag_value(element, "actualKey");
    let key = if concert_pitch { concert.or(actual) } else { actual.or(concert) };
    let Some(key) = key else {
        return element.to_string();
    };
    let without = remove_tag(&remove_tag(element, "concertKey"), "actualKey");
    let inner_start = "<KeySig>".len();
    format!("<KeySig><accidental>{key}</accidental>{}", &without[inner_start..])
}

/// Text of the first `<tag>text</tag>` in `s`.
fn tag_value<'a>(s: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = s.find(&open)? + open.len();
    let len = s[start..].find(&format!("</{tag}>"))?;
    Some(s[start..start + len].trim())
}

/// `s` with the first `<tag>...</tag>` (and the whitespace before it) removed.
fn remove_tag(s: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let (Some(start), Some(close_at)) = (s.find(&open), s.find(&close)) else {
        return s.to_string();
    };
    let start = s[..start].trim_end().len();
    format!("{}{}", &s[..start], &s[close_at + close.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_concert_key_to_accidental() {
        let mscx = "<Score><Staff><Measure><voice>\n  <KeySig>\n    <eid>x</eid>\n    <concertKey>-6</concertKey>\n    </KeySig>\n</voice></Measure></Staff></Score>";
        let out = adapt_key_signatures(mscx).unwrap();
        assert_eq!(
            out,
            "<Score><Staff><Measure><voice>\n  <KeySig><accidental>-6</accidental>\n    <eid>x</eid>\n    </KeySig>\n</voice></Measure></Staff></Score>"
        );
    }

    #[test]
    fn transposing_staff_uses_written_key_unless_in_concert_pitch() {
        let keysig = "<KeySig><concertKey>0</concertKey><actualKey>2</actualKey></KeySig>";
        assert_eq!(adapt_key_signatures(keysig).unwrap(), "<KeySig><accidental>2</accidental></KeySig>");
        let concert = format!("<Style><concertPitch>1</concertPitch></Style>{keysig}");
        assert!(adapt_key_signatures(&concert).unwrap().ends_with("<KeySig><accidental>0</accidental></KeySig>"));
    }

    #[test]
    fn older_format_is_left_alone() {
        assert_eq!(adapt_key_signatures("<KeySig><accidental>-1</accidental></KeySig>"), None);
    }

    #[test]
    fn real_45_file_round_trips_with_every_key_signature_rewritten() {
        let path = std::path::Path::new("/home/hawa/Documents/Musescore/EoSD.mscz");
        if !path.exists() {
            eprintln!("skipping: EoSD.mscz not present in this environment");
            return;
        }
        let original = std::fs::read(path).unwrap();
        let adapted = adapt_for_engine(&original).unwrap().expect("EoSD uses <concertKey>");
        let contents = mscz::read_rootfile_contents(Cursor::new(&adapted)).unwrap();
        assert!(!contents.contains("<concertKey>"));
        assert_eq!(contents.matches("<KeySig>").count(), contents.matches("<KeySig><accidental>").count());

        // Everything else in the archive survives untouched.
        let before = ZipArchive::new(Cursor::new(&original)).unwrap();
        let after = ZipArchive::new(Cursor::new(&adapted)).unwrap();
        let names = |a: &ZipArchive<Cursor<&Vec<u8>>>| {
            a.file_names().map(|n| n.unwrap().into_owned()).collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(names(&before), names(&after));
    }
}
