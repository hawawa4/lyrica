# Lyrica

A sheet-music practice app for Linux. It opens MuseScore `.mscz` files the way a PDF reader opens PDFs (you read and play them, you don't edit them) and adds the tools you need while learning a piece: loop a passage, slow it down, play with a click, write on the score.

Website: [lyrica.hawawa.org](https://lyrica.hawawa.org) · [Releases](https://github.com/hawawa4/lyrica/releases/latest) · [GPL-3.0](LICENSE)

> Lyrica is an independent project and is not affiliated with or endorsed by MuseScore or Muse Group. "MuseScore" is a trademark of its owners and is used only to name the file format Lyrica opens.

## Using Lyrica

### Install

Download a `.deb` or an `.AppImage` from the [latest release](https://github.com/hawawa4/lyrica/releases/latest).

```sh
# Debian / Ubuntu
sudo apt install ./Lyrica_*.deb

# Any other distro
chmod +x Lyrica_*.AppImage && ./Lyrica_*.AppImage
```

Only Linux x86_64 builds are published. Other platforms haven't been tried.

Lyrica checks GitHub for a newer release once per launch. If there is one, a small chip appears in the bottom-right of the library. Nothing is downloaded until you click it. The AppImage replaces itself, the `.deb` installs through a polkit password prompt, and any other install (for example a build from source) just opens the release page. Downloads are checked against the release's `SHA256SUMS.txt`.

### Opening music

Drop a `.mscz` file (or a PDF) onto the window, use the file picker, or pick a score from the library. Your files are never modified. The score is rendered with [webmscore](https://github.com/LibreScore/webmscore), which is based on MuseScore 4.0, so it's possible for a score saved by a newer MuseScore to render slightly differently from how it looks there. If a score needs it, Lyrica offers to upgrade it in memory first.

### Practice tools

- **Loop.** Drag across measures to repeat just that range. Loops follow the music as played, so they're correct through repeats and D.C./D.S. jumps.
- **Speed.** 0.5×, 0.75× or 1×. The cursor stays in sync with the audio.
- **Metronome.** A click derived from the score's time signatures and tempo changes, with an accented downbeat.
- **Markers.** Write directly on the sheet: text notes (`T`) and fingerings (`G`). Click to place one, click again to edit, drag to move. They're saved per score and scale with zoom.
- **Pieces index.** If a file holds several pieces (a collection, a soundtrack), Lyrica detects them and lets you jump between them.
- **Library.** Browse a folder of scores, pin favourites, see recents, and rate each piece from 1 (never seen it) to 5 (can play it any time) to filter by level.
- **PDF mode.** For music you only have as a PDF. You mark where each measure sits (an optional barline detector helps), which gives you loops and a metronome. A PDF has no note data, so there is no audio of the notes.
- **Reader.** Tabs, zoom / fit width / fit height, two-page book view, a distraction-free view, and Light / Dark / Paper themes.

Audio is synthesized with MuseScore's General soundfont. It takes a couple of seconds to load at startup. Until then you'll only hear the metronome.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `Esc` | Put down the marker tool, otherwise stop |
| `M` | Metronome on / off |
| `T` / `G` | Text / fingering marker tool |
| `F` | Distraction-free view |
| `←` `→` | Previous / next page |

### Your data

Everything stays on your machine, with no account and no network use apart from the update check. Markers, ratings, pieces indexes and PDF calibrations live in the app data directory (`~/.local/share/org.hawawa.lyrica` on Linux). They're keyed by a hash of the file's contents, so renaming or moving a score doesn't lose them. Editing a score does.

## Developing Lyrica

### Layout

| Path | What it is |
| --- | --- |
| `web/` | Vite + TypeScript frontend, which runs in the Tauri webview. Score and PDF rendering happens here: webmscore (WASM) renders `.mscz` and exports measure positions and MIDI, and pdf.js renders PDFs. Rust never parses `.mscz` or MIDI itself. |
| `crates/core` (`mp-core`) | Shared Rust logic with no Tauri or axum imports: playback timeline, audio synthesis ([oxisynth](https://github.com/PolyMeilex/oxisynth)), markers and library persistence, the updater. |
| `crates/desktop` | The Tauri 2 shell. Thin `#[tauri::command]` wrappers over `mp-core`, plus the audio output thread. |
| `crates/cv-barline` | Classical (non-ML) barline detection for PDF mode. |
| `crates/server` | Placeholder for a future axum shell. Not functional. |
| `site/` | The landing page (Astro), built into a Docker image. Independent of the app. |
| `scripts/` | One-off asset tooling (e.g. cutting the metronome clicks). |

How a score becomes playable: webmscore lays out the score and reports measure positions and a MIDI export. `mp-core` combines those into a `Timeline` (what's played when, with repeats unrolled), and the synth plays the MIDI through the soundfont while the frontend moves the cursor from the timeline.

### Prerequisites

[Rust](https://rustup.rs), Node.js 22+, [`just`](https://github.com/casey/just), the [Tauri CLI](https://tauri.app/reference/cli/) (`cargo install tauri-cli --version '^2'`), the [Tauri Linux system libraries](https://tauri.app/start/prerequisites/#linux), and ALSA headers (`libasound2-dev`).

### Run it

```sh
(cd web && npm install)
just fetch-soundfont     # ~40 MB GM soundfont, sha256-checked, not in git
just fetch-cjk-font      # Noto Sans JP, so CJK titles render (not in git)
just dev                 # desktop app with hot-reloading frontend
```

The soundfont and font are needed even to build or lint the desktop crate, so fetch them first.

### Common tasks

| Command | Does |
| --- | --- |
| `just test` | Rust test suite. Audio tests skip if no soundfont is present. |
| `just web-build` | Typecheck and build the frontend. |
| `just build-release` | Release binary without installers. |
| `just release` | Build the `.deb` and `.AppImage` into `target/release/bundle/`. |
| `just install-dev-desktop` | Install a `.desktop` entry so unpackaged builds get the app icon on Wayland. |

`just` with no arguments lists every recipe. Landing page: `cd site && npm install && npm run dev`, or `docker build -t lyrica-site site/`.

CI runs on every push and PR: `cargo fmt --check`, `clippy -D warnings`, the Rust tests, the frontend typecheck and build, the landing page build, and an actionlint pass over the workflows.

### Before you change things

Several parts of this codebase depend on non-obvious behaviour of webmscore, the soundfont and the audio stack, such as a stubbed-out `version()`, a crashing `segmentPositions()`, MIDI/measure-time disagreements, and `!Send` audio streams. They're documented in [CLAUDE.md](CLAUDE.md#known-gotchas). Read that before touching the timeline, the score engine or the audio path.

### Releasing

1. Set the same version in `Cargo.toml` (`[workspace.package]`), `crates/desktop/tauri.conf.json` and `web/package.json`. The updater compares against this version, so it must match the tag.
2. Merge to `main`, then run the **Release** workflow from the Actions tab (or push a matching `vX.Y.Z` tag).

The workflow checks that the versions agree, re-runs CI, builds the bundles, creates the tag and GitHub release with generated notes and `SHA256SUMS.txt`, and publishes the landing-page image to `ghcr.io/hawawa4/lyrica-site`. The updater relies on the asset names (`Lyrica_<version>_amd64.{AppImage,deb}`) and the checksum file, so keep those if you change the workflow.

## Credits and licence

Lyrica is free software under the [GNU GPL v3](LICENSE). It builds on [webmscore](https://github.com/LibreScore/webmscore) (GPL-3.0), [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) and [oxisynth](https://github.com/PolyMeilex/oxisynth) (LGPL-2.1), and bundles the [MuseScore_General soundfont](assets/MuseScore_General_License.md) (MIT) and Noto Sans JP (OFL).
