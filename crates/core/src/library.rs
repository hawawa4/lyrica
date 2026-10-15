//! Library view: a user-chosen root folder to browse for scores, plus a
//! pinned-files list (like pinned browser tabs — always shown, independent
//! of recency). Both are flat JSON, same persistence shape as
//! `recent_files.rs`, so this slots into a future SQLite-backed index without
//! having invented a different storage pattern first.
//!
//! `scan_library` itself has no indexing/caching — it's a synchronous
//! recursive walk, on-demand, every time it's called. The frontend
//! (`web/src/views/LibraryView.ts`) is responsible for not calling it more
//! than necessary (it caches results keyed by root folder and only rescans
//! when the folder actually changes); this module intentionally stays
//! stateless rather than adding its own cache, since a real SQLite-backed
//! index is the eventual fix and a half-way in-memory cache here would just
//! be thrown away when that lands.

use std::path::Path;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::sidecar::{flat_json_path, load_json, save_json, SidecarError};

/// Reuses `sidecar`'s error type rather than defining another Io/Json enum —
/// this module's persistence (flat JSON files under `base_dir`) is otherwise
/// identical to `sidecar`'s own load/save, just at a fixed, non-hash-keyed
/// path.
pub type LibraryError = SidecarError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LibrarySettings {
    pub root_folder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PinnedFile {
    pub path: String,
    pub file_hash: String,
    pub title: String,
}

/// A file found under the library root folder during a scan. `is_dir` is
/// always `false` for now (the scan is already fully recursive and flattens
/// the tree) — kept on the struct so a future "browse one folder at a time"
/// UI can reuse this same shape without a breaking change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LibraryEntry {
    pub path: String,
    pub title: String,
    pub is_dir: bool,
}

pub fn get_library_settings(base_dir: &Path) -> Result<LibrarySettings, LibraryError> {
    load_json(&flat_json_path(base_dir, "library_settings.json")?)
}

pub fn set_root_folder(
    base_dir: &Path,
    root_folder: Option<String>,
) -> Result<LibrarySettings, LibraryError> {
    let settings = LibrarySettings { root_folder };
    save_json(&flat_json_path(base_dir, "library_settings.json")?, &settings)?;
    Ok(settings)
}

const SCANNED_EXTENSIONS: &[&str] = &["mscz", "mscx", "pdf"];

/// Recursively lists every `.mscz`/`.mscx`/`.pdf` file under `root`, sorted by
/// filename. Hidden entries (dotfiles/dotdirs) are skipped. `WalkDir` is used
/// over a hand-rolled recursive `read_dir` specifically for its built-in
/// symlink-loop protection, since a practice-library folder is plausibly a
/// synced/symlinked directory.
///
/// A subdirectory the walk can't read (permission error, broken symlink,
/// disconnected network mount) is skipped rather than aborting the whole
/// scan — one bad folder shouldn't hide every other valid file in a large
/// library from the user.
pub fn scan_library(root: &Path) -> Vec<LibraryEntry> {
    let mut entries = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_entry(|e| !is_hidden(e)) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let has_scanned_extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| SCANNED_EXTENSIONS.iter().any(|allowed| ext.eq_ignore_ascii_case(allowed)));
        if !has_scanned_extension {
            continue;
        }

        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        entries.push(LibraryEntry {
            path: path.to_string_lossy().into_owned(),
            title,
            is_dir: false,
        });
    }

    entries.sort_by_cached_key(|e| e.title.to_lowercase());
    entries
}

/// Whether `entry` should be pruned as a hidden dotfile/dotdir. Never true
/// for the walk's own root (depth 0) — a user may deliberately pick a hidden
/// folder as their library root; only its *descendants* get filtered.
fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return false;
    }
    entry
        .file_name()
        .to_str()
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
}

fn load_pinned(base_dir: &Path) -> Result<Vec<PinnedFile>, LibraryError> {
    load_json(&flat_json_path(base_dir, "pinned_files.json")?)
}

fn save_pinned(base_dir: &Path, entries: &[PinnedFile]) -> Result<(), LibraryError> {
    save_json(&flat_json_path(base_dir, "pinned_files.json")?, &entries)
}

pub fn list_pinned_files(base_dir: &Path) -> Result<Vec<PinnedFile>, LibraryError> {
    load_pinned(base_dir)
}

/// Adds `file_hash` to the pinned list if it isn't already there (no-op,
/// returning the unchanged list, if it is).
pub fn pin_file(
    base_dir: &Path,
    path: String,
    file_hash: String,
    title: String,
) -> Result<Vec<PinnedFile>, LibraryError> {
    let mut entries = load_pinned(base_dir)?;
    if entries.iter().any(|e| e.file_hash == file_hash) {
        return Ok(entries);
    }
    entries.push(PinnedFile {
        path,
        file_hash,
        title,
    });
    save_pinned(base_dir, &entries)?;
    Ok(entries)
}

pub fn unpin_file(base_dir: &Path, file_hash: &str) -> Result<Vec<PinnedFile>, LibraryError> {
    let mut entries = load_pinned(base_dir)?;
    entries.retain(|e| e.file_hash != file_hash);
    save_pinned(base_dir, &entries)?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_settings_default_when_unset() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = get_library_settings(tmp.path()).unwrap();
        assert_eq!(settings.root_folder, None);
    }

    #[test]
    fn set_root_folder_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        set_root_folder(tmp.path(), Some("/home/user/Scores".to_string())).unwrap();
        let settings = get_library_settings(tmp.path()).unwrap();
        assert_eq!(settings.root_folder, Some("/home/user/Scores".to_string()));
    }

    #[test]
    fn scan_library_finds_only_scored_extensions_recursively() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("a.mscz"), b"").unwrap();
        std::fs::write(root.join("notes.txt"), b"").unwrap();
        let sub = root.join("Bach");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("Invention.mscx"), b"").unwrap();
        std::fs::write(sub.join("scan.pdf"), b"").unwrap();
        let hidden = root.join(".git");
        std::fs::create_dir(&hidden).unwrap();
        std::fs::write(hidden.join("hidden.mscz"), b"").unwrap();

        let entries = scan_library(root);
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["a", "Invention", "scan"]);
    }

    #[test]
    #[cfg(unix)]
    fn scan_library_skips_unreadable_subdir_instead_of_aborting() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("good.mscz"), b"").unwrap();
        let locked = root.join("Locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("unreachable.mscz"), b"").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let entries = scan_library(root);

        // Restore permissions so tempfile can clean up the directory on drop.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["good"]);
    }

    #[test]
    fn pin_file_is_idempotent_and_unpin_removes() {
        let tmp = tempfile::tempdir().unwrap();
        pin_file(
            tmp.path(),
            "/a.mscz".to_string(),
            "hash-a".to_string(),
            "A".to_string(),
        )
        .unwrap();
        let after_dup = pin_file(
            tmp.path(),
            "/a.mscz".to_string(),
            "hash-a".to_string(),
            "A".to_string(),
        )
        .unwrap();
        assert_eq!(after_dup.len(), 1);

        let listed = list_pinned_files(tmp.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_hash, "hash-a");

        let after_unpin = unpin_file(tmp.path(), "hash-a").unwrap();
        assert_eq!(after_unpin.len(), 0);
    }
}

