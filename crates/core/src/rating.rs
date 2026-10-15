//! Per-piece "knowledge level" (1-5: never seen it before, through mastered —
//! can play it at any time), so the library view can show and filter by how
//! well-practiced each piece is. Persisted per-score via `sidecar`'s generic
//! content-hash-keyed item storage, same scheme `pdf_calibration` uses, in
//! its own `"ratings"` kind namespace rather than sharing `markers`' existing
//! `scores/{hash}/meta.json` — a second module calling `sidecar::save_meta`
//! on that same path would silently overwrite the other's data, since
//! `save_meta` always replaces the whole file rather than merging fields.
//!
//! Applies uniformly to both `.mscz` and PDF-mode files (both already share
//! the same blake3-of-bytes hashing scheme — see `api::hash_bytes`'s docs),
//! since "how well I know this piece" isn't specific to either mode.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::sidecar::{self, SidecarError};

const KIND: &str = "ratings";
const FILENAME: &str = "rating.json";

/// 1 = never seen it before, 5 = mastered, can play it at any time.
pub type KnowledgeLevel = u8;

#[derive(Debug, Default, Serialize, Deserialize)]
struct RatingMeta {
    level: Option<KnowledgeLevel>,
}

/// `None` means unrated — a freshly-opened piece, or one that was rated then
/// explicitly cleared (see `set_knowledge_level`'s `None` case).
pub fn get_knowledge_level(base_dir: &Path, file_hash: &str) -> Result<Option<KnowledgeLevel>, SidecarError> {
    let meta: RatingMeta = sidecar::load_item(base_dir, KIND, file_hash, FILENAME)?;
    Ok(meta.level)
}

/// `level` of `None` clears the rating back to unrated; `Some(n)` is clamped
/// into 1..=5 so a malformed/future caller can't persist an out-of-range
/// value that the UI's 5-star control could never have produced itself.
pub fn set_knowledge_level(
    base_dir: &Path,
    file_hash: &str,
    level: Option<KnowledgeLevel>,
) -> Result<Option<KnowledgeLevel>, SidecarError> {
    let clamped = level.map(|l| l.clamp(1, 5));
    let meta = RatingMeta { level: clamped };
    sidecar::save_item(base_dir, KIND, file_hash, FILENAME, &meta)?;
    Ok(clamped)
}

/// Bulk lookup for the library view, which needs every pinned/recent file's
/// rating at once rather than one `get_knowledge_level` IPC round-trip per
/// row. Hashes with no rating sidecar yet are simply absent from the
/// returned map (equivalent to unrated) rather than erroring.
pub fn get_knowledge_levels(
    base_dir: &Path,
    file_hashes: &[String],
) -> Result<std::collections::HashMap<String, KnowledgeLevel>, SidecarError> {
    let mut levels = std::collections::HashMap::new();
    for hash in file_hashes {
        if let Some(level) = get_knowledge_level(base_dir, hash)? {
            levels.insert(hash.clone(), level);
        }
    }
    Ok(levels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrated_by_default() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(get_knowledge_level(tmp.path(), "hash-a").unwrap(), None);
    }

    #[test]
    fn set_and_get_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        set_knowledge_level(tmp.path(), "hash-a", Some(3)).unwrap();
        assert_eq!(get_knowledge_level(tmp.path(), "hash-a").unwrap(), Some(3));
    }

    #[test]
    fn clearing_resets_to_unrated() {
        let tmp = tempfile::tempdir().unwrap();
        set_knowledge_level(tmp.path(), "hash-a", Some(5)).unwrap();
        set_knowledge_level(tmp.path(), "hash-a", None).unwrap();
        assert_eq!(get_knowledge_level(tmp.path(), "hash-a").unwrap(), None);
    }

    #[test]
    fn out_of_range_level_is_clamped() {
        let tmp = tempfile::tempdir().unwrap();
        let clamped = set_knowledge_level(tmp.path(), "hash-a", Some(9)).unwrap();
        assert_eq!(clamped, Some(5));
        assert_eq!(get_knowledge_level(tmp.path(), "hash-a").unwrap(), Some(5));
    }

    #[test]
    fn ratings_are_isolated_per_hash_and_from_markers() {
        let tmp = tempfile::tempdir().unwrap();
        set_knowledge_level(tmp.path(), "hash-a", Some(2)).unwrap();
        set_knowledge_level(tmp.path(), "hash-b", Some(4)).unwrap();
        assert_eq!(get_knowledge_level(tmp.path(), "hash-a").unwrap(), Some(2));
        assert_eq!(get_knowledge_level(tmp.path(), "hash-b").unwrap(), Some(4));

        // A marker added for hash-a must not be clobbered by, or clobber, its rating.
        crate::markers::add_marker(tmp.path(), "hash-a", 0, "note".to_string()).unwrap();
        assert_eq!(get_knowledge_level(tmp.path(), "hash-a").unwrap(), Some(2));
        assert_eq!(crate::markers::list_markers(tmp.path(), "hash-a").unwrap().len(), 1);
    }

    #[test]
    fn bulk_lookup_omits_unrated_hashes() {
        let tmp = tempfile::tempdir().unwrap();
        set_knowledge_level(tmp.path(), "hash-a", Some(1)).unwrap();
        let levels = get_knowledge_levels(
            tmp.path(),
            &["hash-a".to_string(), "hash-b".to_string()],
        )
        .unwrap();
        assert_eq!(levels.get("hash-a"), Some(&1));
        assert_eq!(levels.get("hash-b"), None);
    }
}
