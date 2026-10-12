//! Markers: user-attached notes anchored to a measure, persisted per-score
//! via `sidecar`. Resolved via `measure_index` (the flattened timeline's
//! logical measure number — see `timeline::TimelineEvent`), not raw pixel
//! position, so a marker stays correctly anchored even if layout output
//! shifts slightly between webmscore versions.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::sidecar::{self, SidecarError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marker {
    pub id: String,
    pub measure_index: u32,
    pub text: String,
    /// Unix timestamp (seconds) of creation.
    pub created_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MarkersMeta {
    #[serde(default)]
    markers: Vec<Marker>,
}

pub fn list_markers(base_dir: &Path, file_hash: &str) -> Result<Vec<Marker>, SidecarError> {
    let meta: MarkersMeta = sidecar::load_meta(base_dir, file_hash)?;
    Ok(meta.markers)
}

/// Adds a new marker, assigning it an id (blake3 hash of hash+measure+time,
/// short enough to be a stable per-score-unique key without a counter file)
/// and the current time as `created_at`. Returns the full updated list.
pub fn add_marker(
    base_dir: &Path,
    file_hash: &str,
    measure_index: u32,
    text: String,
) -> Result<Vec<Marker>, SidecarError> {
    let mut meta: MarkersMeta = sidecar::load_meta(base_dir, file_hash)?;
    let created_at = now_unix();
    let id = blake3::hash(format!("{file_hash}-{measure_index}-{created_at}-{}", meta.markers.len()).as_bytes())
        .to_hex()[..16]
        .to_string();
    meta.markers.push(Marker {
        id,
        measure_index,
        text,
        created_at,
    });
    sidecar::save_meta(base_dir, file_hash, &meta)?;
    Ok(meta.markers)
}

pub fn delete_marker(base_dir: &Path, file_hash: &str, marker_id: &str) -> Result<Vec<Marker>, SidecarError> {
    let mut meta: MarkersMeta = sidecar::load_meta(base_dir, file_hash)?;
    meta.markers.retain(|m| m.id != marker_id);
    sidecar::save_meta(base_dir, file_hash, &meta)?;
    Ok(meta.markers)
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

    #[test]
    fn add_list_and_delete_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "testhash";

        assert_eq!(list_markers(tmp.path(), hash).unwrap().len(), 0);

        let markers = add_marker(tmp.path(), hash, 4, "tricky fingering".to_string()).unwrap();
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].measure_index, 4);
        assert_eq!(markers[0].text, "tricky fingering");

        let markers = add_marker(tmp.path(), hash, 10, "slow down here".to_string()).unwrap();
        assert_eq!(markers.len(), 2);

        let loaded = list_markers(tmp.path(), hash).unwrap();
        assert_eq!(loaded.len(), 2);

        let id_to_delete = loaded[0].id.clone();
        let remaining = delete_marker(tmp.path(), hash, &id_to_delete).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_ne!(remaining[0].id, id_to_delete);
    }

    #[test]
    fn markers_persist_across_separate_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "persisthash";

        add_marker(tmp.path(), hash, 1, "marker A".to_string()).unwrap();
        add_marker(tmp.path(), hash, 2, "marker B".to_string()).unwrap();

        // Simulate reopening the app: load fresh from disk, nothing in memory.
        let reloaded = list_markers(tmp.path(), hash).unwrap();
        assert_eq!(reloaded.len(), 2);
        assert_eq!(reloaded[0].text, "marker A");
        assert_eq!(reloaded[1].text, "marker B");
    }
}
