//! The single shared request/response shape both shells (desktop/Tauri and
//! server/axum) adapt. Desktop wraps these in `#[tauri::command]`, server
//! wraps them in REST routes — neither shell duplicates business logic.

use std::io::Cursor;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::audio::midi_events::TempoMapEntry;
use crate::markers::{self, Marker};
pub use cv_barline::{CvBarlineError, StaffSystem};
use crate::mscz::{self, MsczError};
use crate::pdf_calibration::{self, CalibrationPoint};
use crate::pieces::{self, Piece, PiecesError};
use crate::recent_files::{self, RecentFile, RecentFilesError};
use crate::sidecar::SidecarError;
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
    let file_hash = hash_bytes(&req.bytes);
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

/// Stable content-hash key (blake3 of the raw bytes) for anything that needs
/// the same hash-keyed-sidecar scheme `open_file` uses for `.mscz` files but
/// isn't itself a `.mscz` — currently just PDF mode's calibration data
/// (`pdf_calibration`), which has no MuseScore-version concept to sniff.
pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Detects piece boundaries within a single `.mscz` file (see `pieces` module
/// docs for why this needs the raw XML rather than webmscore's exposed JS
/// API). Takes the file's own bytes directly — unlike `import_timeline`,
/// this is a pure Rust zip+XML operation with nothing for the JS layer to
/// export first.
#[derive(Debug, Error)]
pub enum DetectPiecesError {
    #[error(transparent)]
    Mscz(#[from] MsczError),
    #[error(transparent)]
    Pieces(#[from] PiecesError),
}

pub fn detect_pieces(bytes: &[u8]) -> Result<Vec<Piece>, DetectPiecesError> {
    let contents = mscz::read_rootfile_contents(Cursor::new(bytes))?;
    Ok(pieces::detect_pieces(&contents)?)
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

/// Markers CRUD, all keyed by `file_hash` (from `open_file`'s response) and
/// persisted under `base_dir` (the shell's app-data directory — desktop
/// resolves this via Tauri's `app_data_dir()`; `mp-core` itself has no
/// knowledge of Tauri, see `sidecar`'s module docs).
pub fn list_markers(base_dir: &Path, file_hash: &str) -> Result<Vec<Marker>, SidecarError> {
    markers::list_markers(base_dir, file_hash)
}

pub fn add_marker(
    base_dir: &Path,
    file_hash: &str,
    measure_index: u32,
    text: String,
) -> Result<Vec<Marker>, SidecarError> {
    markers::add_marker(base_dir, file_hash, measure_index, text)
}

pub fn delete_marker(
    base_dir: &Path,
    file_hash: &str,
    marker_id: &str,
) -> Result<Vec<Marker>, SidecarError> {
    markers::delete_marker(base_dir, file_hash, marker_id)
}

/// Recent-files list (desktop-only — "path" is meaningless for a future
/// web/server shell, where files arrive as uploaded bytes with no on-disk
/// location). Separate from `open_file` itself so that boundary stays
/// shell-agnostic: desktop calls this explicitly once it has the real path.
pub fn list_recent_files(base_dir: &Path) -> Result<Vec<RecentFile>, RecentFilesError> {
    recent_files::list_recent_files(base_dir)
}

pub fn record_recent_file(
    base_dir: &Path,
    path: String,
    file_hash: String,
    title: String,
) -> Result<Vec<RecentFile>, RecentFilesError> {
    recent_files::record_opened(base_dir, path, file_hash, title)
}

/// PDF mode (Phase 9) calibration CRUD, keyed by the PDF's own content hash
/// (same blake3-of-bytes scheme as `.mscz` files, via `open_file`/`mscz`'s
/// hashing — PDFs aren't parsed by `mscz`, but nothing stops reusing the same
/// hash function directly on the raw bytes).
pub fn list_calibration_points(
    base_dir: &Path,
    file_hash: &str,
) -> Result<Vec<CalibrationPoint>, SidecarError> {
    pdf_calibration::list_points(base_dir, file_hash)
}

pub fn save_calibration_points(
    base_dir: &Path,
    file_hash: &str,
    points: Vec<CalibrationPoint>,
) -> Result<Vec<CalibrationPoint>, SidecarError> {
    pdf_calibration::save_points(base_dir, file_hash, points)
}

/// Derives a tempo map from calibration points for metronome-only playback
/// (see `pdf_calibration::tempo_map`'s docs and `Player::load_tempo_map`).
pub fn pdf_tempo_map(points: &[CalibrationPoint], numerator: u8) -> Vec<TempoMapEntry> {
    pdf_calibration::tempo_map(points, numerator)
}

/// Optional CV barline-detection assist for PDF mode (see `cv_barline`'s
/// module docs). Takes a page's rendered bitmap as PNG bytes (handed from
/// the JS canvas, same hand-off pattern as `import_timeline`'s MIDI/positions
/// data) and returns candidate barline x-positions per detected staff system
/// — suggestions only, never auto-applied; the JS calibration UI renders
/// them as adjustable/dismissable markers the user must confirm.
pub fn detect_barlines(png_bytes: &[u8]) -> Result<Vec<StaffSystem>, CvBarlineError> {
    cv_barline::detect_barlines(png_bytes)
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
