# MSCZ Reader: handoff and plan

## Goal
A custom desktop app that opens existing MuseScore `.mscz` files and works like a **PDF reader for sheet music**, with practice helpers. **No note editing whatsoever.** The user does not want to export files (no MusicXML/PDF step on their side): they open the `.mscz` directly.

## Features (v1)
- Drag and drop any `.mscz` to open it
- Default view: **pages, scrolling vertically** (not continuous scroll)
- Next / previous page buttons
- Play / pause (basic audio only, no mixing, no custom instruments)
- Set **markers** and **loop between markers** for practice
- **Custom markers/notes** attached to a measure (e.g. "Stretch hands!!")
- **"Most recent"**: a recently opened files list
- **Multiple tabs** for multiple `.mscz` files, Excel-style at the bottom
- Repeats must be respected in playback
- **Pieces index (like PDF chapters/sections).** One `.mscz` can contain several pieces. The app should build an index of them and let the user jump between them. Detect automatically where possible (e.g. new title text/frames; research better signals such as section breaks, movement or rehearsal markers, or multiple scores inside the file). Markers stay as the user's own custom section marks on top of this.
- **Select-loop-practice (essential).** Loop a selected region, with quick playback speed buttons **0.5x, 0.75x, 1.0x** and an **optional metronome**.

## Top priorities and interaction rules
- **Above all: a really snappy UI.** Fast file open, instant page turns, no lag when dragging selections or starting playback. Treat this as a hard requirement when comparing approaches.
- **Android is a nice future goal** (not v1). Prefer approaches that don't block it.
- **Loop selection must be direct manipulation:** the user clicks and drags from one point to another on the score, then presses **L** to loop that selection. No "loop tool, then pick start, then pick end" workflow. Same spirit for markers: minimal clicks, keyboard shortcuts wherever sensible.

## Working style the user wants
Short answers. Guide step by step, a bit at a time. Do not dump big plans or large code without agreement.

## What we learned so far
- `.mscz` is a ZIP archive containing an `.mscx` (plain XML score) plus optional extras. MuseScore 3 and 4 differ. There is **no official standalone spec**; the source code is the reference.
- MuseScore is open source, **GPLv3**. Reading the format in your own code is fine. Copying or porting MuseScore code means the project must also be GPLv3.
- Drawing the score (engraving: spacing, beams, ties, line breaks) is the hard part, not reading the file.
- Forking MuseScore was considered and rejected by the user (huge C++/Qt codebase, heavy build). **The user wants to build from scratch, probably in Rust.**
- Reference project found: `partitioncloud/musescore-web-display` (a fork of `yezhiyi9670/musescore-web-display`). It does **not** parse the format itself:
  - It uses **webmscore** (MuseScore's C++ engine compiled to WebAssembly) to load the `.mscz` and produce **SVG pages**, **measure positions**, and **audio** (soundfont `FluidR3Mono_GM.sf3`).
  - The UI is Vue plus Howler; a `measures.mpos` file maps measures to page positions and times, which drives the playback cursor and auto-scroll.
  - Alternative path there: pre-export SVG/audio with the MuseScore CLI.
  - Note: I only read its README, not the source. Reading the actual `score-display` code would be a useful step.

## Candidate approaches (to be researched, not decided)
- **A. Embed MuseScore's engine.** E.g. Tauri app (Rust backend plus web frontend) using webmscore for SVG pages, measure positions and audio. Fast to build; rendering isn't Rust.
- **B. Call the MuseScore CLI as a hidden engine** (SVG plus measure positions). Simple, but requires MuseScore installed.
- **C. Fully from scratch in Rust.** Parse `.mscx`, build the score model, own layout and renderer. Largest effort, fully owned.
- **D. Other engines to evaluate** (verify these; my knowledge may be outdated): Verovio (renders MusicXML/MEI to SVG, has WASM builds), OpenSheetMusicDisplay (JS, MusicXML), anything else found.

## PHASE 0: Research first (do this BEFORE any code)
Do not write application code yet. Produce a short written comparison and recommendation, then **stop and wait for the user's decision**.

Research tasks:
1. **Rendering options.** For each of A to D: how it loads `.mscz`, maintenance status, which MuseScore versions (3 / 4.x) it supports, output (SVG? measure positions?), size, license, and how hard each of the v1 features would be on top of it.
2. **Existing Rust options.** Any crates that parse `.mscx` or `.mscz`, do music engraving, or render notation. Check crates.io and GitHub.
3. **App shell.** Compare Tauri, egui, iced, and a plain web app, for: drag and drop, bottom tabs, page-based SVG display, overlays for markers and a playback cursor, and embedding a webview/WASM engine.
4. **Audio.** Compare soundfont synth crates (`rustysynth`, `oxisynth`) and output (`cpal`, `rodio`). Which small General MIDI soundfont to bundle and its license. How to build a timeline with repeats unrolled and measure-to-time mapping (needed for cursor and loop markers).
5. **Marker and loop design.** What data each approach exposes to anchor markers to measures, and where to persist custom markers (per-file sidecar file or app data, never modifying the `.mscz`).
6. **Licensing impact** of each option (GPLv3 obligations).
7. **Read** the `score-display` source in the reference repo to confirm how it gets measure positions and audio.
8. **Snappiness.** Which approaches give instant open and page turns? Cost of loading a big engine (e.g. WASM, ~20 MB in the reference project), startup time, and whether pages can be rendered once and cached.
9. **Android feasibility** for each approach (e.g. Tauri mobile, egui/iced on Android, web/PWA). Note any blockers, but don't let it drive v1.
10. **Direct-manipulation selection.** What does each approach expose (measure and note bounding boxes) to support click-drag selection across measures and pages, plus L-to-loop?
11. **Practice audio.** Changing playback speed without changing pitch (time-stretching vs. simply rendering the timeline at a slower tempo, which is probably simplest with a synth), and a metronome (click track generated from the time signature and tempo map).
12. **Pieces index.** How to detect separate pieces inside one `.mscz` (titles, section breaks, movements, rehearsal marks, multiple scores), and which approach exposes that data.

Deliverable: a comparison table, a clear recommendation with reasons, risks, and a proposed minimal first prototype (e.g. "open one `.mscz` and show page 1"). Keep it short.

## After the user picks an approach (suggested order)
1. Prototype: open a `.mscz` and display page 1.
2. Pages view, next/previous, drag and drop.
3. Measure map: click or highlight measures.
4. Playback with repeats, then the cursor.
5. Click-drag selection plus L to loop, then speed buttons (0.5x / 0.75x / 1.0x) and metronome.
6. Markers and custom notes (persisted outside the `.mscz`).
7. Pieces index and jumping between pieces.
8. Tabs for multiple files, then the recent-files list.

## Open questions for the user
- Target platform: desktop only, or also web/mobile?
- Which MuseScore versions must open (3, 4, or both)?
- Is GPLv3 acceptable (personal use only, or distribution planned)?
