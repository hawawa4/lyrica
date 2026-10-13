//! Recently-opened files, for the "reopen a past file" list shown when no
//! tabs are open. Unlike `sidecar` (per-score data keyed by content hash,
//! one directory per score), this is a single flat list at a fixed path —
//! there's only ever one recent-files list per app-data directory.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RecentFilesError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentFile {
    pub path: String,
    pub file_hash: String,
    /// Unix timestamp (seconds) this file was last opened.
    pub last_opened: i64,
    pub title: String,
}

const MAX_ENTRIES: usize = 20;

fn list_path(base_dir: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(base_dir)?;
    Ok(base_dir.join("recent_files.json"))
}

fn load_list(base_dir: &Path) -> Result<Vec<RecentFile>, RecentFilesError> {
    let path = list_path(base_dir)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents)?)
}

fn save_list(base_dir: &Path, entries: &[RecentFile]) -> Result<(), RecentFilesError> {
    let path = list_path(base_dir)?;
    let contents = serde_json::to_string_pretty(entries)?;
    std::fs::write(path, contents)?;
    Ok(())
}

pub fn list_recent_files(base_dir: &Path) -> Result<Vec<RecentFile>, RecentFilesError> {
    load_list(base_dir)
}

/// Records a file as just-opened: removes any existing entry for the same
/// `file_hash` (so reopening a file moves it to the front rather than
/// duplicating it), prepends the new entry, and truncates to `MAX_ENTRIES`.
/// Returns the updated list.
pub fn record_opened(
    base_dir: &Path,
    path: String,
    file_hash: String,
    title: String,
) -> Result<Vec<RecentFile>, RecentFilesError> {
    let mut entries = load_list(base_dir)?;
    entries.retain(|e| e.file_hash != file_hash);
    entries.insert(
        0,
        RecentFile {
            path,
            file_hash,
            last_opened: now_unix(),
            title,
        },
    );
    entries.truncate(MAX_ENTRIES);
    save_list(base_dir, &entries)?;
    Ok(entries)
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
    fn records_and_lists_in_most_recent_first_order() {
        let tmp = tempfile::tempdir().unwrap();

        assert_eq!(list_recent_files(tmp.path()).unwrap().len(), 0);

        record_opened(
            tmp.path(),
            "/a.mscz".to_string(),
            "hash-a".to_string(),
            "A".to_string(),
        )
        .unwrap();
        record_opened(
            tmp.path(),
            "/b.mscz".to_string(),
            "hash-b".to_string(),
            "B".to_string(),
        )
        .unwrap();

        let list = list_recent_files(tmp.path()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].file_hash, "hash-b");
        assert_eq!(list[1].file_hash, "hash-a");
    }

    #[test]
    fn reopening_a_file_moves_it_to_front_without_duplicating() {
        let tmp = tempfile::tempdir().unwrap();

        record_opened(
            tmp.path(),
            "/a.mscz".to_string(),
            "hash-a".to_string(),
            "A".to_string(),
        )
        .unwrap();
        record_opened(
            tmp.path(),
            "/b.mscz".to_string(),
            "hash-b".to_string(),
            "B".to_string(),
        )
        .unwrap();
        record_opened(
            tmp.path(),
            "/a.mscz".to_string(),
            "hash-a".to_string(),
            "A".to_string(),
        )
        .unwrap();

        let list = list_recent_files(tmp.path()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].file_hash, "hash-a");
        assert_eq!(list[1].file_hash, "hash-b");
    }

    #[test]
    fn caps_at_max_entries() {
        let tmp = tempfile::tempdir().unwrap();

        for i in 0..25 {
            record_opened(
                tmp.path(),
                format!("/{i}.mscz"),
                format!("hash-{i}"),
                format!("Title {i}"),
            )
            .unwrap();
        }

        let list = list_recent_files(tmp.path()).unwrap();
        assert_eq!(list.len(), MAX_ENTRIES);
        // Most recent (hash-24) first, oldest kept entry is hash-5.
        assert_eq!(list[0].file_hash, "hash-24");
        assert_eq!(list[list.len() - 1].file_hash, "hash-5");
    }

    #[test]
    fn persists_across_separate_loads() {
        let tmp = tempfile::tempdir().unwrap();

        record_opened(
            tmp.path(),
            "/a.mscz".to_string(),
            "hash-a".to_string(),
            "A".to_string(),
        )
        .unwrap();

        let reloaded = list_recent_files(tmp.path()).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].title, "A");
    }
}
