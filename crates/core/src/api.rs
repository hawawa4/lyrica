//! The single shared request/response shape both shells (desktop/Tauri and
//! server/axum) adapt. Desktop wraps these in `#[tauri::command]`, server
//! wraps them in REST routes — neither shell duplicates business logic.

use std::io::Cursor;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::mscz::{self, MsczError};
use crate::timeline::{self, Positions, Timeline, TimelineError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenFileRequest {
    /// Raw bytes of the dropped/selected .mscz file. The desktop shell reads
    /// these via tauri-plugin-fs from a dropped path; the web/server shell
    /// reads them client-side from a File/DataTransfer object.
    pub bytes: Vec<u8>,
    pub original_filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenFileResponse {
    pub file_hash: String,
    pub mscz_version: String,
    /// `mscz_version`'s major version is below MS4 — the JS layer must
    /// confirm with the user, then call `saveMsc('mscz')`, before using the
    /// score any further.
    pub needs_upgrade: bool,
}

/// MuseScore 4's own file format version, used as the upgrade threshold.
/// Mirrors the check the spike confirmed against `WebMscore.version()`
/// (engine reports "400" there; here we compare against the file's own
/// `<museScore version="...">` string, e.g. "2.00" < "4.00").
const MS4_VERSION_FLOOR: f32 = 4.0;

pub fn open_file(req: OpenFileRequest) -> Result<OpenFileResponse, MsczError> {
    let file_hash = blake3::hash(&req.bytes).to_hex().to_string();
    let mscz_version = mscz::sniff_version(Cursor::new(&req.bytes))?;
    let needs_upgrade = mscz_version
        .parse::<f32>()
        .map(|v| v < MS4_VERSION_FLOOR)
        .unwrap_or(false);

    Ok(OpenFileResponse {
        file_hash,
        mscz_version,
        needs_upgrade,
    })
}

/// Rust never parses `.mscz`/MIDI directly — this receives already-exported
/// data from the JS layer (webmscore's `measurePositions()` JSON and
/// `saveMidi()` bytes) and builds the derived `Timeline`, so it can be
/// persisted without re-deriving it from source on every launch (see
/// IMPLEMENTATION_PLAN.md's "API boundary" section).
#[derive(Debug, Clone, Deserialize)]
pub struct ImportTimelineRequest {
    pub positions: Positions,
    pub midi_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportTimelineResponse {
    pub timeline: Timeline,
}

#[derive(Debug, Error)]
pub enum ImportTimelineError {
    #[error(transparent)]
    Timeline(#[from] TimelineError),
}

pub fn import_timeline(
    req: ImportTimelineRequest,
) -> Result<ImportTimelineResponse, ImportTimelineError> {
    let timeline = timeline::build_timeline(&req.positions, &req.midi_bytes)?;
    Ok(ImportTimelineResponse { timeline })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn open_file_reports_hash_and_upgrade_need() {
        let path = Path::new("/home/hawa/Documents/Musescore/Dark Side Of Fate.mscz");
        if !path.exists() {
            eprintln!("skipping: sample file not present in this environment");
            return;
        }
        let bytes = fs::read(path).unwrap();
        let resp = open_file(OpenFileRequest {
            bytes,
            original_filename: "Dark Side Of Fate.mscz".to_string(),
        })
        .unwrap();

        assert_eq!(resp.mscz_version, "4.50");
        assert!(!resp.needs_upgrade);
        assert_eq!(resp.file_hash.len(), 64); // blake3 hex digest
    }

    #[test]
    fn open_file_flags_old_version_for_upgrade() {
        let path = Path::new(
            "/home/hawa/Documents/Musescore/Youkai Mountain ~ Mysterious Mountain 『2』.mscz",
        );
        if !path.exists() {
            eprintln!("skipping: sample file not present in this environment");
            return;
        }
        let bytes = fs::read(path).unwrap();
        let resp = open_file(OpenFileRequest {
            bytes,
            original_filename: "Youkai Mountain.mscz".to_string(),
        })
        .unwrap();

        assert_eq!(resp.mscz_version, "2.00");
        assert!(resp.needs_upgrade);
    }
}
