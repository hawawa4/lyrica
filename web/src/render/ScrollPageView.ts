import { getMeasurePositions, type WebMscore, type Positions } from '../score-engine'
import { PageView, BASE_WIDTH_PX, MIN_ZOOM, MAX_ZOOM } from './PageView'
import { SelectionOverlay, type MeasureRange } from './SelectionOverlay'
import { NearViewportObserver, CurrentPageTracker, preserveScrollRatio } from './scroll-utils'

/**
 * "Scroll mode": every page of the score in one continuous strip with no gap
 * between pages — a vertical column, or (`horizontal`, i.e. scroll + book
 * mode) a horizontal row. Pages render lazily as they approach the viewport.
 *
 * Satisfies the same shape as `PageView`/`BookPageView` (see PracticeView's
 * `PageDisplay`/`SelectionSource`) by owning one `PageView` +
 * `SelectionOverlay` per page. `page` is the most-visible page; `showPage`
 * scrolls to a page. `stageFor(page)` returns `null` until that page has
 * actually rendered, so callers' existing "no stage -> showPage" logic
 * triggers the render and scroll.
 *
 * webmscore lays pages out itself with no continuous-view option, so a page
 * is still a page: this is pages butted against each other, not a re-flowed
 * single system.
 */
export class ScrollPageView {
  private readonly views: PageView[] = []
  private readonly overlays: SelectionOverlay[] = []
  private readonly stages: HTMLDivElement[] = []
  private readonly requested = new Set<number>()
  private pageCount = 0
  private positions: Positions | null = null
  private current = 0
  private aspect: number | null = null
  private near: NearViewportObserver | null = null
  private tracker: CurrentPageTracker | null = null

  constructor(
    private readonly container: HTMLElement,
    horizontal: boolean,
    private readonly onPageChange?: (page: number, pageCount: number, positions: Positions | null) => void,
    private readonly onZoomChange?: (zoom: number) => void,
  ) {
    this.container.classList.remove('page-stage', 'book-spread')
    this.container.classList.add('scroll-spread', horizontal ? 'scroll-horizontal' : 'scroll-vertical')
    delete this.container.dataset.page
  }

  async setScore(score: WebMscore, pageCount: number): Promise<void> {
    this.teardown()
    this.pageCount = pageCount
    this.current = 0
    this.positions = await getMeasurePositions(score)
    const positions = this.positions

    for (let i = 0; i < pageCount; i++) {
      const stage = document.createElement('div')
      stage.className = 'page-stage scroll-page'
      this.container.appendChild(stage)
      const view = new PageView(
        stage,
        (page, _count, pos) => {
          if (pos) this.overlays[page].setPage(pos.elements, page)
          this.adoptAspect(view)
        },
        i === 0 ? (zoom) => this.onZoomChange?.(zoom) : undefined,
      )
      this.stages.push(stage)
      this.views.push(view)
      this.overlays.push(new SelectionOverlay(stage))
      await view.setScore(score, pageCount, positions)
    }
    this.applyStageSizes()

    this.near = new NearViewportObserver((i) => void this.render(i))
    this.tracker = new CurrentPageTracker((i) => {
      this.current = i
      this.onPageChange?.(i, this.pageCount, this.positions)
    })
    this.stages.forEach((stage, i) => {
      this.near!.observe(stage, i)
      this.tracker!.observe(stage, i)
    })
  }

  private async render(i: number): Promise<void> {
    if (this.requested.has(i)) return
    this.requested.add(i)
    await this.views[i].showPage(i)
  }

  /** Learns the page aspect ratio from the first rendered page so not-yet-rendered stages can reserve the right amount of room. */
  private adoptAspect(view: PageView): void {
    if (this.aspect !== null) return
    const box = view.nativeAspect()
    if (box) {
      this.aspect = box
      this.applyStageSizes()
    }
  }

  private applyStageSizes(): void {
    const width = BASE_WIDTH_PX * this.getZoom()
    for (const stage of this.stages) {
      stage.style.width = `${width}px`
      if (this.aspect !== null) stage.style.aspectRatio = String(this.aspect)
    }
  }

  getZoom(): number {
    return this.views[0]?.getZoom() ?? 1
  }

  setZoom(zoom: number): void {
    // views[0]'s own zoom callback reports the (clamped) change to onZoomChange.
    const scroller = this.container.parentElement
    const apply = (): void => {
      this.views.forEach((v) => v.setZoom(zoom))
      this.applyStageSizes()
    }
    if (scroller) preserveScrollRatio(scroller, apply)
    else apply()
  }

  setZoomToWidth(availableWidthPx: number): void {
    this.views[0]?.setZoomToWidth(availableWidthPx)
    this.setZoom(this.getZoom())
  }

  setZoomToHeight(availableHeightPx: number): void {
    this.views[0]?.setZoomToHeight(availableHeightPx)
    this.setZoom(this.getZoom())
  }

  getPositions(): Positions | null {
    return this.positions
  }

  async showPage(index: number): Promise<void> {
    if (index < 0 || index >= this.pageCount) return
    this.current = index
    this.tracker?.setCurrent(index)
    this.stages[index].scrollIntoView({ block: 'start', inline: 'start' })
    this.onPageChange?.(index, this.pageCount, this.positions)
    await this.render(index)
  }

  async next(): Promise<void> {
    await this.showPage(this.current + 1)
  }

  async prev(): Promise<void> {
    await this.showPage(this.current - 1)
  }

  get page(): number {
    return this.current
  }

  get pages(): number {
    return this.pageCount
  }

  stageFor(page: number): HTMLElement | null {
    return this.views[page]?.rendered ? this.stages[page] : null
  }

  onSelect(callback: (range: MeasureRange | null) => void): void {
    this.overlays.forEach((overlay, i) =>
      overlay.onSelect((range) => {
        this.overlays.forEach((other, j) => j !== i && other.setSelection(range))
        callback(range)
      }),
    )
  }

  setSelection(range: MeasureRange | null): void {
    for (const overlay of this.overlays) overlay.setSelection(range)
  }

  onSeek(callback: (elid: number) => void): void {
    for (const overlay of this.overlays) overlay.onSeek(callback)
  }

  resync(): void {
    if (!this.positions) return
    this.overlays.forEach((overlay, i) => overlay.setPage(this.positions!.elements, i))
  }

  private teardown(): void {
    this.near?.disconnect()
    this.tracker?.disconnect()
    for (const overlay of this.overlays) overlay.destroy()
    for (const stage of this.stages) stage.remove()
    this.views.length = 0
    this.overlays.length = 0
    this.stages.length = 0
    this.requested.clear()
    this.aspect = null
  }

  destroy(): void {
    this.teardown()
  }
}

export { MIN_ZOOM, MAX_ZOOM }
