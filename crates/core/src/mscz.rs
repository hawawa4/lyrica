use std::io::{Read, Seek};

use quick_xml::events::Event;
use quick_xml::Reader;
use thiserror::Error;
use zip::ZipArchive;

#[derive(Debug, Error)]
pub enum MsczError {
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("container.xml missing or has no rootfiles")]
    NoRootfile,
    #[error("rootfile entry not found in archive: {0}")]
    RootfileMissing(String),
    #[error("no <museScore version=\"...\"> element found in rootfile")]
    NoVersionAttribute,
}

/// Cheaply read the MuseScore file-format version (e.g. "4.50", "2.00") from an
/// `.mscz` archive, without parsing the whole score XML or invoking any WASM engine.
///
/// Selects the rootfile by `.mscx` extension rather than "first entry in
/// container.xml" — some real-world files list a non-score file (e.g.
/// `score_style.mss`) before the actual `.mscx` rootfile.
pub fn sniff_version<R: Read + Seek>(reader: R) -> Result<String, MsczError> {
    let contents = read_rootfile_contents(reader)?;
    parse_version_attribute(&contents)
}

/// Reads the full contents of an `.mscz` archive's score rootfile (the
/// `.mscx` XML), for callers that need more than `sniff_version`'s cheap
/// version check — e.g. `pieces::detect_pieces`, which scans the same XML
/// for piece-boundary title frames.
pub fn read_rootfile_contents<R: Read + Seek>(reader: R) -> Result<String, MsczError> {
    let mut archive = ZipArchive::new(reader)?;
    let rootfile_path = find_rootfile_path(&mut archive)?;

    let mut rootfile = archive.by_name(&rootfile_path)
        .map_err(|_| MsczError::RootfileMissing(rootfile_path.clone()))?;
    let mut contents = String::new();
    rootfile.read_to_string(&mut contents)?;
    Ok(contents)
}

fn find_rootfile_path<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<String, MsczError> {
    let mut container_xml = String::new();
    archive
        .by_name("META-INF/container.xml")?
        .read_to_string(&mut container_xml)?;

    let mut reader = Reader::from_str(&container_xml);
    reader.config_mut().trim_text(true);

    let mut candidates = Vec::new();
    loop {
        match reader.read_event()? {
            Event::Empty(e) | Event::Start(e) if e.name().as_ref() == b"rootfile" => {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"full-path" {
                        candidates.push(attr.unescape_value()?.into_owned());
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    if candidates.is_empty() {
        return Err(MsczError::NoRootfile);
    }

    // Prefer the entry that actually looks like a score (.mscx), not just the
    // first <rootfile> listed — container.xml ordering is not reliable.
    candidates
        .iter()
        .find(|p| p.ends_with(".mscx"))
        .cloned()
        .or_else(|| candidates.into_iter().next())
        .ok_or(MsczError::NoRootfile)
}

fn parse_version_attribute(mscx_contents: &str) -> Result<String, MsczError> {
    let mut reader = Reader::from_str(mscx_contents);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event()? {
            Event::Start(e) if e.name().as_ref() == b"museScore" => {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"version" {
                        return Ok(attr.unescape_value()?.into_owned());
                    }
                }
                return Err(MsczError::NoVersionAttribute);
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Err(MsczError::NoVersionAttribute)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::Path;

    fn sample_dir() -> &'static Path {
        Path::new("/home/hawa/Documents/Musescore")
    }

    #[test]
    fn sniffs_versions_for_real_library() {
        let expected: &[(&str, &str)] = &[
            ("Dark Side Of Fate.mscz", "4.50"),
            ("Night_Of_Nights_-_COOLCREATEZUN.mscz", "4.00"),
            ("Night_of_NightsFlowering_Nights_Remix.mscz", "2.06"),
            ("Night_Sakura_of_Dead_Spirits.mscz", "2.06"),
            ("The Fantastic Legend of Tohno 『2』.mscz", "1.14"),
            ("Youkai Mountain ~ Mysterious Mountain 『2』.mscz", "2.00"),
        ];

        for (filename, expected_version) in expected {
            let path = sample_dir().join(filename);
            if !path.exists() {
                eprintln!("skipping {filename}: sample file not present in this environment");
                continue;
            }
            let file = File::open(&path).unwrap();
            let version = sniff_version(file).unwrap_or_else(|e| panic!("{filename}: {e}"));
            assert_eq!(&version, expected_version, "wrong version for {filename}");
        }
    }
}
