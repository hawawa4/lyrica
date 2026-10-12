// Node 22+ ships a read-only `navigator` global. webmscore's bundled DOM shim
// does `globalthis.navigator = globalthis.navigator || {}`, which throws
// against a getter-only property even though the value is unchanged.
// Redefine it as a plain writable/configurable property before webmscore loads.
Object.defineProperty(globalThis, 'navigator', {
  value: globalThis.navigator,
  writable: true,
  configurable: true,
  enumerable: true,
})

// Node 22+ ships a global `fetch`. webmscore's emscripten glue checks
// `typeof fetch === "function"` to decide whether to load its .wasm via
// browser-style fetch() (given a bare filesystem path, which Node's undici
// fetch rejects as an invalid URL) or via fs.readFileSync (the Node path).
// Removing global fetch forces it down the Node/readFileSync branch.
delete globalThis.fetch
