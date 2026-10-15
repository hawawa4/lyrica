//! Content-hash-keyed persistence for per-score data (markers, pieces index,
//! upgrade cache, ...). Keyed by the opened file's blake3 content hash
//! (`api::open_file`'s `file_hash`) rather than a sidecar file dropped next
//! to the `.mscz` — a next-to-file sidecar breaks the moment the file
//! moves/renames/lives in a synced folder, while content-hashing survives
//! all of that and is the same key scheme a future server-mode library
//! feature will want anyway (stable piece ID across devices).
//!
//! No `tauri::`/`axum::` imports here (per the workspace layout) — callers
//! pass in the base directory (e.g. Tauri's `app_data_dir()`) explicitly.

use std::io;
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// `{base_dir}/scores/{file_hash}/meta.json`'s path, creating the score's
/// directory (but not the file itself) if it doesn't exist yet.
fn meta_path(base_dir: &Path, file_hash: &str) -> io::Result<PathBuf> {
    item_path(base_dir, "scores", file_hash, "meta.json")
}

/// Generalized form of `meta_path`: `{base_dir}/{kind}/{item_hash}/{filename}`,
/// creating the item's directory (but not the file itself) if needed. `kind`
/// is the top-level grouping (`"scores"` for `.mscz` sidecars, `"pdfs"` for
/// PDF-mode calibration data — see `pdf_calibration`), so different kinds of
/// content-hash-keyed data never collide even if a `.mscz` and a PDF happened
/// to share a hash (astronomically unlikely, but keeps the two namespaces
/// conceptually and physically separate regardless).
fn item_path(base_dir: &Path, kind: &str, item_hash: &str, filename: &str) -> io::Result<PathBuf> {
    let dir = base_dir.join(kind).join(item_hash);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(filename))
}

/// Reads and deserializes `meta.json` for the given score, returning `T`'s
/// `Default` if no sidecar exists yet (a brand-new file has nothing to load).
pub fn load_meta<T: DeserializeOwned + Default>(
    base_dir: &Path,
    file_hash: &str,
) -> Result<T, SidecarError> {
    let path = meta_path(base_dir, file_hash)?;
    load_json(&path)
}

/// Serializes and writes `meta.json` for the given score, overwriting
/// whatever was there before.
pub fn save_meta<T: Serialize>(
    base_dir: &Path,
    file_hash: &str,
    value: &T,
) -> Result<(), SidecarError> {
    let path = meta_path(base_dir, file_hash)?;
    save_json(&path, value)
}

/// Same as `load_meta`/`save_meta` but at `{base_dir}/{kind}/{item_hash}/{filename}`
/// instead of the hardcoded `scores/{hash}/meta.json` — see `item_path`.
pub fn load_item<T: DeserializeOwned + Default>(
    base_dir: &Path,
    kind: &str,
    item_hash: &str,
    filename: &str,
) -> Result<T, SidecarError> {
    let path = item_path(base_dir, kind, item_hash, filename)?;
    load_json(&path)
}

pub fn save_item<T: Serialize>(
    base_dir: &Path,
    kind: &str,
    item_hash: &str,
    filename: &str,
    value: &T,
) -> Result<(), SidecarError> {
    let path = item_path(base_dir, kind, item_hash, filename)?;
    save_json(&path, value)
}

/// Reads and deserializes `path`, returning `T`'s `Default` if it doesn't
/// exist yet. `pub(crate)` so other flat-JSON-backed modules in this crate
/// (`library`, `recent_files`) can reuse this instead of re-implementing the
/// same "load or default" logic — `load_meta`/`load_item` above are just this
/// plus a fixed path shape.
pub(crate) fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, SidecarError> {
    if !path.exists() {
        return Ok(T::default());
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents)?)
}

pub(crate) fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), SidecarError> {
    let contents = serde_json::to_string_pretty(value)?;
    std::fs::write(path, contents)?;
    Ok(())
}

/// `{base_dir}/{filename}` for a flat (non-hash-keyed) JSON file, creating
/// `base_dir` if needed — the shape `library.rs`/`recent_files.rs` both want
/// for app-wide (not per-score) settings/lists.
pub(crate) fn flat_json_path(base_dir: &Path, filename: &str) -> io::Result<PathBuf> {
    std::fs::create_dir_all(base_dir)?;
    Ok(base_dir.join(filename))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
    struct TestMeta {
        count: u32,
    }

    #[test]
    fn round_trips_through_save_and_load() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "abc123";

        let loaded: TestMeta = load_meta(tmp.path(), hash).unwrap();
        assert_eq!(loaded, TestMeta::default());

        save_meta(tmp.path(), hash, &TestMeta { count: 7 }).unwrap();
        let loaded: TestMeta = load_meta(tmp.path(), hash).unwrap();
        assert_eq!(loaded, TestMeta { count: 7 });
    }

    #[test]
    fn different_hashes_are_isolated() {
        let tmp = tempfile::tempdir().unwrap();
        save_meta(tmp.path(), "hash-a", &TestMeta { count: 1 }).unwrap();
        save_meta(tmp.path(), "hash-b", &TestMeta { count: 2 }).unwrap();

        let a: TestMeta = load_meta(tmp.path(), "hash-a").unwrap();
        let b: TestMeta = load_meta(tmp.path(), "hash-b").unwrap();
        assert_eq!(a, TestMeta { count: 1 });
        assert_eq!(b, TestMeta { count: 2 });
    }
}
