# Lyrica

[![CI](https://img.shields.io/github/actions/workflow/status/hawawa4/lyrica/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/hawawa4/lyrica/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hawawa4/lyrica?logo=github)](https://github.com/hawawa4/lyrica/releases)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)
[![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-2021-orange?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux-informational?logo=linux&logoColor=white)](https://lyrica.hawawa.org)
[![Website](https://img.shields.io/badge/website-lyrica.hawawa.org-8A2BE2)](https://lyrica.hawawa.org)

**Practice from the score you already have.**  
[lyrica.hawawa.org](https://lyrica.hawawa.org)

Lyrica opens your [MuseScore](https://musescore.org) `.mscz` files like a PDF reader (not an editor) and adds the things you reach for while learning a piece: loop a hard passage, slow it down, play along with a click, and keep track of what you've practised.

> **Not affiliated with MuseScore.** Lyrica is an independent project. It has no affiliation, association, endorsement or connection of any kind with the MuseScore team, the MuseScore project, or Muse Group. "MuseScore" is a trademark of its respective owners and is used here only to say which file format Lyrica can open.

## Features

- **Loop selection.** Drag across measures and just that range repeats. Loops follow the music as performed, so they're correct through repeats and D.C./D.S. jumps.
- **Speed control.** 0.5×, 0.75× or 1×, with the cursor staying in sync with the audio.
- **Metronome.** A click generated from the score's time signatures and tempo changes, with the downbeat accented.
- **Markers.** Attach a short note to a measure ("watch the fingering"). Saved per score.
- **Pieces index.** Detects when one file contains several pieces (soundtrack albums, collections) and lets you jump between them.
- **Library.** Browse a folder of scores, pin favourites, see recents, and rate each piece 1 (never seen it) to 5 (can play it anytime), then filter by level.
- **PDF mode.** For scores you only have as a PDF: mark where each measure sits (with an optional barline-detection assist) to get loops and a metronome. There's no audio of the notes, since a PDF has no note data.
- **Reader niceties.** Multiple tabs, zoom / fit width / fit height, two-page book mode, a distraction-free view, and Light / Dark / Paper themes.

Your original files are never modified. Scores saved by an older MuseScore are upgraded in memory, after you confirm.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `Esc` | Stop |
| `M` | Toggle metronome |
| `F` | Distraction-free view |
| `←` `→` | Previous / next page |

## Install

Download the latest `.deb` or `.AppImage` from the [releases page](https://github.com/hawawa4/lyrica/releases/latest).

```sh
# Debian / Ubuntu
sudo apt install ./Lyrica_*.deb

# Any distro
chmod +x Lyrica_*.AppImage && ./Lyrica_*.AppImage
```

Only Linux builds are published for now. The app is built on [Tauri](https://tauri.app), so other platforms should be feasible but haven't been tested.

## Where your data lives

Everything is local: no account, no cloud. Markers, ratings, pieces indexes and PDF calibrations are stored in the app's data directory, keyed by a hash of the file's contents, so they survive renaming or moving a score.

## Building from source

You need [Rust](https://rustup.rs), Node.js 22+, [`just`](https://github.com/casey/just), the [Tauri CLI](https://tauri.app/reference/cli/) (`cargo install tauri-cli --version '^2'`) and the [Tauri system libraries](https://tauri.app/start/prerequisites/#linux) plus ALSA headers (`libasound2-dev`).

```sh
just fetch-soundfont     # GM soundfont for playback (~40 MB, not in git)
just fetch-cjk-font      # so Japanese/Chinese/Korean titles render
(cd web && npm install)

just dev                 # run the desktop app with hot reload
just test                # Rust test suite
just release             # build the .deb and .AppImage into target/release/bundle/
```

Run `just` with no arguments to list every recipe.

### How it's put together

| Path | What |
| --- | --- |
| `web/` | Vite + TypeScript frontend. [webmscore](https://github.com/LibreScore/webmscore) renders scores and exports measure positions and MIDI in the webview; PDFs render via pdf.js. |
| `crates/core` | Shared Rust logic: playback timeline, audio synthesis ([oxisynth](https://github.com/PolyMeilex/oxisynth)), markers, library, persistence. |
| `crates/desktop` | The Tauri 2 shell: thin commands over `crates/core`. |
| `crates/cv-barline` | Classical computer-vision barline detection for PDF mode. |
| `crates/server` | Placeholder for a future web-server shell. Not functional. |
| `site/` | The [landing page](site/) (Astro), shipped as a Docker image. |

See [CLAUDE.md](CLAUDE.md) for the non-obvious gotchas (webmscore quirks, soundfont choice, etc.).

### Landing page

```sh
cd site && npm install && npm run dev                  # develop
docker build -t lyrica-site site/                # static site in nginx
docker run --rm -p 8080:8080 lyrica-site
```

Tagged releases also publish the image to `ghcr.io/hawawa4/lyrica-site`.

## Releasing

CI (`.github/workflows/ci.yml`) runs `cargo fmt`, `clippy -D warnings`, the Rust tests, the frontend typecheck/build and the landing-page build on every push and PR.

To cut a release, bump the version in `Cargo.toml` (`[workspace.package]`), `crates/desktop/tauri.conf.json` and `web/package.json`, merge to `main`, then run the **Release** workflow from the Actions tab (or push a matching `vX.Y.Z` tag). It checks that the versions agree, re-runs CI, builds the bundles, creates the tag and GitHub release with generated notes and checksums, and publishes the landing-page image.

## Credits and licence

Lyrica is free software under the [GNU GPL v3](LICENSE). It builds on [webmscore](https://github.com/LibreScore/webmscore) (GPL-3.0), [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0), [oxisynth](https://github.com/PolyMeilex/oxisynth) (LGPL-2.1), and ships the [MuseScore_General soundfont](assets/MuseScore_General_License.md) (MIT) and Noto Sans JP (OFL).

## Disclaimer

Lyrica is an independent, community project. It is not made, sponsored, endorsed or supported by the MuseScore team, the MuseScore project or Muse Group, and has no affiliation with them in any way. "MuseScore" and `.mscz` are mentioned only to describe file compatibility. Lyrica reads the MuseScore file format using the open-source webmscore library.
