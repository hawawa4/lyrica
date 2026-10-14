import { renderPage, getMeasurePositions, type WebMscore, type Positions } from '../score-engine'

export const ZOOM_STEP = 0.1
export const MIN_ZOOM = 0.3
export const MAX_ZOOM = 3

/** CSS px width at 100% zoom — the SVG is sized in absolute px (not a %) so it has a real intrinsic size inside a flex-centered `.page-stage`, instead of a 0-width collapse (a percentage width has nothing to resolve against there). */
const BASE_WIDTH_PX = 700

/**
 * Paged, vertical page-by-page display of a score. Caches each rendered SVG
 * page in memory per score instance, so repeat navigation (going back to a
 * page already visited) never re-calls `saveSvg` — the "pages cached once
 * rendered" snappiness requirement from IMPLEMENTATION_PLAN.md Phase 2.
 */
export class PageView {
  private score: WebMscore | null = null
  private pageCount = 0
  private currentPage = 0
  private readonly cache = new Map<number, string>()
  private positions: Positions | null = null
  private readonly svgLayer: HTMLDivElement
  private zoom = 1

  /**
   * `container` is shared with SelectionOverlay (both render into the same
   * stage element: the SVG goes underneath, the selection boxes/drag-rect sit
   * on top). PageView owns its own dedicated child for the SVG rather than
   * writing `container.innerHTML` directly, so swapping pages never wipes out
   * SelectionOverlay's sibling layers.
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly onPageChange?: (page: number, pageCount: number, positions: Positions | null) => void,
    private readonly onZoomChange?: (zoom: number) => void,
  ) {
    this.svgLayer = document.createElement('div')
    this.svgLayer.className = 'score-svg-layer'
    this.container.appendChild(this.svgLayer)
  }

  getZoom(): number {
    return this.zoom
  }

  /** Current score's measure positions, for callers that need to (re)sync overlay state (e.g. SelectionOverlay) independent of the onPageChange callback's timing — see activateTab's own call for why that callback alone isn't reliable right after a fresh open. */
  getPositions(): Positions | null {
    return this.positions
  }

  setZoom(zoom: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    const svgEl = this.svgLayer.querySelector('svg')
    if (svgEl) svgEl.style.width = `${BASE_WIDTH_PX * this.zoom}px`
    this.onZoomChange?.(this.zoom)
  }

  /** Native page width/height (from the SVG's own viewBox, print-resolution px) — the basis for computing a fit-to-width/height zoom level. `null` if no page is rendered yet. */
  private nativeSize(): { width: number; height: number } | null {
    const svgEl = this.svgLayer.querySelector('svg')
    const viewBox = svgEl?.getAttribute('viewBox')?.split(' ')
    if (!viewBox || viewBox.length < 4) return null
    return { width: parseFloat(viewBox[2]), height: parseFloat(viewBox[3]) }
  }

  /** Sets zoom so the rendered page's width exactly fills `availableWidthPx`. */
  setZoomToWidth(availableWidthPx: number): void {
    if (!this.nativeSize()) return
    // Rendered width at zoom=1 is exactly BASE_WIDTH_PX regardless of the
    // page's native pixel size (see setZoom), so this is just a ratio —
    // unlike setZoomToHeight, which needs the native aspect ratio.
    this.setZoom(availableWidthPx / BASE_WIDTH_PX)
  }

  /** Sets zoom so the rendered page's height exactly fills `availableHeightPx`, preserving the page's native aspect ratio. */
  setZoomToHeight(availableHeightPx: number): void {
    const native = this.nativeSize()
    if (!native || native.height <= 0) return
    const renderedHeightAtZoom1 = BASE_WIDTH_PX * (native.height / native.width)
    this.setZoom(availableHeightPx / renderedHeightAtZoom1)
  }

  /**
   * Attach a newly-opened score. Clears any previously cached pages and
   * fetches `measurePositions()` once (cached here for the lifetime of this
   * score, per IMPLEMENTATION_PLAN.md Phase 3 — pure derived data, cheap to
   * keep in memory, safe to re-fetch if ever needed since it's read-only).
   */
  async setScore(score: WebMscore, pageCount: number): Promise<void> {
    this.score = score
    this.pageCount = pageCount
    this.currentPage = 0
    this.cache.clear()
    this.zoom = 1
    this.positions = await getMeasurePositions(score)
  }

  async showPage(index: number): Promise<void> {
    if (!this.score) return
    if (index < 0 || index >= this.pageCount) return

    this.currentPage = index

    const cached = this.cache.get(index)
    if (cached !== undefined) {
      this.setContent(cached)
      this.onPageChange?.(this.currentPage, this.pageCount, this.positions)
      return
    }

    const svg = await renderPage(this.score, index)
    this.cache.set(index, svg)
    // Guard against a stale response landing after the user already
    // navigated elsewhere (or opened a new file) while this render was in flight.
    if (this.currentPage === index) {
      this.setContent(svg)
      this.onPageChange?.(this.currentPage, this.pageCount, this.positions)
    }
  }

  /**
   * webmscore's SVG carries explicit native pixel width/height (print
   * resolution, e.g. ~2977x4208px) with no CSS scaling applied. Rather than
   * mutate the SVG markup itself, scale it down to fit the container via a
   * plain CSS override on the root <svg> element — this preserves vector
   * sharpness at any zoom level and keeps the cached SVG string unmodified.
   */
  private setContent(svg: string): void {
    this.svgLayer.innerHTML = svg
    const svgEl = this.svgLayer.querySelector('svg')
    if (svgEl) {
      svgEl.style.width = `${BASE_WIDTH_PX * this.zoom}px`
      svgEl.style.height = 'auto'
      svgEl.style.display = 'block'
    }
  }

  async next(): Promise<void> {
    await this.showPage(this.currentPage + 1)
  }

  async prev(): Promise<void> {
    await this.showPage(this.currentPage - 1)
  }

  get page(): number {
    return this.currentPage
  }

  get pages(): number {
    return this.pageCount
  }
}
