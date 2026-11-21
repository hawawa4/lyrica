//! PDF mode: measure detection via optical music recognition, using
//! [Audiveris](https://github.com/Audiveris/audiveris) as an optional
//! external tool. When it's installed, it replaces the classical-CV barline
//! scan (`cv-barline`) for finding measures on a PDF: it gets the measure
//! structure right far more often (see `docs/omr-investigation.md`) and
//! gives each measure's full box, not just barline columns.
//!
//! Audiveris is not bundled (~190MB with its own Java runtime, AGPL); we
//! look for it where its official `.deb` installs it, on `PATH`, or at
//! `$LYRICA_AUDIVERIS`. Without it, the app keeps using `cv-barline`.
//!
//! A run transcribes the whole book (`-batch -export`). We read the measure
//! geometry from the `.omr` project it saves — a zip holding `book.xml` and
//! one `sheet#N/sheet#N.xml` per page, where each `<system>` lists its
//! `<stack left right>` measure columns and its staff lines' y positions —
//! and keep the exported MusicXML in the PDF's data folder so a future
//! "play recognised notes" feature can reuse it without another run.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OmrError {
    #[error("Audiveris is not installed")]
    NotInstalled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Audiveris failed: {0}")]
    Failed(String),
    #[error("couldn't read Audiveris output: {0}")]
    Parse(String),
}

impl From<zip::result::ZipError> for OmrError {
    fn from(e: zip::result::ZipError) -> Self {
        OmrError::Parse(e.to_string())
    }
}

impl From<quick_xml::Error> for OmrError {
    fn from(e: quick_xml::Error) -> Self {
        OmrError::Parse(e.to_string())
    }
}

/// One recognised measure. Coordinates are fractions (0-1) of the page's
/// width/height, the same convention as `CalibrationPoint`. A measure split
/// by a mid-measure repeat barline comes out as two boxes (it's drawn as two).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct MeasureBox {
    /// 0-based PDF page.
    pub page: u32,
    pub x0: f64,
    pub x1: f64,
    /// Top line of the system's first staff / bottom line of its last.
    pub y0: f64,
    pub y1: f64,
}

/// Streamed while Audiveris runs. Pages are processed one after another.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OmrProgress {
    /// Audiveris (a JVM) is starting up and opening the PDF.
    Starting,
    /// Recognising `page` (1-based) of `pages`.
    Page { page: u32, pages: u32 },
}

/// Env var pointing at an Audiveris executable, checked first.
pub const AUDIVERIS_ENV: &str = "LYRICA_AUDIVERIS";
/// Where Audiveris's official `.deb` installs its launcher.
const DEB_PATH: &str = "/opt/audiveris/bin/Audiveris";

/// The Audiveris executable to use, if any.
pub fn locate_audiveris() -> Option<PathBuf> {
    let from_env = std::env::var_os(AUDIVERIS_ENV).map(PathBuf::from);
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    locate_in(from_env, &path_var, Path::new(DEB_PATH))
}

fn locate_in(from_env: Option<PathBuf>, path_var: &OsString, deb_path: &Path) -> Option<PathBuf> {
    if let Some(p) = from_env.filter(|p| p.is_file()) {
        return Some(p);
    }
    if deb_path.is_file() {
        return Some(deb_path.to_path_buf());
    }
    std::env::split_paths(path_var).find_map(|dir| {
        ["Audiveris", "audiveris"]
            .iter()
            .map(|name| dir.join(name))
            .find(|p| p.is_file())
    })
}

/// What a successful run leaves behind.
#[derive(Debug)]
pub struct OmrOutput {
    pub boxes: Vec<MeasureBox>,
    /// Exported MusicXML (`.mxl`) files: one, or one per movement.
    pub musicxml: Vec<PathBuf>,
}

/// Runs Audiveris on `pdf` inside `work_dir` (created; the caller removes
/// it) and returns the recognised measures. Blocks for roughly 5s per page.
pub fn recognise(
    exe: &Path,
    pdf: &Path,
    work_dir: &Path,
    on_progress: &mut dyn FnMut(OmrProgress),
) -> Result<OmrOutput, OmrError> {
    // A fixed input name keeps Audiveris's output names predictable,
    // whatever characters the real file name has.
    let input = work_dir.join("score.pdf");
    let out_dir = work_dir.join("out");
    std::fs::create_dir_all(&out_dir)?;
    std::fs::copy(pdf, &input)?;

    on_progress(OmrProgress::Starting);
    let mut child = Command::new(exe)
        .args(["-batch", "-export", "-output"])
        .arg(&out_dir)
        .arg("--")
        .arg(&input)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                OmrError::NotInstalled
            } else {
                OmrError::Io(e)
            }
        })?;

    // Drain stderr on the side so a chatty JVM can't block on a full pipe.
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let stderr_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut log_tail: Vec<String> = Vec::new();
    let mut pages = 0;
    let stdout = child.stdout.take().expect("stdout is piped");
    for line in BufReader::new(stdout).lines() {
        let line = line?;
        match parse_log_line(&line) {
            Some(LogEvent::SheetCount(n)) => pages = n,
            Some(LogEvent::LoadedSheet(page)) => on_progress(OmrProgress::Page {
                page,
                pages: pages.max(page),
            }),
            None => {}
        }
        if line.contains("ERROR") || line.contains("Exception") {
            log_tail.push(line);
            if log_tail.len() > 5 {
                log_tail.remove(0);
            }
        }
    }
    let status = child.wait()?;
    let stderr_text = stderr_reader.join().unwrap_or_default();

    let omr_path = out_dir.join("score.omr");
    if !status.success() || !omr_path.is_file() {
        let mut detail = log_tail.join("\n");
        if detail.is_empty() {
            detail = stderr_text
                .lines()
                .rev()
                .take(5)
                .collect::<Vec<_>>()
                .join("\n");
        }
        if detail.is_empty() {
            detail = format!("exited with {status} and produced no result");
        }
        return Err(OmrError::Failed(detail));
    }

    let boxes = parse_book(std::fs::File::open(&omr_path)?)?;
    let mut musicxml: Vec<PathBuf> = std::fs::read_dir(&out_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "mxl"))
        .collect();
    musicxml.sort();
    Ok(OmrOutput { boxes, musicxml })
}

enum LogEvent {
    /// `... Book 560  | 16 sheets in /path/score.pdf`
    SheetCount(u32),
    /// `... SheetStub 1278 | Loaded image #3 2550x3299 from ...`
    LoadedSheet(u32),
}

fn parse_log_line(line: &str) -> Option<LogEvent> {
    let msg = line.split_once("| ").map(|(_, m)| m)?;
    if let Some(rest) = msg.strip_prefix("Loaded image #") {
        let n = rest.split_whitespace().next()?.parse().ok()?;
        return Some(LogEvent::LoadedSheet(n));
    }
    let (count, rest) = msg.split_once(' ')?;
    if rest.starts_with("sheets in ") || rest.starts_with("sheet in ") {
        return Some(LogEvent::SheetCount(count.parse().ok()?));
    }
    None
}

/// Reads the measure boxes out of an Audiveris `.omr` project (a zip), in
/// reading order: page by page, system by system, left to right.
pub fn parse_book<R: Read + std::io::Seek>(omr: R) -> Result<Vec<MeasureBox>, OmrError> {
    let mut zip = zip::ZipArchive::new(omr)?;

    let sheet_to_page = match read_entry(&mut zip, "book.xml")? {
        Some(xml) => parse_sheet_pages(&xml)?,
        None => HashMap::new(),
    };

    let mut sheets: Vec<(u32, String)> = zip
        .file_names()
        .filter_map(|name| {
            let name = name.ok()?;
            let (dir, file) = name.split_once('/')?;
            let n: u32 = dir.strip_prefix("sheet#")?.parse().ok()?;
            (file == format!("sheet#{n}.xml")).then(|| (n, name.to_string()))
        })
        .collect();
    sheets.sort();

    let mut boxes = Vec::new();
    for (sheet, name) in sheets {
        let Some(xml) = read_entry(&mut zip, &name)? else {
            continue;
        };
        // book.xml's input image number is the 1-based PDF page; sheets
        // normally match it 1:1, so fall back to the sheet number.
        let page = sheet_to_page
            .get(&sheet)
            .copied()
            .unwrap_or(sheet)
            .saturating_sub(1);
        boxes.extend(parse_sheet(&xml, page)?);
    }
    Ok(boxes)
}

fn read_entry<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, OmrError> {
    let mut file = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn attr_f64(e: &BytesStart, name: &str) -> Option<f64> {
    e.try_get_attribute(name)
        .ok()??
        .unescape_value()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// `book.xml`: `<sheet number="N"><input><number>K</number>` → `N -> K`.
fn parse_sheet_pages(xml: &[u8]) -> Result<HashMap<u32, u32>, OmrError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut map = HashMap::new();
    let mut sheet: Option<u32> = None;
    let mut in_input = false;
    let mut in_number = false;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match e.name().as_ref() {
                b"sheet" => sheet = attr_f64(&e, "number").map(|n| n as u32),
                b"input" => in_input = true,
                b"number" if in_input => in_number = true,
                _ => {}
            },
            Event::Text(t) if in_number => {
                if let (Some(s), Ok(n)) = (sheet, t.unescape()?.trim().parse::<u32>()) {
                    map.insert(s, n);
                }
            }
            Event::End(e) => match e.name().as_ref() {
                b"sheet" => sheet = None,
                b"input" => in_input = false,
                b"number" => in_number = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(map)
}

/// One `sheet#N.xml`: `<picture width height>`, then per `<system>` its
/// `<stack left right>` columns (sheet pixels) and its staff lines'
/// `<point y>`s, which give the system's vertical extent.
fn parse_sheet(xml: &[u8], page: u32) -> Result<Vec<MeasureBox>, OmrError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let (mut width, mut height) = (0.0, 0.0);
    let mut boxes = Vec::new();

    let mut in_system = false;
    let mut stacks: Vec<(f64, f64)> = Vec::new();
    let (mut top, mut bottom) = (f64::INFINITY, f64::NEG_INFINITY);
    // Depth inside <staff><lines><line>, so only staff-line points count.
    let (mut in_staff, mut in_lines, mut in_line) = (false, false, false);

    let mut buf = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buf)?;
        let (start, is_empty) = match &event {
            Event::Start(e) => (Some(e.clone()), false),
            Event::Empty(e) => (Some(e.clone()), true),
            _ => (None, false),
        };
        if let Some(e) = start {
            match e.name().as_ref() {
                b"picture" => {
                    width = attr_f64(&e, "width").unwrap_or(0.0);
                    height = attr_f64(&e, "height").unwrap_or(0.0);
                }
                b"system" if !is_empty => {
                    in_system = true;
                    stacks.clear();
                    (top, bottom) = (f64::INFINITY, f64::NEG_INFINITY);
                }
                b"stack" if in_system => {
                    if let (Some(l), Some(r)) = (attr_f64(&e, "left"), attr_f64(&e, "right")) {
                        stacks.push((l, r));
                    }
                }
                b"staff" if in_system && !is_empty => in_staff = true,
                b"lines" if in_staff && !is_empty => in_lines = true,
                b"line" if in_lines && !is_empty => in_line = true,
                b"point" if in_line => {
                    if let Some(y) = attr_f64(&e, "y") {
                        top = top.min(y);
                        bottom = bottom.max(y);
                    }
                }
                _ => {}
            }
        }
        match &event {
            Event::End(e) => match e.name().as_ref() {
                b"system" => {
                    in_system = false;
                    if width > 0.0 && height > 0.0 && top.is_finite() {
                        boxes.extend(stacks.iter().map(|&(l, r)| MeasureBox {
                            page,
                            x0: l / width,
                            x1: r / width,
                            y0: top / height,
                            y1: bottom / height,
                        }));
                    }
                }
                b"staff" => in_staff = false,
                b"lines" => in_lines = false,
                b"line" => in_line = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(boxes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// `(stacks as (left, right), (top staff-line y, bottom staff-line y))` per system.
    type TestSystem<'a> = (&'a [(u32, u32)], (u32, u32));

    fn sheet_xml(systems: &[TestSystem]) -> String {
        let mut s = String::from(
            r#"<?xml version="1.0" ?><sheet><picture width="2000" height="3000"><images/></picture><page id="1">"#,
        );
        for (stacks, (top, bottom)) in systems {
            s.push_str("<system id=\"1\">");
            for (l, r) in stacks.iter() {
                s.push_str(&format!(
                    r#"<stack id="0" left="{l}" right="{r}"><slot id="1" x-offset="3"/></stack>"#
                ));
            }
            // Two staves; a ledger-like <point> outside <lines> must be ignored.
            s.push_str(&format!(
                r#"<part id="1"><staff id="1" left="0" right="2000"><lines><line><point x="0" y="{top}"/><point x="2000" y="{top}"/></line></lines></staff>
                <staff id="2"><lines><line><point x="0" y="{bottom}"/></line></lines><other><point x="5" y="9999"/></other></staff></part>"#
            ));
            s.push_str("</system>");
        }
        s.push_str("</page></sheet>");
        s
    }

    fn omr_zip(book: Option<&str>, sheets: &[(u32, String)]) -> Cursor<Vec<u8>> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        if let Some(book) = book {
            zip.start_file("book.xml", opts).unwrap();
            zip.write_all(book.as_bytes()).unwrap();
        }
        for (n, xml) in sheets {
            zip.start_file(format!("sheet#{n}/BINARY.png"), opts)
                .unwrap();
            zip.start_file(format!("sheet#{n}/sheet#{n}.xml"), opts)
                .unwrap();
            zip.write_all(xml.as_bytes()).unwrap();
        }
        let mut cursor = zip.finish().unwrap();
        cursor.set_position(0);
        cursor
    }

    #[test]
    fn boxes_in_reading_order_as_page_fractions() {
        let s1 = sheet_xml(&[
            (&[(200, 1000), (1000, 1800)], (300, 600)),
            (&[(100, 1900)], (900, 1200)),
        ]);
        let s2 = sheet_xml(&[(&[(100, 500)], (300, 600))]);
        // Sheets listed out of order in the zip: sorted numerically (2 < 10).
        let boxes = parse_book(omr_zip(None, &[(10, s2.clone()), (2, s1)])).unwrap();
        assert_eq!(boxes.len(), 4);
        assert_eq!(
            boxes[0],
            MeasureBox {
                page: 1,
                x0: 0.1,
                x1: 0.5,
                y0: 0.1,
                y1: 0.2
            }
        );
        assert_eq!(boxes[1].x0, 0.5);
        assert_eq!((boxes[2].page, boxes[2].y0, boxes[2].y1), (1, 0.3, 0.4));
        assert_eq!(boxes[3].page, 9);
    }

    #[test]
    fn book_xml_maps_sheets_to_pdf_pages() {
        let book = r#"<book><sheet number="1"><input><path>x.pdf</path><number>3</number></input>
            <page id="1"><system><part logical-id="1"/></system></page></sheet><score/></book>"#;
        let boxes = parse_book(omr_zip(
            Some(book),
            &[(1, sheet_xml(&[(&[(0, 100)], (10, 20))]))],
        ))
        .unwrap();
        assert_eq!(boxes[0].page, 2);
    }

    #[test]
    fn system_without_staff_lines_is_skipped() {
        let xml = r#"<sheet><picture width="10" height="10"/><page><system><stack left="1" right="2"/></system></page></sheet>"#;
        assert!(parse_book(omr_zip(None, &[(1, xml.to_string())]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn log_lines() {
        let count = "INFO  [clair]                      Book 560  | 16 sheets in /tmp/score.pdf";
        assert!(matches!(
            parse_log_line(count),
            Some(LogEvent::SheetCount(16))
        ));
        let one = "INFO  [x]                      Book 560  | 1 sheet in /tmp/score.pdf";
        assert!(matches!(parse_log_line(one), Some(LogEvent::SheetCount(1))));
        let loaded = "INFO  [clair#3]                 SheetStub 1278 | Loaded image #3 2550x3299 from /tmp/score.pdf";
        assert!(matches!(
            parse_log_line(loaded),
            Some(LogEvent::LoadedSheet(3))
        ));
        assert!(parse_log_line("INFO  [clair#1]  StepMonitoring 98   | LOAD").is_none());
    }

    #[test]
    fn locate_prefers_env_then_deb_then_path() {
        let dir = tempfile::tempdir().unwrap();
        let env_exe = dir.path().join("custom");
        let deb = dir.path().join("deb-Audiveris");
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let on_path = bin.join("audiveris");
        for p in [&env_exe, &deb, &on_path] {
            std::fs::write(p, "").unwrap();
        }
        let path_var = std::env::join_paths([&bin]).unwrap();
        assert_eq!(
            locate_in(Some(env_exe.clone()), &path_var, &deb),
            Some(env_exe)
        );
        assert_eq!(
            locate_in(Some(dir.path().join("missing")), &path_var, &deb),
            Some(deb.clone())
        );
        assert_eq!(
            locate_in(None, &path_var, &dir.path().join("nope")),
            Some(on_path)
        );
        assert_eq!(
            locate_in(None, &OsString::new(), &dir.path().join("nope")),
            None
        );
    }

    /// Real Audiveris output: `LYRICA_OMR_SAMPLE=/path/to/book.omr cargo test -p mp-core omr -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_omr_sample() {
        let path = std::env::var("LYRICA_OMR_SAMPLE").expect("set LYRICA_OMR_SAMPLE");
        let boxes = parse_book(std::fs::File::open(path).unwrap()).unwrap();
        let pages = boxes.iter().map(|b| b.page).max().map_or(0, |p| p + 1);
        println!(
            "{} boxes over {pages} pages; first: {:?}",
            boxes.len(),
            boxes.first()
        );
        assert!(boxes
            .iter()
            .all(|b| (0.0..=1.0).contains(&b.x0) && b.x0 < b.x1 && b.y0 <= b.y1));
    }
}
