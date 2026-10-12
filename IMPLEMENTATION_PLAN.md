# MSCZ Reader — Implementation Plan

## Context

This is a greenfield build. The only existing artifact is `mscz-reader-handoff.md` at the repo root, which captures the full feature spec plus decisions made across prior research/planning sessions (rendering engine choice, architecture, audio approach, PDF mode). This plan operationalizes that doc into an executable sequence for a coding agent: first a small risk-reduction spike, then the full v1 build.

**Why the spike matters:** the single biggest open risk identified during research was whether webmscore's position-export API gives real, usable per-measure bounding boxes — needed for the "essential" click-drag-select-then-press-L-to-loop interaction. That risk has now been substantially de-risked by reading webmscore's actual TypeScript API (`src/index.d.ts`/`schemas.ts` in the published npm package) rather than just its README: `measurePositions()`/`segmentPositions()` return exactly the geometry (`x, y, sx, sy, page`) and timing (`events[].position`) data needed. It is *likely* to pass, but must still be run against a real file, because field semantics (pre/post repeat-unroll, `id`/`elid` matching) are unconfirmed from docs alone.

**Toolchain note (environment-specific — apply throughout, both phases):** `node` is managed via `nvm` and `cargo` via `~/.cargo/env`, both sourced only in `~/.bashrc`. Non-interactive/non-login shells will NOT have these on `PATH` by default. Any command invoking `node`, `npm`, `npx`, `cargo`, or `rustc` must first source them, e.g.:
```bash
source ~/.bashrc 2>/dev/null; command -v node cargo || { source "$HOME/.nvm/nvm.sh"; source "$HOME/.cargo/env"; }
```
or simply run shell commands with `bash -lc '...'` (login shell) so `.bashrc`/profile sourcing happens automatically. Verify `node --version` and `cargo --version` succeed before proceeding with either phase.

---

## Part 1: Prototype spike (throwaway harness, timeboxed to ~1 day)

**Goal:** confirm webmscore's position-export data actually supports mapping a mouse-drag rectangle to a measure range, on a real file, including through the MS-version upgrade path.

**Location:** a scratch directory clearly outside the real app skeleton, e.g. `/home/hawa/codeprojects/musepractice/_spike/`. This is disposable — do not let it become the seed of the real `web/` tree. At most 10-20 lines of validated logic get rewritten (not copy-pasted) into real code in Phase 3 of Part 2.

### Setup
1. `source ~/.bashrc` (or use a login shell) to get `node`/`npm` on `PATH`.
2. `mkdir -p _spike/fixtures/out && cd _spike && npm init -y && npm i webmscore@1.2.1`. Set `"type": "module"` in `package.json`.
3. Copy two real files from `/home/hawa/Documents/Musescore/` into `_spike/fixtures/`:
   - `Dark Side Of Fate.mscz` — already MS4 (`version="4.50"`), likely multi-page, use as the native-MS4 case.
   - `Youkai Mountain ~ Mysterious Mountain 『2』.mscz` — MS2 (`version="2.00"`), smallest file (10.6KB), use as the upgrade-path case.

   (Note: the library has mixed versions — confirmed by direct inspection: Dark Side Of Fate=4.50, Night_Of_Nights_-_COOLCREATEZUN=4.00, Night_of_NightsFlowering_Nights_Remix=2.06, Night_Sakura_of_Dead_Spirits=2.06, The Fantastic Legend of Tohno=1.14, Youkai Mountain=2.00.)

### Script: `_spike/dump.mjs`
1. `import WebMscore from 'webmscore'; await WebMscore.ready;`
2. Load the MS2 fixture (Youkai): `WebMscore.load('mscz', new Uint8Array(fs.readFileSync(...)))`.
3. Print `metadata()`'s `fileVersion`, `mscoreVersion`, `measures`, `duration`, `textFramesData`. Confirm `fileVersion < await WebMscore.version()` correctly signals "needs upgrade."
4. Call `score.saveMsc('mscz')`, write result to `fixtures/youkai_upgraded.mscz`, then re-load that output fresh and confirm `metadata().fileVersion` now reports MS4 and `npages()`/`measurePositions()` still work. This proves the upgrade round-trip end-to-end, not just in theory.
5. Load the MS4 fixture (Dark Side Of Fate) directly — no upgrade needed.
6. For each loaded score, call `npages()`, then `saveSvg(pageIndex, true)` for at least 2 pages (if a fixture turns out to be single-page, note it and rely on the other fixture for the multi-page check). Write each to `fixtures/out/page{N}.svg`.
7. Call `measurePositions()` and `segmentPositions()`, dump both to `fixtures/out/measures.json` and `fixtures/out/segments.json`.
8. Write `_spike/view.html`: inline one `page0.svg`, overlay an absolutely-positioned semi-transparent `<div>` per `PositionElement` entry using its `x, y, sx, sy` directly as CSS `left/top/width/height` (matching `pageSize` from the JSON — no unit conversion expected). Open in a browser, visually confirm boxes land on real measure boundaries.
9. Add mouse-drag-rectangle JS to `view.html`: on drag, build a rect, filter `measures.json`'s `elements` to those overlapping it on the same `page`, highlight the matches in a different color.

### Pass/fail criterion
- **Pass:** overlay boxes align with real measure boundaries (within a few px) for both the native-MS4 file and the upgraded-from-MS2 file; drag-rect selection picks the visually correct measures; `events[].position` values increase monotonically and roughly match `metadata().duration`.
- **Fail / fallback to evaluate later (not now):** boxes are offset/scaled wrong, don't reset per page, or go stale post-upgrade. Fallback options if so: finer-grained `segmentPositions()`, re-deriving boxes from note positions, or page-region-granularity looping instead of measure-exact.

Do not add retry logic, error handling, or reusable abstractions here — it's disposable.

---

## Part 2: Full implementation

### Workspace layout (greenfield, create at repo root)

```
musepractice/
├── Cargo.toml                      # workspace root, members = ["crates/*"]
├── crates/
│   ├── core/                       # shared Rust core: state, timeline, synth, sidecar I/O
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── mscz.rs             # zip/container.xml handling, cheap version sniff
│   │       ├── timeline.rs         # flattened playback timeline + measure-time map
│   │       ├── markers.rs          # marker/note/loop-point/pieces-index data model
│   │       ├── sidecar.rs          # content-hash-keyed persistence
│   │       ├── audio/
│   │       │   ├── mod.rs
│   │       │   ├── synth.rs        # rustysynth wrapper, speed re-timing
│   │       │   ├── metronome.rs    # click-track generator from tempo map
│   │       │   └── output_cpal.rs  # cpal output stream (desktop; feature-gated)
│   │       ├── recent_files.rs
│   │       └── api.rs              # the one shared request/response shape
│   ├── desktop/                    # Tauri 2 shell
│   │   └── src/{main.rs, commands.rs}   # thin #[tauri::command] wrappers over crates/core::api
│   ├── server/                     # axum web/server shell
│   │   └── src/{main.rs, routes.rs}     # thin REST routes over crates/core::api
│   └── cv-barline/                 # PDF-mode barline-detection assist (isolated, optional)
│       └── src/lib.rs
├── web/                             # JS/TS layer, used by BOTH desktop webview and axum static serving
│   ├── package.json
│   ├── index.html
│   ├── src/
│   │   ├── main.ts
│   │   ├── api-client.ts           # wraps invoke() (Tauri) or fetch() (axum) behind one interface
│   │   ├── score-engine.ts         # webmscore load/upgrade/SVG/positions wrapper
│   │   ├── pdf-engine.ts           # pdf.js load + calibration-point math for PDF mode
│   │   ├── render/
│   │   │   ├── PageView.ts         # paged SVG display, page cache
│   │   │   ├── SelectionOverlay.ts # drag-rect -> measure-range mapping, L-to-loop
│   │   │   └── Cursor.ts           # playback cursor overlay synced to timeline
│   │   ├── views/
│   │   │   ├── TabBar.ts
│   │   │   ├── RecentFiles.ts
│   │   │   ├── PiecesIndex.ts
│   │   │   └── MarkerPanel.ts
│   │   └── types.ts                # TS mirrors of crates/core::api structs
│   └── vendor/webmscore/            # vendored npm package assets (same copy for both shells)
├── assets/FluidR3Mono_GM.sf3        # bundled GM soundfont (verify license before first commit adding it)
└── mscz-reader-handoff.md           # existing spec, keep at root
```

**Why one `web/` tree for both shells:** Tauri 2 loads a local frontend into its webview (`tauri.conf.json`'s `frontendDist`); axum serves the same built static assets via `tower-http::services::ServeDir`. webmscore/pdf.js/rendering/selection logic is written once. The only thing that differs by target is `api-client.ts`'s transport, chosen at runtime by checking for `window.__TAURI_INTERNALS__`.

### Crates to add, by phase
- **Phase 0:** `serde`, `serde_json`, `thiserror`, `zip` 9.0.2 (reading `.mscz` as a plain zip for our own version-sniff — separate from webmscore's internal unzip), `quick-xml` (parsing `container.xml` and the `.mscx` header).
- **Phase 1 (audio):** `rustysynth` 1.3.7, `cpal` (0.15.x) for desktop output.
- **Phase 2 (desktop shell):** `tauri` 2.12.3, `tauri-build`, `tauri-plugin-dialog`, `tauri-plugin-fs`.
- **Phase 2b (server shell):** `axum` 0.8.9, `tokio` (1.x, full), `tower-http` (ServeDir, cors).
- **Phase 3 (file hashing):** `blake3` — fast, stable content addressing, no crypto-grade requirement needed.
- **PDF mode phase:** `pdfjs-dist` in `web/` for rendering (keeps the "rendering happens in the webview" pattern consistent with webmscore); `image` + `imageproc` in `crates/cv-barline` for the CV barline assist, fed PNG page bitmaps handed over from the JS canvas layer via the API boundary (not a second PDF render in Rust).

### API boundary: one shape, two transports
Define request/response types once in `crates/core/src/api.rs` as plain serde structs (one function per feature action: open file, get/save markers, get timeline, playback control, etc.).
- **Desktop:** `crates/desktop/src/commands.rs` exposes thin `#[tauri::command]` wrappers calling straight into `crates/core::api` — no business logic duplicated in the Tauri layer.
- **Server:** `crates/server/src/routes.rs` exposes a **REST-per-group** API: `POST /api/files/open`, `GET /api/files/recent`, `POST /api/markers`, `GET /api/markers?file_hash=...`, `GET /api/timeline?file_hash=...`, `POST /api/playback`. Chosen over a single dispatch endpoint specifically because it extends cleanly into `/api/library/...` and `/api/tracking/...` later without reshaping existing routes.
- `web/src/api-client.ts` wraps both transports behind one TS interface (`openFile`, `getRecentFiles`, `saveMarker`, etc.).
- **Where webmscore/pdf.js actually run:** entirely inside `web/`'s JS, in both targets (Tauri's webview executes the same JS as a browser tab hitting axum). Rust never parses `.mscz`/PDFs directly — it receives already-exported data (SVG strings, measure positions JSON, MIDI bytes, PNG bitmaps) from the JS layer via the same API boundary, in the *other* direction (e.g. `import_timeline` command/route), so Rust can persist derived data without re-deriving it from source on every launch.

### Data model

**Flattened playback timeline** (`crates/core/src/timeline.rs`):
```rust
pub struct TimelineEvent {
    pub measure_index: u32,  // logical measure number, post-repeat-unroll (repeated measures appear multiple times)
    pub source_elid: u32,    // the webmscore PositionElement.id this instance maps back to (page/box lookup)
    pub time_ms: f64,        // start time in the flattened (1.0x) timeline
    pub page: u32,
    pub bbox: Rect,          // {x, y, sx, sy}, SVG page-pixel space
}
pub struct Timeline {
    pub events: Vec<TimelineEvent>,
    pub duration_ms: f64,
    pub tempo_map: Vec<(f64 /* time_ms */, f64 /* qpm */)>,
}
```
Built from webmscore's `saveMidi(midiExpandRepeats=true, false)` output (repeats already unrolled by the engine itself — don't reimplement jump/repeat logic), cross-referenced against `measurePositions()`/`segmentPositions()` (which describe the *printed*, non-unrolled page) by matching unrolled MIDI measures back to printed `elid`s via measure order plus `events[].position` as a sanity check. `rustysynth`'s own `MidiFile` type parses standard MIDI, so no separate MIDI-parsing crate is needed.

Speed control (0.5x/0.75x/1.0x) = scale every `time_ms` by `1/speed` when scheduling synth events at playback-start time — never touches pitch, and allows changing speed mid-playback via reschedule rather than re-deriving the timeline.

**Persistence — content-hash-keyed sidecar, not next-to-file:**
- `blake3` hash of the opened file's bytes → hex string `h`.
- Desktop: `{app_data_dir}/musepractice/scores/{h}/meta.json` containing `{ original_filename, original_path, last_opened, markers, pieces_index, derived_timeline_cache, upgraded_from_version }`.
- PDF mode: `{app_data_dir}/musepractice/pdfs/{h}/calibration.json` containing `{ points: [{page, x, y, measure, beat}], tempo_segments }`.
- **Why content-hash, not a file dropped next to the `.mscz`:** a next-to-file sidecar breaks the moment the file moves/renames/lives in a synced folder (common for a practice library). Content-hashing survives all of that, and is the same key scheme a future server-mode library/tracking feature will want anyway (stable piece ID across devices) — this is the concrete mechanism that keeps the server-mode door open without building it now.

### Feature milestones, in order

**Phase 0 — Workspace skeleton + cheap version sniff**
- Create the Cargo workspace and `web/` Vite project per the layout above; a no-op Tauri window loading `web/index.html`.
- `crates/core/src/mscz.rs`: open `.mscz` via `zip`, parse `META-INF/container.xml` via `quick-xml`, **select the rootfile by `.mscx` extension, not "first entry"** — confirmed necessary: in the real sample library, `Dark Side Of Fate.mscz` and `Night_Of_Nights_-_COOLCREATEZUN.mscz` both list `score_style.mss` before the real `.mscx` in `container.xml`'s `<rootfiles>`. Read just the opening `<museScore version="...">` attribute cheaply, without parsing the whole XML or invoking WASM.
- **Done when:** running against all 6 files in `/home/hawa/Documents/Musescore/` reports versions `4.50 / 4.00 / 2.06 / 2.06 / 1.14 / 2.00` respectively, with zero wrong-rootfile picks.

**Phase 1 — Open + render single page**
- `web/src/score-engine.ts`: vendor webmscore into `web/vendor/webmscore/`; `openScore(bytes) => { needsUpgrade, metadata }` comparing `WebMscore.version()` vs `metadata().fileVersion`.
- Upgrade confirmation: if `needsUpgrade`, show a blocking modal ("This file was made in an older MuseScore version and will be upgraded to MuseScore 4 format for this app. Continue?"); only on explicit confirm call `saveMsc('mscz')`, store the upgraded bytes only in the app's own cache (keyed by the *original* file's content hash, so re-opening doesn't re-prompt) — never write back over the original file.
- Render page 0 via `saveSvg(0, true)`.
- Bundle `assets/FluidR3Mono_GM.sf3` — **verify its exact license before this commit**.
- **Done when:** hardcoded paths to each of the 6 sample files render page 0 correctly, with the upgrade prompt appearing only for the 4 non-MS4 files.

**Phase 2 — Paged navigation + drag-and-drop**
- `web/src/render/PageView.ts`: next/prev buttons, vertical page-by-page (not continuous scroll); **cache rendered SVG per page index in memory** so repeat navigation never re-calls `saveSvg` for an already-rendered page — this is the concrete mechanism for the "pages cached once rendered" snappiness requirement.
- Desktop: `getCurrentWebview().onDragDropEvent(...)`, read dropped path bytes via `tauri-plugin-fs`. Web/server: HTML5 `<input type=file>` / browser drag-drop (`DataTransfer.files`), reading bytes client-side (no OS path to hand to a backend in this target).
- **Done when:** dragging any of the 6 real files onto the desktop app opens it, shows page 1, and next/prev pages through a genuinely multi-page file (check `npages()` to pick the best candidate) with no visible re-render lag on repeat visits.

**Phase 3 — Measure map & selection data**
- Port the spike's validated overlay/drag-select logic into `web/src/render/SelectionOverlay.ts` as real, maintained code (rewritten cleanly, not copy-pasted from the disposable spike script).
- Call `measurePositions()` once per opened score, cache the result in memory and in the sidecar (pure derived data, safe to persist).
- **Done when:** click-dragging a rectangle over 2-3 adjacent measures on a real file visually highlights exactly those measures, on both a native-MS4 file and an upgraded-from-MS2 file.

**Phase 4 — Playback with repeats, then cursor**
- Build `Timeline` per the Data Model above: JS calls `saveMidi(true, false)`, hands MIDI bytes + cached `Positions` to Rust via an `import_timeline` API call.
- `crates/core/src/audio/synth.rs`: load the soundfont into `rustysynth::SoundFont`, schedule note-on/off through `rustysynth::Synthesizer`, stream through `cpal` on desktop. For web/server, stream synthesized PCM to the browser's Web Audio API over the API boundary — flag this as the one place desktop/web genuinely diverge (output device), even though synth logic is shared.
- Cursor overlay (`web/src/render/Cursor.ts`) driven by comparing current playback time to `TimelineEvent.time_ms`, highlighting/scrolling to the matching bbox/page.
- **Done when:** playing a file containing a repeat audibly replays the repeated section and the cursor visually jumps back (none of the 6 samples are confirmed to contain a repeat — check their `.mscx` content first; if none do, construct a tiny test score with a repeat barline in MuseScore 4 desktop for this specific test).

**Phase 5 — Click-drag-select + L-to-loop + speed + metronome ("essential" per the handoff)**
- Wire `SelectionOverlay`'s selected measure range to loop state; `L` keydown sets `{loop_start_ms, loop_end_ms}` from the selection with zero extra clicks.
- Speed buttons: reschedule the synth's event timeline by dividing `time_ms` by the speed factor at playback-start (not pre-baked into the stored `Timeline`), so switching speed mid-playback is a reschedule, not a re-derive.
- `crates/core/src/audio/metronome.rs`: generate click events from `Timeline.tempo_map` and time-signature changes (pulled from MIDI meta-events), mixed into the same output stream as a short generated blip (not a soundfont instrument patch).
- **Done when:** drag-select 4 measures, press L, press play — loops only that region at 1.0x; switching to 0.5x mid-loop audibly slows without pitch change; metronome clicks land on the beat.

**Phase 6 — Markers and custom notes**
- `crates/core/src/markers.rs`: `Marker { id, measure_index, text, created_at }`, CRUD via the API boundary, persisted in the sidecar `meta.json`.
- `web/src/views/MarkerPanel.ts`: attach a note to the currently-selected measure, list markers, click to jump.
- **Done when:** add a marker, close and reopen the app, the marker persists and is still anchored to the correct measure (resolve via `measure_index`/`elid`, not cached raw pixels, so lookups stay robust if layout output ever shifts slightly between webmscore versions).

**Phase 7 — Pieces index**
- Heuristic lives in `crates/core` (pure data logic, unit-testable against fixture JSON dumps rather than live in-browser): inspect `metadata().textFramesData.titles`/`subtitles` counts and document-order positions as the primary signal. Check at implementation time whether `PositionElement`/`PositionEvent` carry any fields beyond the documented geometry ones (e.g. rehearsal-mark text) by inspecting the actual JSON dump from the spike/Phase 0 output — if not exposed, fall back to the VBox/title-frame heuristic alone (the handoff doc already anticipates this).
- None of the 6 real samples are confirmed multi-piece — construct a small test fixture (e.g. use MuseScore 4 desktop to combine two short pieces with a title frame between them, or at minimum verify detection logic against two files' individual `textFramesData` outputs in isolation). Call this out explicitly if a true combined fixture can't be produced.
- **Done when:** the pieces index UI lists at least one detected boundary correctly on a constructed test file, with user markers (Phase 6) remaining layered independently (markers keyed by `measure_index`; pieces index is a separate `{start_measure_index, title}` list — no collision).

**Phase 8 — Tabs + recent files**
- `web/src/views/TabBar.ts`: Excel-style bottom tab bar, one tab per open file (keyed by file hash); switching tabs swaps the active `Timeline`/`Positions`/page-cache state (kept per-tab in `web/src/main.ts`, not globalized).
- `crates/core/src/recent_files.rs`: append-on-open list at `{app_data_dir}/musepractice/recent_files.json` (flat JSON, `{path, file_hash, last_opened, title}`, capped ~20 entries, de-duplicated by hash).
- **Done when:** open 3 of the 6 real files in 3 tabs, switch between them with no re-fetch lag (relies on Phase 2/3's caches already being in memory per tab), close and reopen the app, recent-files list shows all 3 correctly.

**Phase 9 — PDF mode**
- `web/src/pdf-engine.ts`: render PDF pages via `pdfjs-dist` to canvas — no `.mscz`/webmscore involvement.
- Manual tap-calibration UI: user clicks points on the page (optionally while a reference metronome/free-running clock ticks); each click records `{page, x, y, timestamp_or_sequence}`; app assigns `{measure, beat}` labels by auto-increment with user confirm/adjust, or explicit entry.
- Linear interpolation between consecutive calibration points derives a local tempo, building a piecewise-linear `tempo_segments` list reusing the **same `Vec<(time_ms, qpm)>` shape** as `Timeline.tempo_map` — so Phase 5's metronome generator works unmodified against PDF-mode's derived tempo map, since it's a pure function over a tempo map rather than coupled to `.mscz` data.
- Loop regions between two calibration points reuse the same loop-state mechanism as Phase 5, sourced from calibration timestamps instead of `TimelineEvent`s.
- Optional CV barline-detection assist (`crates/cv-barline`): take a page's rendered bitmap (PNG bytes handed from the JS canvas via the API boundary, same pattern as Phase 4's data hand-off), run staff-line detection + projection-profile peak-finding (or Hough transform via `imageproc`) for vertical dark-pixel runs spanning staff height; return candidate x-positions as **suggestions only**, rendered as adjustable/dismissable markers the user must confirm — never auto-applied. Self-contained crate, skippable without blocking the rest of PDF mode.
- Persist calibration data at `{app_data_dir}/musepractice/pdfs/{h}/calibration.json`, hash computed the same way as `.mscz` content-hashing.
- **Done when:** load a plain PDF (export one of the 6 sample files to PDF via MuseScore desktop, or use any sheet-music PDF on hand), tap-calibrate 4-6 points across 2 pages, confirm the metronome audibly follows the interpolated tempo between points, and loop-between-two-points works.

### Testing/verification approach
Each phase's "Done when" line uses the real 6-file library at `/home/hawa/Documents/Musescore/` as the primary manual test corpus — prefer manual, visual, in-app verification for rendering/selection/snappiness (inherently eyeball concerns per the handoff's top priority). Additionally add plain Rust `#[test]` unit tests in `crates/core` for pure-data logic: timeline construction from a fixed MIDI+Positions input pair, sidecar JSON round-trip, pieces-index heuristic logic, content-hash stability. Phases 4, 7, and 9 each need one small hand-constructed test fixture not covered by the real library (a repeat-containing score, a multi-piece score, a plain PDF) — call this out if any can't be sourced.

### Where the future server-mode boundary stays clean
- The REST-per-group API shape lets `/api/library/...` (persistent multi-user library browsing) and `/api/tracking/...` (practice session history) slot in later as new route groups without touching existing routes or `crates/core::api` signatures used by desktop.
- Content-hash-keyed sidecar storage uses the same key scheme a server-side DB table would (`scores(hash PRIMARY KEY, ...)`), so migrating from flat-file sidecars to a real DB later is a storage-backend swap behind `crates/core::sidecar`, not a data-model redesign.
- `crates/core` has zero knowledge of Tauri or axum (no `tauri::`/`axum::` imports) — both shells are thin adapters, keeping a future third adapter (mobile) or persistent-library layer additive, not invasive.

### Critical files
- `mscz-reader-handoff.md` — full spec and decisions, read first
- `crates/core/src/api.rs` — the single shared request/response shape both shells adapt
- `crates/core/src/timeline.rs` — flattened playback timeline + measure-time map, the data model everything else depends on
- `web/src/score-engine.ts` — webmscore load/upgrade/SVG/positions wrapper, where the de-risked spike logic becomes real code
- `web/src/render/SelectionOverlay.ts` — click-drag-to-measure-range + L-to-loop, the handoff's single "essential" interaction
- `crates/core/src/sidecar.rs` — content-hash-keyed persistence shared by markers, pieces index, recent files, and PDF calibration
