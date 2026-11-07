---
name: release
description: Use whenever the user wants to push/release/ship a new Lyrica version (bump, tag, push). Runs the pre-release gate so a tag is never pushed unless the release will succeed.
---

# Releasing Lyrica

**Never push a version tag (or the version-bump commit) until `just preflight` passes.** A tag that fails
`release.yml` burns that version number (v3.3.1 failed on a `cargo fmt --check` diff that `cargo test`
alone wouldn't have caught), and the fix then needs yet another version.

## Steps

1. Bump the version in `Cargo.toml`, `crates/desktop/tauri.conf.json`, `web/package.json` (and lockfiles,
   e.g. `cargo check` to refresh `Cargo.lock`). All three must match; the tag is `v<version>`.
2. Commit everything (`Bump version to X.Y.Z`). Preflight fails on a dirty tree.
3. Run `bash -lc 'just preflight'` (non-login shells lack cargo/node). It mirrors `release.yml`'s
   `prepare` job, all of `ci.yml` (fmt, clippy `-D warnings`, tests, web, landing page + docker, actionlint)
   and the real `just release` bundle build (.deb + .AppImage).
4. If anything fails: fix it, commit, re-run preflight from the start. Do NOT push, retag, or "try CI and see".
5. Only when preflight prints `preflight OK`: push `main` and the tag (see the "Release means full release"
   memory — bump, commit, push main, push tag).
6. Afterwards watch the run (`gh run list --limit 3`, `gh run watch <id>`) and report the result honestly.

## If a release already failed on CI

The tag exists on origin, so don't move/delete it without asking. Fix on main, run preflight, and release the
next patch version.

When changing `ci.yml` or `release.yml`, add the equivalent check to `just preflight` so they stay in sync.
