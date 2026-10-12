// `webmscore.mjs` and its sibling .wasm/.data binaries live in `public/vendor/webmscore/`
// (not under `src/`, and not imported as a normal bundler module) so Vite's publicDir
// mechanism copies them byte-for-byte into `dist/` and serves them byte-for-byte in dev
// — both required, because the module's Web-Worker wrapper (`WebMscoreW`) builds its
// worker by `.toString()`-ing a big inlined function and running the resulting source
// inside a Blob URL (see node_modules/webmscore/src/worker-helper.js). If Rollup/Terser
// ever bundled or minified this file, that `.toString()`'d source would get mangled
// (renamed locals, reformatted code) and the worker would break at runtime in ways that
// are easy to miss in a quick smoke test — confirmed empirically: a naive static
// `import WebMscore from '...'` got inlined+minified into the app bundle by `vite build`
// and broke (the .wasm/.data files were also silently left out of `dist/` entirely,
// since nothing referenced them via an import Rollup could see).
//
// So instead we load it with a plain runtime `import()` of its public URL (with
// `@vite-ignore` so Vite's static import analysis/bundler never touches it), and only
// use the colocated `vendor/webmscore/webmscore.d.mts` declaration file for
// compile-time types (type-only imports are fully erased, so this never pulls the
// runtime module into the bundle).
import type WebMscoreCtor from '../vendor/webmscore/webmscore.mjs'
import type { Positions, ScoreMetadata } from '../vendor/webmscore/schemas'

export type { Positions, ScoreMetadata, PositionElement } from '../vendor/webmscore/schemas'
export type WebMscore = WebMscoreCtor

let webmscoreCtorPromise: Promise<typeof WebMscoreCtor> | null = null

/**
 * Dynamically import the vendored webmscore module exactly once, and cache the promise.
 *
 * This must be an *absolute* URL (`http://host/vendor/...`), not a root-relative path
 * (`/vendor/...`). Vite's dev server refuses to serve anything under `publicDir` through
 * its own module loader — including a dynamic `import()` of a root-relative path, even
 * with `@vite-ignore` — specifically because public assets are supposed to never go
 * through Vite's transform pipeline (confirmed empirically: a root-relative import hit
 * "this file is in /public ... should not be imported from source code"). Resolving to a
 * full absolute URL first makes this an ordinary cross-origin-shaped dynamic import that
 * the browser's native ES module loader handles directly, bypassing Vite's dev-server
 * module graph entirely — which also means it behaves identically in dev, in the built
 * `dist/` output, and once served from Tauri's or axum's own static file serving later.
 */
function loadWebMscoreCtor(): Promise<typeof WebMscoreCtor> {
  if (!webmscoreCtorPromise) {
    const url = new URL('/vendor/webmscore/webmscore.mjs', window.location.origin)
    webmscoreCtorPromise = import(/* @vite-ignore */ url.href).then(
      (mod) => mod.default as typeof WebMscoreCtor,
    )
  }
  return webmscoreCtorPromise
}

/** Resolves once the module is fetched *and* the engine (worker + wasm) is initialized. */
async function ensureReady(): Promise<typeof WebMscoreCtor> {
  const WebMscore = await loadWebMscoreCtor()
  await WebMscore.ready
  return WebMscore
}

export interface OpenScoreResult {
  score: WebMscore
  needsUpgrade: boolean
  metadata: ScoreMetadata
}

/**
 * The webmscore engine's own native MSCZ/MSCX file format version.
 *
 * `WebMscore.version()` *should* report this at runtime, but the Web-Worker
 * wrapper (`WebMscoreW`, which is what the browser build's default export
 * actually is — see `vendor/webmscore/webmscore.d.mts`) ships `version()` as
 * a dead stub that always returns `-1` and never proxies the call into the
 * worker (confirmed in `node_modules/webmscore/src/worker-helper.js`).
 * Comparing against that stub would make every file look up-to-date, which
 * is the opposite of what we want.
 *
 * Empirically confirmed instead via the two fixtures in `_spike/fixtures/`:
 * a native MS4 file (`Dark Side Of Fate.mscz`) reports `metadata.fileVersion
 * === 450` after round-tripping through this exact webmscore 1.2.1 build, so
 * 450 is this engine's current/native format version for our purposes.
 */
const ENGINE_FILE_VERSION = 450

/**
 * Load a .mscz file's bytes, report whether its format version is below the
 * engine's own (MS4), and return its metadata. Does not upgrade automatically
 * — callers must show a confirmation prompt and call `upgradeScore` themselves
 * (see IMPLEMENTATION_PLAN.md Phase 1: "never write back over the original file").
 */
export async function openScore(bytes: Uint8Array): Promise<OpenScoreResult> {
  const WebMscore = await ensureReady()
  const score = await WebMscore.load('mscz', bytes, [], true)
  const metadata = await score.metadata()
  const needsUpgrade = metadata.fileVersion < ENGINE_FILE_VERSION
  return { score, needsUpgrade, metadata }
}

/**
 * Re-save the score in MS4 format. The caller is responsible for persisting
 * the result only in the app's own cache (keyed by the *original* file's
 * content hash), never writing it back over the user's original file.
 */
export async function upgradeScore(score: WebMscore): Promise<Uint8Array> {
  return score.saveMsc('mscz')
}

export async function renderPage(score: WebMscore, pageIndex: number): Promise<string> {
  return score.saveSvg(pageIndex, true)
}

export async function getMeasurePositions(score: WebMscore): Promise<Positions> {
  return score.measurePositions()
}

/**
 * Raw MIDI bytes for the fully-performed piece (repeats inlined). Note the
 * `midiExpandRepeats` flag itself has no observable effect in this webmscore
 * build (confirmed empirically: identical output with it true vs false) —
 * but the exported note data is already the fully-performed version either
 * way, so this is moot in practice. Kept `true` to match the documented
 * intent in case a future webmscore build fixes the flag.
 */
export async function getMidi(score: WebMscore): Promise<Uint8Array> {
  return score.saveMidi(true, false)
}
