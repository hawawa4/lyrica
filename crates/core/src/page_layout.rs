//! A "wide page" layout: the score re-laid-out on a landscape page so each
//! system holds many more measures and fills a wide window, instead of the
//! portrait page the file was engraved for.
//!
//! webmscore exposes no layout/style API, so the page is changed the only way
//! left — in the score file itself, before the engine loads it. In memory
//! only: the user's file on disk is never touched, and the original layout is
//! just the unmodified bytes.
//!
//! **Feed this the engine's own re-save (`saveMsc`), not a file from
//! MuseScore 4.1+.** The engine ignores the page size (and `<Style>`
//! generally) in a file with a 4.5 `fileVersion`, wherever it's stored —
//! verified by loading widened EoSD.mscz / Dark Side Of Fate.mscz directly:
//! the page didn't change. Its own re-save is version 4.00, which it honours.
//!
//! What changes:
//! - `pageWidth`/`pagePrintableWidth` grow to `WIDE_ASPECT` x the page height
//!   (height, margins and staff size are unchanged, so notation keeps its
//!   engraved size and simply gets longer lines). A page that is already at
//!   least that wide is left alone.
//! - Manual system/page breaks (`<LayoutBreak>` `line`/`page`) are dropped,
//!   because they would pin each line to the engraver's portrait measure
//!   count and defeat the point. Section breaks stay: they are musical.
//!
//! The style can live in `score_style.mss` (MuseScore 4.1+ saves it there) or
//! inline as `<Style>` in the score rootfile (older files, webmscore's own
//! re-saves), and an inline one overrides the other. Both are written, so it
//! works whichever the loading engine reads last.

use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::mscz::{self, MsczError};

/// Page width / page height of the wide layout (16:10 landscape, like most
/// screens — its fit-to-width then also nearly fits the height).
pub const WIDE_ASPECT: f64 = 1.6;

// MuseScore's own defaults (A4, in inches), for styles that don't store them.
const DEFAULT_WIDTH: f64 = 8.26772;
const DEFAULT_HEIGHT: f64 = 11.6929;
const DEFAULT_PRINTABLE_WIDTH: f64 = 7.48032;

/// The `.mscz` re-laid-out on a wide page, or `None` if nothing in it needed
/// to change.
pub fn widen(mscz_bytes: &[u8]) -> Result<Option<Vec<u8>>, MsczError> {
    let mut archive = ZipArchive::new(Cursor::new(mscz_bytes))?;
    let rootfile_path = mscz::find_rootfile_path(&mut archive)?;
    let mut root = String::new();
    archive
        .by_name(&rootfile_path)?
        .read_to_string(&mut root)?;

    let mss_path = (0..archive.len())
        .filter_map(|i| archive.by_index_raw(i).ok()?.name().ok().map(|n| n.into_owned()))
        .find(|name| name.ends_with(".mss"));
    let mss = match &mss_path {
        Some(path) => {
            let mut text = String::new();
            archive.by_name(path)?.read_to_string(&mut text)?;
            Some(text)
        }
        None => None,
    };

    // An inline style overrides the style file, so it decides the real page.
    let inline_style = style_block(&root);
    let value = |tag: &str| {
        inline_style
            .and_then(|s| tag_number(s, tag))
            .or_else(|| mss.as_deref().and_then(|s| tag_number(s, tag)))
    };
    let width = value("pageWidth").unwrap_or(DEFAULT_WIDTH);
    let height = value("pageHeight").unwrap_or(DEFAULT_HEIGHT);
    let printable = value("pagePrintableWidth").unwrap_or(DEFAULT_PRINTABLE_WIDTH);

    let wide_width = height * WIDE_ASPECT;
    let new_style: Vec<(&str, String)> = if width < wide_width {
        // The side margins stay as engraved; only the printable area grows.
        let margins = (width - printable).max(0.0);
        vec![
            ("pageWidth", format_inches(wide_width)),
            ("pagePrintableWidth", format_inches(wide_width - margins)),
        ]
    } else {
        Vec::new()
    };

    let new_root = apply_to_root(&root, &new_style);
    let new_mss = mss.as_deref().map(|text| set_style_tags(text, &new_style));

    let root_changed = new_root != root;
    let mss_changed = new_mss.as_deref() != mss.as_deref();
    if !root_changed && !mss_changed {
        return Ok(None);
    }

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index)?;
        let name = entry.name()?.into_owned();
        let replacement = if name == rootfile_path && root_changed {
            Some(new_root.as_bytes())
        } else if Some(&name) == mss_path.as_ref() && mss_changed {
            new_mss.as_deref().map(str::as_bytes)
        } else {
            None
        };
        match replacement {
            Some(bytes) => {
                drop(entry);
                writer.start_file(name.as_str(), SimpleFileOptions::default())?;
                writer.write_all(bytes)?;
            }
            None => writer.raw_copy_file(entry)?,
        }
    }
    Ok(Some(writer.finish()?.into_inner()))
}

/// The score rootfile with the page tags set and manual breaks removed. The
/// style goes inline too (creating the block if the file keeps its style
/// elsewhere) — see the module docs.
fn apply_to_root(root: &str, tags: &[(&str, String)]) -> String {
    let root = strip_manual_breaks(root);
    if tags.is_empty() {
        return root;
    }
    if root.contains("<Style>") {
        return set_style_tags(&root, tags);
    }
    let Some(score_at) = root.find("<Score>") else {
        return root;
    };
    let at = score_at + "<Score>".len();
    let mut block = String::from("\n    <Style>");
    for (tag, value) in tags {
        block.push_str(&format!("\n      <{tag}>{value}</{tag}>"));
    }
    block.push_str("\n    </Style>");
    format!("{}{block}{}", &root[..at], &root[at..])
}

/// `text` with each `<tag>` inside its (first) `<Style>` block set to the
/// given value — replaced where present, added at the block's end otherwise.
/// Text without a `<Style>` block is returned unchanged.
fn set_style_tags(text: &str, tags: &[(&str, String)]) -> String {
    let Some(start) = text.find("<Style>") else {
        return text.to_string();
    };
    let Some(len) = text[start..].find("</Style>") else {
        return text.to_string();
    };
    let end = start + len;
    let mut style = text[start..end].to_string();
    for (tag, value) in tags {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        match (style.find(&open), style.find(&close)) {
            (Some(o), Some(c)) if o < c => {
                style.replace_range(o + open.len()..c, value);
            }
            _ => style.push_str(&format!("  <{tag}>{value}</{tag}>\n    ")),
        }
    }
    format!("{}{style}{}", &text[..start], &text[end..])
}

/// The first `<Style>…</Style>` block's text.
fn style_block(text: &str) -> Option<&str> {
    let start = text.find("<Style>")?;
    let len = text[start..].find("</Style>")?;
    Some(&text[start..start + len])
}

fn tag_number(s: &str, tag: &str) -> Option<f64> {
    let open = format!("<{tag}>");
    let start = s.find(&open)? + open.len();
    let len = s[start..].find(&format!("</{tag}>"))?;
    s[start..start + len].trim().parse().ok()
}

fn format_inches(value: f64) -> String {
    format!("{value:.5}")
}

/// Removes every `<LayoutBreak>` whose subtype is `line` or `page` (and the
/// whitespace before it); other breaks are kept.
fn strip_manual_breaks(text: &str) -> String {
    const OPEN: &str = "<LayoutBreak>";
    const CLOSE: &str = "</LayoutBreak>";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let Some(len) = rest[start..].find(CLOSE) else {
            break;
        };
        let end = start + len + CLOSE.len();
        let block = &rest[start..end];
        let removable = block.contains("<subtype>line</subtype>")
            || block.contains("<subtype>page</subtype>");
        if removable {
            out.push_str(rest[..start].trim_end_matches([' ', '\t']));
            // Drop the line the block sat on, not just the block, so no blank line is left.
            let after = &rest[end..];
            rest = after.strip_prefix('\n').unwrap_or(after);
        } else {
            out.push_str(&rest[..end]);
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(mss: Option<&str>, mscx: &str) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        writer.start_file("META-INF/container.xml", options).unwrap();
        writer
            .write_all(
                b"<container><rootfiles><rootfile full-path=\"score.mscx\"/></rootfiles></container>",
            )
            .unwrap();
        if let Some(mss) = mss {
            writer.start_file("score_style.mss", options).unwrap();
            writer.write_all(mss.as_bytes()).unwrap();
        }
        writer.start_file("score.mscx", options).unwrap();
        writer.write_all(mscx.as_bytes()).unwrap();
        writer.start_file("Thumbnails/thumbnail.png", options).unwrap();
        writer.write_all(b"png").unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn entry(bytes: &[u8], name: &str) -> String {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        archive.by_name(name).unwrap().read_to_string(&mut text).unwrap();
        text
    }

    const A4_STYLE: &str = "<museScore><Style>\n    <pageWidth>8.26772</pageWidth>\n    <pageHeight>11.6929</pageHeight>\n    <pagePrintableWidth>7.48032</pagePrintableWidth>\n  </Style></museScore>";

    #[test]
    fn inline_style_is_widened_keeping_the_margins() {
        let mscx = "<museScore><Score><Style>\n    <pageWidth>8.27</pageWidth>\n    <pageHeight>11.69</pageHeight>\n    <pagePrintableWidth>7.48</pagePrintableWidth>\n  </Style></Score></museScore>";
        let out = widen(&archive(None, mscx)).unwrap().unwrap();
        let root = entry(&out, "score.mscx");
        assert!(root.contains("<pageWidth>18.70400</pageWidth>"), "{root}");
        // 8.27 - 7.48 = 0.79 of margins stays.
        assert!(root.contains("<pagePrintableWidth>17.91400</pagePrintableWidth>"), "{root}");
        assert!(root.contains("<pageHeight>11.69</pageHeight>"));
        assert_eq!(entry(&out, "Thumbnails/thumbnail.png"), "png");
    }

    #[test]
    fn style_file_and_missing_inline_style_both_get_the_page() {
        let mscx = "<museScore><Score>\n    <Division>480</Division>\n  </Score></museScore>";
        let out = widen(&archive(Some(A4_STYLE), mscx)).unwrap().unwrap();
        let mss = entry(&out, "score_style.mss");
        assert!(mss.contains("<pageWidth>18.70864</pageWidth>"), "{mss}");
        let root = entry(&out, "score.mscx");
        assert!(root.contains("<Style>"), "{root}");
        assert!(root.contains("<pageWidth>18.70864</pageWidth>"), "{root}");
        assert!(root.contains("<Division>480</Division>"));
    }

    #[test]
    fn default_page_with_no_style_at_all_is_widened() {
        let mscx = "<museScore><Score>\n    <Division>480</Division>\n  </Score></museScore>";
        let out = widen(&archive(None, mscx)).unwrap().unwrap();
        let root = entry(&out, "score.mscx");
        assert!(root.contains("<pageWidth>18.70864</pageWidth>"), "{root}");
        // 8.26772 - 7.48032 = 0.7874 margins.
        assert!(root.contains("<pagePrintableWidth>17.92124</pagePrintableWidth>"), "{root}");
    }

    #[test]
    fn already_wide_page_only_loses_its_breaks() {
        let mscx = "<museScore><Score><Style><pageWidth>20</pageWidth><pageHeight>10</pageHeight><pagePrintableWidth>19</pagePrintableWidth></Style>\n<Measure>\n  <LayoutBreak>\n    <subtype>line</subtype>\n    </LayoutBreak>\n</Measure></Score></museScore>";
        let out = widen(&archive(None, mscx)).unwrap().unwrap();
        let root = entry(&out, "score.mscx");
        assert!(root.contains("<pageWidth>20</pageWidth>"));
        assert!(!root.contains("LayoutBreak"));
        assert_eq!(widen(&out).unwrap(), None);
    }

    #[test]
    fn only_line_and_page_breaks_are_removed() {
        let text = "<a>\n  <LayoutBreak>\n    <subtype>line</subtype>\n    </LayoutBreak>\n  <LayoutBreak>\n    <subtype>section</subtype>\n    </LayoutBreak>\n  <LayoutBreak><subtype>page</subtype></LayoutBreak>\n</a>";
        let out = strip_manual_breaks(text);
        assert_eq!(out.matches("<LayoutBreak>").count(), 1);
        assert!(out.contains("<subtype>section</subtype>"));
        assert!(!out.contains("line</subtype>") && !out.contains("page</subtype>"));
    }

    #[test]
    fn widening_twice_is_stable() {
        let mscx = "<museScore><Score><Division>480</Division></Score></museScore>";
        let once = widen(&archive(None, mscx)).unwrap().unwrap();
        assert_eq!(widen(&once).unwrap(), None);
    }

    #[test]
    fn real_score_gets_a_wide_page_without_breaks() {
        let path = std::path::Path::new("/media/superfast/pianostuff/Sheets/Games/Touhou/Chronondecay/EoSD.mscz");
        if !path.exists() {
            eprintln!("skipping: EoSD.mscz not present in this environment");
            return;
        }
        let original = std::fs::read(path).unwrap();
        let wide = widen(&original).unwrap().expect("A4 score should be widened");
        let contents = mscz::read_rootfile_contents(Cursor::new(&wide)).unwrap();
        assert!(contents.contains("<pageWidth>18.70864</pageWidth>"));
        assert!(!contents.contains("<subtype>line</subtype>"));
        assert!(!contents.contains("<subtype>page</subtype>"));
    }
}
