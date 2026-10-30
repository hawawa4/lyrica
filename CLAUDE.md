# Lyrica

A sheet-music practice app that opens existing MuseScore `.mscz` files (like a PDF reader, not an editor) with practice helpers: loop selection, markers, speed control, metronome, pieces index.

## Toolchain

`node`/`cargo` are managed via `nvm`/`rustup`, sourced only in `~/.bashrc`. Non-login shells won't have them on `PATH` — use `bash -lc '...'` or a login shell.

Run `just` with no arguments to list all dev recipes (build, test, dev server, soundfont fetch).

## Workspace layout

- `crates/core` — shared Rust logic (score version-sniffing, timeline construction, audio synth). No `tauri::`/`axum::` imports — both shells are thin adapters over this.
- `crates/desktop` — Tauri 2 shell. Thin `#[tauri::command]` wrappers over `crates/core::api`.
- `crates/server` — axum shell (placeholder, not yet built).
- `crates/cv-barline` — PDF-mode barline-detection assist (classical CV, no ML).
- `site/` — the static landing page (Astro), built into a Docker image. Independent of the app.
- `web/` — Vite + TypeScript frontend, shared by both the Tauri webview and (eventually) axum's static serving. webmscore and all score/PDF rendering happens here; Rust never parses `.mscz`/MIDI directly.

## Soundfont

The app needs a GM soundfont for audio playback, fetched on demand (not committed to git — ~40MB):

```
just fetch-soundfont
```

This pulls MuseScore's own `MuseScore_General.sf3` into `assets/` (sha256-pinned in the Justfile). It's played by `oxisynth`, which supports SF2 modulators and Ogg-compressed `.sf3`. **Don't switch back to `rustysynth`**: it discards modulators (`pmod`/`imod` chunks are parsed and thrown away), which makes MuseScore's soundfont sound quiet and bass-only, and it can't load `.sf3` at all.

The `.sf3` is decoded to raw samples at load time: ~2s on a desktop CPU, and the decoded samples take ~250MB of RAM. The desktop shell loads it on a background thread (`AudioState::load_soundfont_in_background`); playback before it finishes is silent apart from metronome clicks.

oxisynth's AllNotesOff respects the sustain pedal, so `Player` lifts the pedal around it on pause/seek/loop-wrap (`release_all_notes`) — otherwise pedalled notes keep ringing.

## Updates

The library view (`web/src/views/UpdateNotice.ts`) shows a small non-modal "Lyrica X.Y.Z is available" chip bottom-right — no dialogs/toasts. It checks GitHub's `releases/latest` **once per launch**, silently (failures only hit the console), and installs only when the user clicks it. `crates/core/src/updater/` (behind the `updater` feature, enabled by the desktop crate) holds all the logic; `crates/desktop/src/updates.rs` is the thin Tauri wrapper (`check_for_update`, `install_update` streaming progress over a `Channel`, `restart_app`).

How it installs depends on `Install::detect()`: an AppImage (`$APPIMAGE`) is downloaded next to itself and atomically renamed over; a `.deb` (exe under `/usr/`, not `/usr/local/`) is downloaded and installed with `pkexec apt-get install` (polkit password dialog — a GUI has no tty for sudo). Anything else (`cargo run`, `/usr/local/bin`) has no release artifact to update from, so the chip just opens the release page. Every download is verified against the release's `SHA256SUMS.txt` and refused without one. Both depend on `release.yml`: the asset names are Tauri's `Lyrica_<version>_amd64.{AppImage,deb}`, and the running version is `CARGO_PKG_VERSION`, which `release.yml`'s `prepare` job already requires to equal the tag — keep both in sync if the release job changes.

## Known gotchas

- **webmscore in Node vs. browser**: webmscore 1.2.1's Node-targeted glue code breaks under Node 22 (read-only `navigator`, global `fetch` misdetection) — it should never be needed in `web/` itself, which always runs in a real browser or Tauri webview.
- **webmscore in Vite**: vendored as two parts — `web/public/vendor/webmscore/` (the runtime `.mjs`/`.wasm`/`.data`, served byte-identical via Vite's `publicDir`, loaded via a dynamic `import()` of its own absolute URL, never statically imported) and `web/vendor/webmscore/` (type-only declarations, erased at compile time). A static import gets minified/bundled by Rollup and silently breaks the Web-Worker-based wasm loading. See the comments atop `web/src/score-engine.ts` for the full reasoning.
- **`WebMscoreW.version()` is a dead stub** that always returns `-1` in the browser build — don't use it for the upgrade-needed check; compare `metadata.fileVersion` against the hardcoded `ENGINE_FILE_VERSION` constant in `score-engine.ts` instead.
- **`segmentPositions()` crashes** (wasm signature mismatch) in webmscore 1.2.1. `measurePositions()` works fine and is what `Timeline` construction uses — don't reach for `segmentPositions()` as a fallback without re-testing it.
- **`measurePositions().events[]` is already repeats-unrolled** — its `elid` sequence replays repeated sections/D.C. jumps inline, with `events.length` exceeding `elements.length` whenever the piece has repeats. `Timeline` construction (`crates/core/src/timeline.rs`) uses this directly; it does NOT re-derive measure boundaries from MIDI tick positions. MIDI (`saveMidi`) is only parsed for the tempo map.
- **`measurePositions()` times can disagree with the MIDI.** After a D.S./D.C. jumping to a point whose tempo marking sits *before* the jump target, webmscore's MIDI keeps the pre-jump tempo while `measurePositions()` uses the right one (EoSD.mscz drifts 12.4s this way). The timeline therefore takes each measure's time from the MIDI's tempo map, at a tick computed from the score XML's measure lengths + section pauses (`crates/core/src/measure_layout.rs`) — so cursor/seek match what's audible.
- **webmscore's engine is MuseScore 4.0.0** — files saved by MuseScore 4.1+ can use XML it silently ignores. Known case: key signatures (`<concertKey>` instead of `<accidental>`) all vanish. `crates/core/src/engine_compat.rs` rewrites these in memory before loading; extend it if other dropped elements show up. `metadata.fileVersion` (450) doesn't distinguish 4.0 from 4.5 files.
- **cpal's `Stream` is `!Send + !Sync`** on every backend (platform audio handles aren't thread-safe to share). It cannot live in Tauri's managed state directly — see `crates/desktop/src/audio_state.rs` for the pattern (a dedicated parked thread owns the stream for the app's lifetime; only the `Arc<Mutex<Player>>` is shared).
- **Audio output sample rate must match the device's actual rate**, not a hardcoded value — `rustysynth` doesn't resample internally. Query it via `output_cpal::default_output_sample_rate()` before constructing the synth.
- **The package is named `mp-core`, not `core`** — naming it `core` shadows Rust's std `core` crate and breaks rustdoc's doctest harness.

## Commit cadence

Commit after each small milestone/phase is verified — never one giant commit covering multiple phases.
