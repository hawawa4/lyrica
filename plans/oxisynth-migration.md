# Deferred: replace rustysynth with OxiSynth

**Status:** deferred — not scheduled into any phase of `IMPLEMENTATION_PLAN.md`. Revisit only after the main app/interaction work is done, as a standalone audio-quality pass. Do not start this unprompted.

## Why

The app currently bundles `FluidR3_GM.sf2` instead of MuseScore's own soundfont (`MuseScore_General.sf2`/`.sf3`) because `rustysynth` — the Rust synth crate used for audio playback — has **zero SF2 modulator support**: confirmed directly in its source (`soundfont_parameters.rs`), the `pmod`/`imod` chunks are parsed and then discarded. MuseScore's soundfont relies heavily on key-driven modulators to compensate for deliberately-attenuated baseline generator values; without those modulators applied, notes render with only the "closed/attenuated" half of the intended signal — quiet and bass-only. FluidR3 doesn't lean on modulators, so it plays correctly as a fallback, but sounds more generic/dated than MuseScore's own soundfont by comparison.

Full root-cause diagnosis is in `CLAUDE.md` ("Soundfont" section) and was reached by: a controlled A/B render test comparing peak amplitude/frequency content between the two soundfonts using identical player code (ruled out bugs in our own cpal/output code), then a background research pass reading rustysynth's actual source to confirm the modulator gap, rather than guessing.

## Research findings (as of this writing)

Evaluated four options for a replacement synth backend, hard constraint: must be embeddable directly in the app binary, no external software install beyond what's already required (e.g. ALSA dev headers, already needed by `cpal`).

| Option | Solves modulators? | sf3? | No-install embeddable? | Effort |
|---|---|---|---|---|
| **FluidSynth** (real libfluidsynth via Rust bindings) | Yes | Yes | No maintained Rust binding exists — would need building one from scratch (bindgen + vendored/static glib) | Substantial: days–weeks, cross-platform glib static-linking is notoriously painful (esp. Windows) |
| **TinySoundFont** | **No** — modulators explicitly listed as "NOT YET IMPLEMENTED" in the upstream header, author has said a modulator implementation "would need a large rewrite" | No | N/A | Pointless for this problem — skip entirely |
| **rustysynth-ext** (fork of rustysynth, adds sf3) | **No** — confirmed via source read: `pmod`/`imod` chunks still discarded identically to upstream, fork only adds Ogg-Vorbis sample decoding via `lewton` | Yes | Yes (pure Rust) | Trivial (drop-in rename), but doesn't fix the actual problem |
| **OxiSynth** (`PolyMeilex/oxisynth`) | **Yes** — verified in source: a real, faithful port of FluidSynth/FluidLite's `fluid_mod_get_value` (SF2.01 §8.4 curve math), all 10 default modulators present and wired into voice setup | Yes (same `lewton` pure-Rust Ogg decoder) | Yes — pure Rust, zero C dependency, same deployability as rustysynth today; has a demonstrated (if not fully proven) WASM build path via `wasm-bindgen` + `cpal`'s wasm feature | Moderate: ~1-3 days of focused rewrite, see below |

**OxiSynth is the only option that both fixes the problem and respects the no-install constraint.**

### OxiSynth specifics worth knowing before starting

- **Not a drop-in replacement.** Its API differs from `rustysynth::{MidiFile, MidiFileSequencer, SoundFont, Synthesizer, SynthesizerSettings}` — it doesn't ship its own MIDI-file sequencer the way rustysynth's `MidiFileSequencer` does. Note-on/off scheduling would likely need to be driven ourselves. This project may already have reusable groundwork: `crates/core/src/timeline.rs` already parses MIDI (via the `midly` crate) to extract the tempo map, and that parsing logic could plausibly be extended/reused for event scheduling against OxiSynth's lower-level API.
- **Scope of the rewrite**: `crates/core/src/audio/synth.rs` (the `Player` wrapper around rustysynth) and `crates/core/src/audio/output_cpal.rs` (the cpal output stream — this part should need little to no change, since it already treats the synth as an opaque `render(left, right)` producer) would need rework. `crates/desktop/src/audio_state.rs` (the Tauri-side state holding the player + output stream + its `!Send+!Sync` cpal::Stream workaround) should be largely unaffected, since that's about cpal/threading, not the synth internals.
- **Maintenance status**: small team (~1 primary author), last commit roughly 11 months before this research — not abandoned, but slower-moving than rustysynth. Worth re-checking activity before starting, and worth treating as forkable/vendorable (it's small) if it's gone stale by the time this is picked up.
- **License**: LGPL-2.1 (inherited from the FluidSynth/FluidLite lineage) — compatible alongside this project's GPLv3 choice.

### Ruled out in more detail

- **TinySoundFont**: its own Rust wrapper crate (`tsf`) is also stale (last published 2021, explicitly WIP) — doubly not worth pursuing since the underlying C library doesn't solve the actual problem anyway.
- **libfluidsynth**: the one existing Rust binding crate (`fluidsynth` on crates.io) has had no commits since 2019 and is effectively dead. **FluidLite** (a stripped-down, glib-free C fork of FluidSynth that *does* implement real modulators) is a real middle ground — it has an embeddable, `cc`-crate-based Rust binding (`fluidlite-rs`) that compiles FluidLite's C sources in-tree with zero external deps (even sf3 support via an embedded single-header Vorbis decoder). But that Rust binding itself is unmaintained (no commits since Jan 2023, an unresolved WASM-support issue open since 2022) — using it would mean effectively adopting/forking an abandoned wrapper. Worth a second look if OxiSynth turns out to be a dead end, but OxiSynth is the better first choice since it needs no C toolchain integration at all.

## How to pick this up

1. Re-verify OxiSynth's crates.io/GitHub activity hasn't gone fully dormant since this was written.
2. Re-read its current source for the modulator implementation directly (don't trust this summary blindly after a long gap — code can change).
3. Port `crates/core/src/audio/synth.rs`'s `Player` to drive OxiSynth instead of rustysynth, including MIDI event scheduling (reuse the `midly`-based parsing already in `crates/core/src/timeline.rs` if it fits).
4. Swap `MuseScore_General.sf2` back in as the bundled soundfont once the new backend is in place.
5. **Re-run the same A/B verification** that diagnosed the original problem: compare peak amplitude and a zero-crossing-rate (frequency-content) proxy between the old FluidR3 baseline and the new MuseScore_General-via-OxiSynth render, using identical MIDI input — confirm the modulator-driven timbre now renders correctly rather than assuming it does because the library claims to support modulators.
6. Update `CLAUDE.md`'s "Soundfont" section once this lands.
