# Spike findings (Part 1 of IMPLEMENTATION_PLAN.md)

**Result: PASS.** Overlay boxes align with real measure boundaries (confirmed
visually by user) for both the native-MS4 fixture (Dark Side Of Fate) and the
upgraded-from-MS2 fixture (Youkai Mountain). Drag-rect selection picks the
visually correct measures. `events[].position` is monotonically increasing and
matches `metadata().duration` (e.g. darkside: last event at 158477ms vs
duration 160s).

## Environment gotchas (Node 22, apply when porting into web/ in Phase 1)

webmscore 1.2.1's bundled Node glue code predates Node 22's built-in globals
and breaks without two workarounds (see `_spike/shim-preload.cjs`):

1. `globalThis.navigator` is read-only in Node 22; webmscore's DOM shim does
   `globalthis.navigator = globalthis.navigator || {}`, which throws even
   though the assigned value is unchanged. Fix: redefine `navigator` as a
   writable/configurable property before webmscore loads.
2. Node 22 has a built-in global `fetch`. webmscore's emscripten glue checks
   `typeof fetch === "function"` to pick browser-style `fetch()` wasm loading
   over `fs.readFileSync`, and passes a bare filesystem path — which Node's
   undici `fetch` rejects as an invalid URL. Fix: `delete globalThis.fetch`
   before webmscore loads.

**This almost certainly does NOT apply to Phase 1+**, since webmscore there
runs inside a browser webview (Tauri) or an actual browser tab (axum/server),
not Node — both have real `navigator`/`fetch` already and the browser-path
glue code (not the Node-path glue) is what's exercised. Flagging only in case
any future tooling (build scripts, SSR, test runners) loads webmscore under
plain Node.

## `segmentPositions()` is broken in webmscore 1.2.1

Calling `score.segmentPositions()` throws `RuntimeError: null function or
function signature mismatch` from inside the wasm module, reproducibly, on
both fixtures (native-MS4 and upgraded-from-MS2). `measurePositions()` works
fine on both. This looks like a real bug in the published 1.2.1 wasm binary
(the signature mismatch is a wasm-level table/vtable issue, not something
fixable from our side without patching/rebuilding webmscore itself).

**Impact on the plan:** none for Phase 3 (measure-range selection) — the
"essential" interaction only needs `measurePositions()`, which is confirmed
working. `segmentPositions()` was mentioned as a finer-grained fallback for
sub-measure precision; that fallback is NOT available as-is. If sub-measure
(beat-level) precision is ever needed, re-derive from note positions instead,
or investigate pinning a differently-built webmscore version.

## Files in this directory

- `dump.mjs` — spike script (Node, run via `node --require ./shim-preload.cjs dump.mjs [youkai|darkside]`)
- `shim-preload.cjs` — Node-22 compat shims described above, Node-only, throwaway
- `view.html` — overlay + drag-select visual harness, served via `python3 -m http.server`
- `fixtures/` — copies of the two test .mscz files + upgraded output + `out/*.svg`, `out/*.json`

This entire directory is disposable per the plan. Only the ~10-20 lines of
validated bbox/drag-select math get rewritten (not copy-pasted) into
`web/src/render/SelectionOverlay.ts` in Phase 3.
