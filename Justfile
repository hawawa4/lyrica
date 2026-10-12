# MusePractice dev tasks.

# Byte-identical to the Debian fluid-soundfont-gm package's FluidR3_GM.sf2
# (confirmed via matching content-length: 148398306). Used instead of
# MuseScore's own MuseScore_General.sf2/.sf3 — see crates/desktop/src/main.rs
# for why (MuseScore_General.sf2 renders at a fraction of the volume through
# rustysynth; .sf3 isn't supported by rustysynth at all).
soundfont_url := "https://github.com/pianobooster/fluid-soundfont/releases/download/v3.1/FluidR3_GM.sf2"

# Running `just` with no recipe name lists everything (default Justfile convention).
default:
    @just --list

# Fetch the GM soundfont used for audio playback (not committed to git — it's ~148MB).
fetch-soundfont:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p assets
    dest="assets/FluidR3_GM.sf2"
    if [ -f "$dest" ]; then
        echo "already present: $dest"
        exit 0
    fi
    echo "fetching FluidR3_GM.sf2 from {{soundfont_url}}..."
    curl -fL -o "$dest" "{{soundfont_url}}"
    echo "saved to $dest"

# Run the full Rust test suite (audio tests skip gracefully without a soundfont).
test:
    cargo test --workspace

# Typecheck + build the web/ frontend.
web-build:
    cd web && npx tsc -b && npx vite build

# Run the desktop app in dev mode (hot-reloading frontend).
dev:
    cargo tauri dev

# Build a debug desktop binary without packaging installers.
build-debug:
    cargo tauri build --debug --no-bundle

# Build a release (production) desktop binary without packaging installers — rules out dev-server-only behavior.
build-release:
    cargo tauri build --no-bundle
