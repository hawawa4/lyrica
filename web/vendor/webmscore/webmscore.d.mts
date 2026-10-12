// Type declarations for the vendored webmscore browser runtime
// (`./webmscore.mjs`).
//
// TypeScript resolves a sibling `<name>.d.ts` next to a same-named JS file
// automatically (this is NOT an ambient `declare module '...'` — those only
// work with bare/non-relative specifiers, so a relative-path ambient
// declaration would silently be ignored). Keeping this file co-located with
// `webmscore.mjs` means plain `import WebMscore from './webmscore.mjs'` (or
// `../vendor/webmscore/webmscore.mjs` from elsewhere) is typed with no
// further configuration.
//
// `webmscore.mjs` ships as plain, mostly-minified JS with no accompanying
// `.d.ts`. The upstream package *does* ship hand-written types at
// `webmscore/src/index.d.ts` + `webmscore/schemas.ts`, but those describe the
// unwrapped `WebMscore` class (the Node/direct-Wasm variant). The browser
// build's default export is actually `WebMscoreW`, a same-shaped Web-Worker
// proxy (see `webmscore/src/worker-helper.js`): every instance method is
// still present, just proxied over `postMessage` RPC, and the public API
// surface (per `webmscore/README.md` and `src/index.d.ts`) is identical.
//
// We mirror that public surface here by hand, using the vendored
// `schemas.ts` types, so this declaration is self-contained within
// `web/vendor/webmscore/` and doesn't reach into `node_modules` typings.

import type { InputFileFormat, Positions, ScoreMetadata, SynthRes } from './schemas'

export default class WebMscore {
  /** Resolves once the engine (worker + wasm) has finished initializing. */
  static get ready(): Promise<void>

  /** The maximum MSCZ/MSCX file format version supported, e.g. `410`. */
  static version(): Promise<number>

  static setLogLevel(level: 0 | 1 | 2): Promise<void>

  static load(
    format: InputFileFormat,
    data: Uint8Array,
    fonts?: Uint8Array[] | Promise<Uint8Array[]>,
    doLayout?: boolean,
  ): Promise<WebMscore>

  private constructor()

  setExcerptId(id: number): Promise<void>
  getExcerptId(): Promise<number>
  generateExcerpts(): Promise<void>

  title(): Promise<string>
  titleFilenameSafe(): Promise<string>
  npages(): Promise<number>

  metadata(): Promise<ScoreMetadata>
  measurePositions(): Promise<Positions>
  segmentPositions(): Promise<Positions>

  saveXml(): Promise<string>
  saveMxl(): Promise<Uint8Array>
  saveMsc(format?: 'mscz' | 'mscx'): Promise<Uint8Array>
  saveSvg(pageNumber?: number, drawPageBackground?: boolean): Promise<string>
  savePng(pageNumber?: number, drawPageBackground?: boolean, transparent?: boolean): Promise<Uint8Array>
  savePdf(): Promise<Uint8Array>
  saveMidi(midiExpandRepeats?: boolean, exportRPNs?: boolean): Promise<Uint8Array>

  setSoundFont(data: Uint8Array): Promise<void>
  saveAudio(format: 'wav' | 'ogg' | 'flac' | 'mp3'): Promise<Uint8Array>
  synthAudio(starttime: number): Promise<(cancel?: boolean) => Promise<SynthRes>>
  synthAudioBatch(starttime: number, batchSize: number): Promise<(cancel?: boolean) => Promise<SynthRes[]>>

  savePositions(ofSegments: boolean): Promise<string>
  saveMetadata(): Promise<string>

  destroy(soft?: boolean): void
}
