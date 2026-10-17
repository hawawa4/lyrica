import type { PositionElement } from '../score-engine'

export interface MeasureRange {
  /** Inclusive, in webmscore's own element id space (matches PositionElement.id). */
  startElid: number
  endElid: number
}

/** Pointer travel (px) below which a mousedown/mouseup pair counts as a click rather than a drag. */
const CLICK_SLOP_PX = 4

/**
 * Measure interaction overlaid on a rendered page. Draws a transparent box
 * per measure (from `measurePositions()`'s elements, filtered to the current
 * page) and turns pointer input into:
 * - click on a measure: `onSeek(elid)` (move the playback head there)
 * - click anywhere else: clear the selection, `onSelect(null)`
 * - drag across measures: highlight the ones the drag rectangle overlaps,
 *   `onSelect(range)` (loop them)
 * The selected range is kept here (not just as box styling) so it's still
 * highlighted after the page is re-rendered or flipped away and back.
 *
 * Box positions are computed as percentages of the page's native size
 * (`pageSize` from webmscore's Positions payload), not fixed pixel values —
 * this tracks whatever size PageView is actually rendering the SVG at
 * (currently `width: 100%` of its container, see PageView.setContent), so
 * the overlay stays aligned regardless of window size or future zoom
 * controls, with no separate scale-factor bookkeeping needed.
 */
export class SelectionOverlay {
  private readonly boxesLayer: HTMLDivElement
  private readonly dragRectEl: HTMLDivElement
  private elements: PositionElement[] = []
  private selected: MeasureRange | null = null
  private dragStart: { x: number; y: number } | null = null
  private onSelectionChange: ((range: MeasureRange | null) => void) | null = null
  private onSeekCallback: ((elid: number) => void) | null = null

  constructor(private readonly stage: HTMLElement) {
    // `stage` must be position:relative (or similar) so these absolutely
    // positioned children are placed relative to it, not the page.
    this.boxesLayer = document.createElement('div')
    this.boxesLayer.style.position = 'absolute'
    this.boxesLayer.style.inset = '0'
    this.boxesLayer.style.pointerEvents = 'none'

    this.dragRectEl = document.createElement('div')
    this.dragRectEl.style.position = 'absolute'
    this.dragRectEl.style.border = '1px dashed var(--selection-border)'
    this.dragRectEl.style.background = 'var(--selection)'
    this.dragRectEl.style.pointerEvents = 'none'
    this.dragRectEl.style.display = 'none'

    this.stage.appendChild(this.boxesLayer)
    this.stage.appendChild(this.dragRectEl)

    this.stage.addEventListener('mousedown', this.handleMouseDown)
    window.addEventListener('mousemove', this.handleMouseMove)
    window.addEventListener('mouseup', this.handleMouseUp)
  }

  /** Call once per page shown: all measure elements plus which page is visible. */
  setPage(allElements: PositionElement[], page: number): void {
    this.elements = allElements.filter((e) => e.page === page)
    this.renderBoxes()
  }

  /** Alias for `setPage` — satisfies `PracticeView`'s shared `SelectionSource` interface, which also covers `BookPageView`'s own differently-behaved `resync` (see that file's docs). */
  resync(allElements: PositionElement[], page: number): void {
    this.setPage(allElements, page)
  }

  onSelect(callback: (range: MeasureRange | null) => void): void {
    this.onSelectionChange = callback
  }

  /** Highlights `range` (or nothing, for `null`) without firing `onSelect` — for keeping this overlay in sync with a selection made elsewhere (the other page of a book spread) or cleared programmatically. */
  setSelection(range: MeasureRange | null): void {
    this.selected = range
    this.renderBoxes()
  }

  /** Called with the elid of the measure clicked, for seeking the playback head there. */
  onSeek(callback: (elid: number) => void): void {
    this.onSeekCallback = callback
  }

  destroy(): void {
    this.stage.removeEventListener('mousedown', this.handleMouseDown)
    window.removeEventListener('mousemove', this.handleMouseMove)
    window.removeEventListener('mouseup', this.handleMouseUp)
    this.boxesLayer.remove()
    this.dragRectEl.remove()
  }

  private renderBoxes(): void {
    this.boxesLayer.innerHTML = ''
    if (this.elements.length === 0) return

    const pageWidth = this.nativePageWidth()
    const pageHeight = this.nativePageHeight()
    if (!pageWidth || !pageHeight) return

    for (const el of this.elements) {
      const box = document.createElement('div')
      box.dataset.elid = String(el.id)
      box.style.position = 'absolute'
      box.style.left = `${(el.x / pageWidth) * 100}%`
      box.style.top = `${(el.y / pageHeight) * 100}%`
      box.style.width = `${(el.sx / pageWidth) * 100}%`
      box.style.height = `${(el.sy / pageHeight) * 100}%`
      const isSelected = !!this.selected && el.id >= this.selected.startElid && el.id <= this.selected.endElid
      box.style.background = isSelected ? 'var(--selection)' : 'transparent'
      box.style.border = isSelected ? '1px solid var(--selection-border)' : 'none'
      this.boxesLayer.appendChild(box)
    }
  }

  private nativePageWidth(): number {
    const svg = this.stage.querySelector('svg')
    return svg ? parseFloat(svg.getAttribute('viewBox')?.split(' ')[2] ?? '0') : 0
  }

  private nativePageHeight(): number {
    const svg = this.stage.querySelector('svg')
    return svg ? parseFloat(svg.getAttribute('viewBox')?.split(' ')[3] ?? '0') : 0
  }

  private handleMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return
    const rect = this.stage.getBoundingClientRect()
    this.dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    this.dragRectEl.style.display = 'block'
    this.dragRectEl.style.left = `${this.dragStart.x}px`
    this.dragRectEl.style.top = `${this.dragStart.y}px`
    this.dragRectEl.style.width = '0px'
    this.dragRectEl.style.height = '0px'
  }

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.dragStart) return
    const rect = this.stage.getBoundingClientRect()
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const left = Math.min(this.dragStart.x, cur.x)
    const top = Math.min(this.dragStart.y, cur.y)
    this.dragRectEl.style.left = `${left}px`
    this.dragRectEl.style.top = `${top}px`
    this.dragRectEl.style.width = `${Math.abs(cur.x - this.dragStart.x)}px`
    this.dragRectEl.style.height = `${Math.abs(cur.y - this.dragStart.y)}px`
  }

  private handleMouseUp = (e: MouseEvent): void => {
    if (!this.dragStart) return
    const rect = this.stage.getBoundingClientRect()
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const start = this.dragStart
    this.dragStart = null
    this.dragRectEl.style.display = 'none'

    if (Math.hypot(cur.x - start.x, cur.y - start.y) < CLICK_SLOP_PX) {
      const box = this.boxes().find((b) => cur.x >= b.left && cur.x <= b.right && cur.y >= b.top && cur.y <= b.bottom)
      if (box) {
        this.onSeekCallback?.(box.elid)
      } else {
        this.setSelection(null)
        this.onSelectionChange?.(null)
      }
      return
    }

    const dragBox = {
      left: Math.min(start.x, cur.x),
      top: Math.min(start.y, cur.y),
      right: Math.max(start.x, cur.x),
      bottom: Math.max(start.y, cur.y),
    }
    const selectedIds = this.boxes()
      .filter((b) => b.left < dragBox.right && b.right > dragBox.left && b.top < dragBox.bottom && b.bottom > dragBox.top)
      .map((b) => b.elid)

    const range = selectedIds.length === 0 ? null : { startElid: Math.min(...selectedIds), endElid: Math.max(...selectedIds) }
    this.setSelection(range)
    this.onSelectionChange?.(range)
  }

  /** Every measure box on this page, in stage-relative px. */
  private boxes(): { elid: number; left: number; top: number; right: number; bottom: number }[] {
    const stageRect = this.stage.getBoundingClientRect()
    return (Array.from(this.boxesLayer.children) as HTMLElement[]).map((box) => {
      const r = box.getBoundingClientRect()
      const left = r.left - stageRect.left
      const top = r.top - stageRect.top
      return { elid: Number(box.dataset.elid), left, top, right: left + r.width, bottom: top + r.height }
    })
  }
}
