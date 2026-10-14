import type { PositionElement } from '../score-engine'

export interface MeasureRange {
  /** Inclusive, in webmscore's own element id space (matches PositionElement.id). */
  startElid: number
  endElid: number
}

/**
 * Click-drag-to-measure-range selection, overlaid on a rendered page. Draws a
 * transparent box per measure (from `measurePositions()`'s elements, filtered
 * to the current page), highlights the ones a drag rectangle overlaps, and
 * reports the resulting measure range on mouseup.
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
    this.stage.addEventListener('dblclick', this.handleDoubleClick)
  }

  /** Call once per page shown: all measure elements plus which page is visible. */
  setPage(allElements: PositionElement[], page: number): void {
    this.elements = allElements.filter((e) => e.page === page)
    this.renderBoxes()
  }

  onSelect(callback: (range: MeasureRange | null) => void): void {
    this.onSelectionChange = callback
  }

  /** Called with the elid of the measure double-clicked, for seeking the playback head there. */
  onSeek(callback: (elid: number) => void): void {
    this.onSeekCallback = callback
  }

  destroy(): void {
    this.stage.removeEventListener('mousedown', this.handleMouseDown)
    window.removeEventListener('mousemove', this.handleMouseMove)
    window.removeEventListener('mouseup', this.handleMouseUp)
    this.stage.removeEventListener('dblclick', this.handleDoubleClick)
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
    const dragBox = {
      left: Math.min(this.dragStart.x, cur.x),
      top: Math.min(this.dragStart.y, cur.y),
      right: Math.max(this.dragStart.x, cur.x),
      bottom: Math.max(this.dragStart.y, cur.y),
    }
    this.dragStart = null
    this.dragRectEl.style.display = 'none'

    const stageRect = this.stage.getBoundingClientRect()
    const selectedIds: number[] = []
    for (const box of Array.from(this.boxesLayer.children) as HTMLElement[]) {
      const boxRect = box.getBoundingClientRect()
      const bl = boxRect.left - stageRect.left
      const bt = boxRect.top - stageRect.top
      const br = bl + boxRect.width
      const bb = bt + boxRect.height
      const overlaps = bl < dragBox.right && br > dragBox.left && bt < dragBox.bottom && bb > dragBox.top
      box.style.background = overlaps ? 'var(--selection)' : 'transparent'
      box.style.border = overlaps ? '1px solid var(--selection-border)' : 'none'
      if (overlaps) selectedIds.push(Number(box.dataset.elid))
    }

    if (selectedIds.length === 0) {
      this.onSelectionChange?.(null)
      return
    }
    this.onSelectionChange?.({
      startElid: Math.min(...selectedIds),
      endElid: Math.max(...selectedIds),
    })
  }

  private handleDoubleClick = (e: MouseEvent): void => {
    const stageRect = this.stage.getBoundingClientRect()
    const x = e.clientX - stageRect.left
    const y = e.clientY - stageRect.top
    for (const box of Array.from(this.boxesLayer.children) as HTMLElement[]) {
      const boxRect = box.getBoundingClientRect()
      const bl = boxRect.left - stageRect.left
      const bt = boxRect.top - stageRect.top
      const br = bl + boxRect.width
      const bb = bt + boxRect.height
      if (x >= bl && x <= br && y >= bt && y <= bb) {
        this.onSeekCallback?.(Number(box.dataset.elid))
        return
      }
    }
  }
}
