# MusePractice

A sheet-music practice app that opens existing MuseScore `.mscz` files (like a PDF reader, not an editor) with practice helpers: loop selection, markers, speed control, metronome, pieces index. See `mscz-reader-handoff.md` for the full feature spec and `IMPLEMENTATION_PLAN.md` for the phased build plan this project follows.

## Toolchain

`node`/`cargo` are managed via `nvm`/`rustup`, sourced only in `~/.bashrc`. Non-login shells won't have them on `PATH` — use `bash -lc '...'` or a login shell.

Run `just` with no arguments to list all dev recipes (build, test, dev server, soundfont fetch).

## Workspace layout

- `crates/core` — shared Rust logic (score version-sniffing, timeline construction, audio synth). No `tauri::`/`axum::` imports — both shells are thin adapters over this.
- `crates/desktop` — Tauri 2 shell. Thin `#[tauri::command]` wrappers over `crates/core::api`.
- `crates/server` — axum shell (not yet built — Phase 2b).
- `crates/cv-barline` — PDF-mode barline-detection assist (not yet built — Phase 9).
- `web/` — Vite + TypeScript frontend, shared by both the Tauri webview and (eventually) axum's static serving. webmscore and all score/PDF rendering happens here; Rust never parses `.mscz`/MIDI directly.
- `_spike/` — disposable Phase 1 risk-reduction harness (webmscore position-export API validation). Not part of the real app; keep it that way.

## Soundfont

The app needs a GM soundfont for audio playback, fetched on demand (not committed to git — ~148MB):

```
just fetch-soundfont
```

This pulls `FluidR3_GM.sf2` into `assets/`. **Do not switch this to MuseScore's own soundfont** (`MuseScore_General.sf2`/`.sf3`) — it sounds badly wrong (quiet, bass-only) through `rustysynth`, the Rust synth crate this project uses, because `rustysynth` has zero SF2 modulator support (confirmed in its source — `pmod`/`imod` chunks are parsed and discarded) and MuseScore's soundfont depends on modulators to sound right. Not fixable by adjusting gain or player code. See `plans/oxisynth-migration.md` for the full diagnosis and a deferred plan to fix this properly.

Separately: `rustysynth` cannot load `.sf3` (Ogg-compressed-sample soundfonts) at all — only uncompressed `.sf2`.

## Known gotchas

- **webmscore in Node vs. browser**: webmscore 1.2.1's Node-targeted glue code breaks under Node 22 (read-only `navigator`, global `fetch` misdetection) — see `_spike/shim-preload.cjs` and `_spike/FINDINGS.md` if you ever need to run it outside a browser/webview again. This should never be needed in `web/` itself, which always runs in a real browser or Tauri webview.
- **webmscore in Vite**: vendored as two parts — `web/public/vendor/webmscore/` (the runtime `.mjs`/`.wasm`/`.data`, served byte-identical via Vite's `publicDir`, loaded via a dynamic `import()` of its own absolute URL, never statically imported) and `web/vendor/webmscore/` (type-only declarations, erased at compile time). A static import gets minified/bundled by Rollup and silently breaks the Web-Worker-based wasm loading. See the comments atop `web/src/score-engine.ts` for the full reasoning.
- **`WebMscoreW.version()` is a dead stub** that always returns `-1` in the browser build — don't use it for the upgrade-needed check; compare `metadata.fileVersion` against the hardcoded `ENGINE_FILE_VERSION` constant in `score-engine.ts` instead.
- **`segmentPositions()` crashes** (wasm signature mismatch) in webmscore 1.2.1. `measurePositions()` works fine and is what `Timeline` construction uses — don't reach for `segmentPositions()` as a fallback without re-testing it.
- **`measurePositions().events[]` is already repeats-unrolled** — its `elid` sequence replays repeated sections/D.C. jumps inline, with `events.length` exceeding `elements.length` whenever the piece has repeats. `Timeline` construction (`crates/core/src/timeline.rs`) uses this directly; it does NOT re-derive measure boundaries from MIDI tick positions. MIDI (`saveMidi`) is only parsed for the tempo map.
- **cpal's `Stream` is `!Send + !Sync`** on every backend (platform audio handles aren't thread-safe to share). It cannot live in Tauri's managed state directly — see `crates/desktop/src/audio_state.rs` for the pattern (a dedicated parked thread owns the stream for the app's lifetime; only the `Arc<Mutex<Player>>` is shared).
- **Audio output sample rate must match the device's actual rate**, not a hardcoded value — `rustysynth` doesn't resample internally. Query it via `output_cpal::default_output_sample_rate()` before constructing the synth.
- **The package is named `mp-core`, not `core`** — naming it `core` shadows Rust's std `core` crate and breaks rustdoc's doctest harness.

## Commit cadence

Commit after each small milestone/phase is verified — never one giant commit covering multiple phases.
