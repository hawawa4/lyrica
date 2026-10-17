# MusePractice dev tasks.

# Byte-identical to the Debian fluid-soundfont-gm package's FluidR3_GM.sf2
# (confirmed via matching content-length: 148398306). Used instead of
# MuseScore's own MuseScore_General.sf2/.sf3 — see crates/desktop/src/main.rs
# for why (MuseScore_General.sf2 renders at a fraction of the volume through
# rustysynth; .sf3 isn't supported by rustysynth at all).
soundfont_url := "https://github.com/pianobooster/fluid-soundfont/releases/download/v3.1/FluidR3_GM.sf2"

# Noto Sans JP, extracted from Google/Adobe's Noto CJK release zip. webmscore's
# bundled fonts (Edwin/FreeSerif/FreeSans/MuseJazz/mscore) have zero CJK glyph
# coverage — titles/lyrics containing Japanese/Chinese/Korean text render as
# completely blank — and unlike desktop MuseScore (which falls back to the host
# OS's font-fallback via Qt/fontconfig), webmscore's sandboxed WASM build can't
# substitute a system font on its own. webmscore's `WebMscore.load()` has a
# `fonts` param made exactly for this: extra font files loaded into its virtual
# filesystem. Confirmed empirically this font fixes rendering (see
# during development).
cjk_font_url := "https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/16_NotoSansJP.zip"

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

# Fetch the CJK font used so webmscore can render Japanese/Chinese/Korean
# title/lyric text (not committed to git — ~4.5MB).
fetch-cjk-font:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p web/public/vendor/fonts
    dest="web/public/vendor/fonts/NotoSansJP-Regular.otf"
    if [ -f "$dest" ]; then
        echo "already present: $dest"
        exit 0
    fi
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    echo "fetching NotoSansJP from {{cjk_font_url}}..."
    curl -fL -o "$tmpdir/font.zip" "{{cjk_font_url}}"
    unzip -j -o "$tmpdir/font.zip" "NotoSansJP-Regular.otf" -d "web/public/vendor/fonts"
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

# Build the release installers: a .deb and an .AppImage, in target/release/bundle/.
# Fetches the soundfont (bundled as a resource) and CJK font (bundled into the
# frontend) first, both no-ops when already present.
release: fetch-soundfont fetch-cjk-font
    cargo tauri build --bundles deb,appimage
    @echo
    @echo "Release bundles:"
    @ls -1sh target/release/bundle/deb/*.deb target/release/bundle/appimage/*.AppImage
