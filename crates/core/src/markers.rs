//! Markers: user annotations written directly onto the sheet, persisted
//! per-score via `sidecar`. Two kinds:
//! - `Text`: a free-form note, shown above the measure it was placed on.
//! - `Fingering`: digits 1-5, drawn stacked vertically (a chord's fingering,
//!   e.g. "124") at exactly the spot it was placed.
//!
//! Positioned by `MarkerPosition` — a page index plus x/y as a 0-1 fraction
//! of that page's own width/height, the same zoom-independent scheme PDF
//! calibration points use, so one representation covers both `.mscz` and
//! PDF tabs. Markers created before positions existed carry only
//! `measure_index` (the flattened timeline's logical measure number); the
//! frontend resolves those to a spot above that measure at display time.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::sidecar::{self, SidecarError};

#[derive(Debug, Error)]
pub enum MarkerError {
    #[error(transparent)]
    Sidecar(#[from] SidecarError),
    #[error("a fingering marker needs at least one finger number (1-5)")]
    EmptyFingering,
    #[error("a text marker can't be empty")]
    EmptyText,
    #[error("no marker with id {0}")]
    NotFound(String),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkerKind {
    #[default]
    Text,
    Fingering,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MarkerPosition {
    /// 0-based page index.
    pub page: u32,
    /// 0-1 fraction of the page's width.
    pub x: f64,
    /// 0-1 fraction of the page's height.
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marker {
    pub id: String,
    #[serde(default)]
    pub kind: MarkerKind,
    /// Legacy anchor (markers created before `position` existed). `None` for
    /// every marker placed on the sheet directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measure_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<MarkerPosition>,
    pub text: String,
    /// Unix timestamp (seconds) of creation.
    pub created_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MarkersMeta {
    #[serde(default)]
    markers: Vec<Marker>,
}

pub fn list_markers(base_dir: &Path, file_hash: &str) -> Result<Vec<Marker>, MarkerError> {
    let meta: MarkersMeta = sidecar::load_meta(base_dir, file_hash)?;
    Ok(meta.markers)
}

/// Adds a new marker, assigning it an id (blake3 hash of hash+position+time,
/// short enough to be a stable per-score-unique key without a counter file)
/// and the current time as `created_at`. Returns the full updated list.
pub fn add_marker(
    base_dir: &Path,
    file_hash: &str,
    kind: MarkerKind,
    position: MarkerPosition,
    text: String,
) -> Result<Vec<Marker>, MarkerError> {
    let text = normalize_text(kind, &text)?;
    let mut meta: MarkersMeta = sidecar::load_meta(base_dir, file_hash)?;
    let created_at = now_unix();
    let id = blake3::hash(
        format!(
            "{file_hash}-{}-{}-{}-{created_at}-{}",
            position.page,
            position.x,
            position.y,
            meta.markers.len()
        )
        .as_bytes(),
    )
    .to_hex()[..16]
        .to_string();
    meta.markers.push(Marker {
        id,
        kind,
        measure_index: None,
        position: Some(position),
        text,
        created_at,
    });
    sidecar::save_meta(base_dir, file_hash, &meta)?;
    Ok(meta.markers)
}

/// Replaces a marker's text and, if given, its position (a drag-move). Once
/// a legacy measure-anchored marker gets a position it's no longer legacy.
pub fn update_marker(
    base_dir: &Path,
    file_hash: &str,
    marker_id: &str,
    text: String,
    position: Option<MarkerPosition>,
) -> Result<Vec<Marker>, MarkerError> {
    let mut meta: MarkersMeta = sidecar::load_meta(base_dir, file_hash)?;
    let marker = meta
        .markers
        .iter_mut()
        .find(|m| m.id == marker_id)
        .ok_or_else(|| MarkerError::NotFound(marker_id.to_string()))?;
    marker.text = normalize_text(marker.kind, &text)?;
    if let Some(position) = position {
        marker.position = Some(position);
        marker.measure_index = None;
    }
    sidecar::save_meta(base_dir, file_hash, &meta)?;
    Ok(meta.markers)
}

pub fn delete_marker(
    base_dir: &Path,
    file_hash: &str,
    marker_id: &str,
) -> Result<Vec<Marker>, MarkerError> {
    let mut meta: MarkersMeta = sidecar::load_meta(base_dir, file_hash)?;
    meta.markers.retain(|m| m.id != marker_id);
    sidecar::save_meta(base_dir, file_hash, &meta)?;
    Ok(meta.markers)
}

/// Text markers are trimmed; fingering markers keep only the digits 1-5
/// (in typed order — each one is a finger, stacked top to bottom).
fn normalize_text(kind: MarkerKind, text: &str) -> Result<String, MarkerError> {
    match kind {
        MarkerKind::Text => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Err(MarkerError::EmptyText);
            }
            Ok(trimmed.to_string())
        }
        MarkerKind::Fingering => {
            let digits: String = text.chars().filter(|c| ('1'..='5').contains(c)).collect();
            if digits.is_empty() {
                return Err(MarkerError::EmptyFingering);
            }
            Ok(digits)
        }
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(page: u32, x: f64, y: f64) -> MarkerPosition {
        MarkerPosition { page, x, y }
    }

    #[test]
    fn add_list_and_delete_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "testhash";

        assert_eq!(list_markers(tmp.path(), hash).unwrap().len(), 0);

        let markers = add_marker(
            tmp.path(),
            hash,
            MarkerKind::Text,
            pos(0, 0.2, 0.3),
            "  slow down here ".to_string(),
        )
        .unwrap();
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].kind, MarkerKind::Text);
        assert_eq!(markers[0].text, "slow down here");
        assert_eq!(markers[0].position, Some(pos(0, 0.2, 0.3)));

        let markers = add_marker(
            tmp.path(),
            hash,
            MarkerKind::Fingering,
            pos(1, 0.5, 0.5),
            "124".to_string(),
        )
        .unwrap();
        assert_eq!(markers.len(), 2);

        let loaded = list_markers(tmp.path(), hash).unwrap();
        assert_eq!(loaded.len(), 2);

        let id_to_delete = loaded[0].id.clone();
        let remaining = delete_marker(tmp.path(), hash, &id_to_delete).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_ne!(remaining[0].id, id_to_delete);
    }

    #[test]
    fn fingering_keeps_only_digits_one_to_five() {
        let tmp = tempfile::tempdir().unwrap();
        let markers = add_marker(
            tmp.path(),
            "h",
            MarkerKind::Fingering,
            pos(0, 0.1, 0.1),
            "1 2-6 4x0".to_string(),
        )
        .unwrap();
        assert_eq!(markers[0].text, "124");

        let err = add_marker(
            tmp.path(),
            "h",
            MarkerKind::Fingering,
            pos(0, 0.1, 0.1),
            "6789".to_string(),
        )
        .unwrap_err();
        assert!(matches!(err, MarkerError::EmptyFingering));
    }

    #[test]
    fn update_changes_text_and_position() {
        let tmp = tempfile::tempdir().unwrap();
        let markers = add_marker(
            tmp.path(),
            "h",
            MarkerKind::Text,
            pos(0, 0.1, 0.1),
            "a".to_string(),
        )
        .unwrap();
        let id = markers[0].id.clone();

        let markers = update_marker(tmp.path(), "h", &id, "b".to_string(), None).unwrap();
        assert_eq!(markers[0].text, "b");
        assert_eq!(markers[0].position, Some(pos(0, 0.1, 0.1)));

        let markers = update_marker(
            tmp.path(),
            "h",
            &id,
            "b".to_string(),
            Some(pos(2, 0.4, 0.6)),
        )
        .unwrap();
        assert_eq!(markers[0].position, Some(pos(2, 0.4, 0.6)));

        let err = update_marker(tmp.path(), "h", "nope", "c".to_string(), None).unwrap_err();
        assert!(matches!(err, MarkerError::NotFound(_)));
    }

    #[test]
    fn legacy_measure_only_markers_still_load() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "legacy";
        let legacy =
            r#"{"markers":[{"id":"abc","measure_index":4,"text":"tricky","created_at":1}]}"#;
        sidecar::save_meta(
            tmp.path(),
            hash,
            &serde_json::from_str::<serde_json::Value>(legacy).unwrap(),
        )
        .unwrap();

        let markers = list_markers(tmp.path(), hash).unwrap();
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].kind, MarkerKind::Text);
        assert_eq!(markers[0].measure_index, Some(4));
        assert_eq!(markers[0].position, None);

        // Moving it onto the sheet drops the legacy anchor.
        let markers = update_marker(
            tmp.path(),
            hash,
            "abc",
            "tricky".to_string(),
            Some(pos(0, 0.5, 0.5)),
        )
        .unwrap();
        assert_eq!(markers[0].measure_index, None);
    }

    #[test]
    fn markers_persist_across_separate_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "persisthash";

        add_marker(
            tmp.path(),
            hash,
            MarkerKind::Text,
            pos(0, 0.1, 0.1),
            "marker A".to_string(),
        )
        .unwrap();
        add_marker(
            tmp.path(),
            hash,
            MarkerKind::Text,
            pos(0, 0.2, 0.2),
            "marker B".to_string(),
        )
        .unwrap();

        // Simulate reopening the app: load fresh from disk, nothing in memory.
        let reloaded = list_markers(tmp.path(), hash).unwrap();
        assert_eq!(reloaded.len(), 2);
        assert_eq!(reloaded[0].text, "marker A");
        assert_eq!(reloaded[1].text, "marker B");
    }
}
