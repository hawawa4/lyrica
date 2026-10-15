import type { WebMscore, Positions } from '../score-engine'
import { PageView, MIN_ZOOM, MAX_ZOOM } from './PageView'
import { SelectionOverlay, type MeasureRange } from './SelectionOverlay'

/**
 * "Book mode": two pages shown side by side, left always an even-aligned
 * spread start (0-based: 0&1, 2&3, 4&5, ...) — like a real book, where you
 * turn a full spread at a time rather than sliding one page at a window.
 *
 * Implements the same public shape `PageView` exposes (`showPage`, `next`,
 * `prev`, `page`, `pages`, `getZoom`, `setZoom`, `setZoomToWidth/Height`,
 * `getPositions`) by internally owning two independent `PageView` +
 * `SelectionOverlay` pairs (`left/right`) and routing each call to whichever
 * side is relevant — so the ~24 call sites in `PracticeView.ts` that already
 * talk to a single `PageView`/`SelectionOverlay` don't need to know which
 * display mode is active. `left.page` is always this view's own `page`
 * (`showPage(n)` aligns `n` down to an even spread start); `right` mirrors
 * whatever `left` is doing one page ahead, including showing nothing (its
 * container stays empty) past the last page in an odd-paged score.
 *
 * Both sides are fully interactive (drag-select, double-click-seek) — this
 * is two complete `SelectionOverlay` instances, not a read-only preview on
 * one side, so loop-selection/jump-to-measure work identically regardless
 * of which page of the spread the target measure happens to land on.
 */
export class BookPageView {
  readonly left: PageView
  readonly right: PageView
  readonly leftSelectionOverlay: SelectionOverlay
  readonly rightSelectionOverlay: SelectionOverlay
  private readonly leftContainer: HTMLDivElement
  private readonly rightContainer: HTMLDivElement
  private pageCount = 0
  private positions: Positions | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly onPageChange?: (page: number, pageCount: number, positions: Positions | null) => void,
    private readonly onZoomChange?: (zoom: number) => void,
  ) {
    this.container.classList.add('book-spread')

    this.leftContainer = document.createElement('div')
    this.leftContainer.className = 'page-stage book-page book-page-left'
    this.rightContainer = document.createElement('div')
    this.rightContainer.className = 'page-stage book-page book-page-right'
    this.container.appendChild(this.leftContainer)
    this.container.appendChild(this.rightContainer)

    this.left = new PageView(
      this.leftContainer,
      (page, pageCount, positions) => {
        this.pageCount = pageCount
        this.positions = positions
        if (positions) this.leftSelectionOverlay.setPage(positions.elements, page)
        void this.syncRight()
        this.onPageChange?.(page, pageCount, positions)
      },
      (zoom) => {
        this.right.setZoom(zoom)
        this.onZoomChange?.(zoom)
      },
    )
    this.right = new PageView(this.rightContainer, (page, _pageCount, positions) => {
      if (positions) this.rightSelectionOverlay.setPage(positions.elements, page)
    })

    this.leftSelectionOverlay = new SelectionOverlay(this.leftContainer)
    this.rightSelectionOverlay = new SelectionOverlay(this.rightContainer)
  }

  /** Re-shows whatever page should sit to the right of `left`'s current page — a no-op (empty right pane) past the last page, for an odd-paged score's final spread. */
  private async syncRight(): Promise<void> {
    const rightPage = this.left.page + 1
    if (rightPage >= this.pageCount) {
      this.rightContainer.querySelector('.score-svg-layer')!.innerHTML = ''
      return
    }
    await this.right.showPage(rightPage)
  }

  getZoom(): number {
    return this.left.getZoom()
  }

  setZoom(zoom: number): void {
    this.left.setZoom(zoom) // also drives right.setZoom via the onZoomChange hookup above
    void zoom
  }

  setZoomToWidth(availableWidthPx: number): void {
    // Each page gets half the available width (minus a visual gap the CSS
    // already accounts for via gap/padding) — same page, same zoom on both
    // sides, since a book spread shows two pages at matched size.
    this.left.setZoomToWidth(availableWidthPx / 2)
    this.right.setZoom(this.left.getZoom())
  }

  setZoomToHeight(availableHeightPx: number): void {
    this.left.setZoomToHeight(availableHeightPx)
    this.right.setZoom(this.left.getZoom())
  }

  getPositions(): Positions | null {
    return this.positions
  }

  /**
   * `setPage` is deliberately absent here (unlike plain `SelectionOverlay`) —
   * `BookPageView`'s own `left`/`right` `PageView`s already call
   * `leftSelectionOverlay.setPage`/`rightSelectionOverlay.setPage` directly
   * from their `onPageChange` hookups in the constructor, since each side
   * needs a different page's elements. A caller holding a `BookPageView` as
   * its "selectionOverlay" should never need to call `setPage` itself.
   */

  /** Fires for a selection made on *either* page of the spread — the callback isn't told which side, since loop/selection state in `PracticeView` is per-tab, not per-page. */
  onSelect(callback: (range: MeasureRange | null) => void): void {
    this.leftSelectionOverlay.onSelect(callback)
    this.rightSelectionOverlay.onSelect(callback)
  }

  /** Fires for a double-click-seek on *either* page of the spread. */
  onSeek(callback: (elid: number) => void): void {
    this.leftSelectionOverlay.onSeek(callback)
    this.rightSelectionOverlay.onSeek(callback)
  }

  /**
   * Ignores `allElements`/`page` (unlike `SelectionOverlay.resync`, which
   * this satisfies the same interface as) — the two sides of a spread are
   * never on the same page as each other, so there's no single `page` this
   * call could correctly apply to both. Instead re-derives and re-pushes
   * each side's own current page from this view's own `left.page`/
   * `right.page` and cached `positions`, mirroring what the constructor's
   * `onPageChange` hookups already do on a fresh page render.
   */
  resync(): void {
    if (!this.positions) return
    this.leftSelectionOverlay.setPage(this.positions.elements, this.left.page)
    this.rightSelectionOverlay.setPage(this.positions.elements, this.right.page)
  }

  async setScore(score: WebMscore, pageCount: number): Promise<void> {
    this.pageCount = pageCount
    await this.left.setScore(score, pageCount)
    await this.right.setScore(score, pageCount)
  }

  /** Aligns `index` down to its spread's left page (0&1 -> 0, 2&3 -> 2, ...) and shows both sides. */
  async showPage(index: number): Promise<void> {
    const spreadStart = index - (index % 2)
    await this.left.showPage(spreadStart)
    // syncRight() (driven by left's onPageChange above) handles the right side.
  }

  async next(): Promise<void> {
    await this.showPage(this.left.page + 2)
  }

  async prev(): Promise<void> {
    await this.showPage(this.left.page - 2)
  }

  get page(): number {
    return this.left.page
  }

  get pages(): number {
    return this.pageCount
  }

  /** `left`'s or `right`'s own stage element, whichever is currently showing `page` — see `PageView.stageFor`'s docs for why a caller needs this rather than assuming a single shared stage. */
  stageFor(page: number): HTMLElement | null {
    return this.left.stageFor(page) ?? this.right.stageFor(page)
  }

  destroy(): void {
    this.leftSelectionOverlay.destroy()
    this.rightSelectionOverlay.destroy()
  }
}

export { MIN_ZOOM, MAX_ZOOM }
export type { MeasureRange }
