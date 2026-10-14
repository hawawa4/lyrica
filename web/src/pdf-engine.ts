import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'

// pdf.js needs its worker script served as a static file (it's spun up via
// `new Worker(workerSrc)`, not bundled inline) — vendored directly under
// public/vendor/pdfjs/ and committed to git, same precedent as webmscore's
// runtime files (web/public/vendor/webmscore/, ~23MB, also committed
// directly rather than fetched at build time — see that directory's history).
// Unlike webmscore, `pdf.mjs` itself is an ordinary ESM module with no
// `.toString()`-based worker bootstrapping quirk, so it's imported normally
// above rather than via a vendored runtime + dynamic import.
GlobalWorkerOptions.workerSrc = new URL('/vendor/pdfjs/pdf.worker.mjs', window.location.origin).href

export type PdfDocument = PDFDocumentProxy

export async function loadPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const task = getDocument({ data: bytes })
  return task.promise
}

/**
 * Renders one page to a freshly-created canvas at the given CSS display
 * width (height follows the page's own aspect ratio), returning the canvas
 * for the caller to mount. Each call renders fresh — unlike PageView's
 * cached SVG strings for webmscore (vector, cheap to keep many of), a
 * rendered PDF canvas is a raster bitmap sized to the container; callers
 * wanting a cache should keep the canvas element around themselves rather
 * than re-deriving cache logic here.
 *
 * The canvas's backing pixel buffer is rendered at `cssWidth * devicePixelRatio`
 * (with explicit CSS `width`/`height` set to the un-multiplied `cssWidth`) —
 * rendering at exactly `cssWidth` and letting the browser's own CSS scaling
 * stretch it would blur the page on any HiDPI display, same reasoning as
 * drawing any canvas content crisply at a given CSS size.
 */
export async function renderPdfPage(doc: PdfDocument, pageNumber: number, cssWidth: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber)
  const baseViewport = page.getViewport({ scale: 1 })
  const pixelRatio = window.devicePixelRatio || 1
  const scale = (cssWidth * pixelRatio) / baseViewport.width
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.className = 'pdf-canvas'
  canvas.width = viewport.width
  canvas.height = viewport.height
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssWidth * (viewport.height / viewport.width)}px`
  canvas.style.display = 'block'
  const context = canvas.getContext('2d')
  if (!context) throw new Error('renderPdfPage: failed to get 2d canvas context')

  await page.render({ canvas, canvasContext: context, viewport }).promise
  return canvas
}

/**
 * Extracts a rendered PDF page canvas's pixels as PNG bytes, for handing to
 * the optional CV barline-detection assist (`crates/cv-barline`, called via
 * `detectBarlines` in api-client.ts) — same "render to canvas, export bytes,
 * hand across the API boundary" pattern Phase 4 uses for MIDI/positions
 * data. Rust never touches the canvas/DOM directly.
 */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvasToPngBytes: canvas.toBlob() returned null')
  return new Uint8Array(await blob.arrayBuffer())
}
