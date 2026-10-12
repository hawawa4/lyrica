import { renderPage, type WebMscore } from '../score-engine'

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

  constructor(
    private readonly container: HTMLElement,
    private readonly onPageChange?: (page: number, pageCount: number) => void,
  ) {}

  /** Attach a newly-opened score. Clears any previously cached pages. */
  setScore(score: WebMscore, pageCount: number): void {
    this.score = score
    this.pageCount = pageCount
    this.currentPage = 0
    this.cache.clear()
  }

  async showPage(index: number): Promise<void> {
    if (!this.score) return
    if (index < 0 || index >= this.pageCount) return

    this.currentPage = index
    this.onPageChange?.(this.currentPage, this.pageCount)

    const cached = this.cache.get(index)
    if (cached !== undefined) {
      this.setContent(cached)
      return
    }

    const svg = await renderPage(this.score, index)
    this.cache.set(index, svg)
    // Guard against a stale response landing after the user already
    // navigated elsewhere (or opened a new file) while this render was in flight.
    if (this.currentPage === index) {
      this.setContent(svg)
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
    this.container.innerHTML = svg
    const svgEl = this.container.querySelector('svg')
    if (svgEl) {
      svgEl.style.width = '100%'
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
