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
    let dir = base_dir.join("scores").join(file_hash);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("meta.json"))
}

/// Reads and deserializes `meta.json` for the given score, returning `T`'s
/// `Default` if no sidecar exists yet (a brand-new file has nothing to load).
pub fn load_meta<T: DeserializeOwned + Default>(
    base_dir: &Path,
    file_hash: &str,
) -> Result<T, SidecarError> {
    let path = meta_path(base_dir, file_hash)?;
    if !path.exists() {
        return Ok(T::default());
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents)?)
}

/// Serializes and writes `meta.json` for the given score, overwriting
/// whatever was there before.
pub fn save_meta<T: Serialize>(
    base_dir: &Path,
    file_hash: &str,
    value: &T,
) -> Result<(), SidecarError> {
    let path = meta_path(base_dir, file_hash)?;
    let contents = serde_json::to_string_pretty(value)?;
    std::fs::write(path, contents)?;
    Ok(())
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
