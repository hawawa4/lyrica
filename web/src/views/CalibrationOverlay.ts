import type { CalibrationPoint, StaffSystem } from '../types'

/**
 * A selected range of calibration points, by index into the time-sorted
 * point list (mirrors `SelectionOverlay`'s `MeasureRange`, but over
 * calibration points instead of webmscore measure elements — the user's own
 * framing is that calibration points are "converting PDF to .mscz, but only
 * the measure-boundary part," so looping works the same way: drag-select a
 * range, press L).
 */
export interface PointRange {
  startIndex: number
  endIndex: number
}

/**
 * PDF mode (Phase 9): two interaction modes on the same rendered PDF page,
 * mutually exclusive via `setMarkingMode`:
 *
 * - **Marking mode** (`setMarkingMode(true)`, off by default): click to place
 *   a calibration point (opens a small inline form to assign its measure
 *   number), click an existing point's dot to remove it. A PDF is typically reopened
 *   already calibrated from a past session, so placement/removal needs an
 *   explicit toggle — without it, an ordinary click while reading/practicing
 *   would silently add an unwanted point.
 * - **Normal mode** (default): drag-select a rectangle to select a *range* of
 *   existing points (like `SelectionOverlay`'s drag-to-select-measures for
 *   `.mscz`) for `main.ts`'s L-to-loop, instead of adding/removing anything.
 *
 * Positions are stored in the rendered canvas's own native pixel space
 * (`canvas.width`/`canvas.height`, i.e. `cssWidth * devicePixelRatio` per
 * `pdf-engine.ts`'s `renderPdfPage`), not raw *displayed* pixel offsets —
 * `render()`/`handleStageClick()` both convert through `canvas.width`/
 * `canvas.height` as percentages, so dots stay correctly placed regardless
 * of the page's current CSS display size. This does mean a point's stored
 * `x`/`y` is tied to whatever zoom level was active when it was placed; at
 * a different zoom the *percentage* position is still correct (dots are
 * positioned by `% of canvas size`, not absolute pixels), so this isn't a
 * bug in practice, just worth knowing if ever debugging point placement.
 */
export class CalibrationOverlay {
  private readonly dotsLayer: HTMLDivElement
  private readonly dragRectEl: HTMLDivElement
  private readonly formEl: HTMLDivElement
  private readonly measureInput: HTMLInputElement
  private points: CalibrationPoint[] = []
  private currentPage = 0
  private markingMode = false
  private pendingClick: { x: number; y: number } | null = null
  private dragStart: { x: number; y: number } | null = null
  private selectedRange: PointRange | null = null
  private playingIndex: number | null = null
  private onChangeCallback: ((points: CalibrationPoint[]) => void) | null = null
  private onSelectCallback: ((range: PointRange | null) => void) | null = null

  constructor(private readonly stage: HTMLElement) {
    this.dotsLayer = document.createElement('div')
    this.dotsLayer.style.position = 'absolute'
    this.dotsLayer.style.inset = '0'
    this.dotsLayer.style.pointerEvents = 'none'

    this.dragRectEl = document.createElement('div')
    this.dragRectEl.style.position = 'absolute'
    this.dragRectEl.style.border = '1px dashed #0a0'
    this.dragRectEl.style.background = 'rgba(0, 200, 0, 0.1)'
    this.dragRectEl.style.pointerEvents = 'none'
    this.dragRectEl.style.display = 'none'

    this.formEl = document.createElement('div')
    this.formEl.style.position = 'absolute'
    this.formEl.style.display = 'none'
    this.formEl.style.background = 'white'
    this.formEl.style.border = '1px solid #888'
    this.formEl.style.borderRadius = '4px'
    this.formEl.style.padding = '6px'
    this.formEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)'
    this.formEl.style.zIndex = '10'
    this.formEl.innerHTML = `
      <div style="font-size: 12px; margin-bottom: 4px;">New calibration point</div>
      <label style="font-size: 12px;">Measure <input type="number" min="0" value="0" style="width: 50px;" /></label>
      <div style="margin-top: 4px;">
        <button class="confirm" style="font-size: 12px;">Add</button>
        <button class="cancel" style="font-size: 12px;">Cancel</button>
      </div>
    `
    this.measureInput = this.formEl.querySelector('input')!
    this.formEl.querySelector('.confirm')!.addEventListener('click', () => this.confirmPending())
    this.formEl.querySelector('.cancel')!.addEventListener('click', () => this.cancelPending())

    this.stage.appendChild(this.dotsLayer)
    this.stage.appendChild(this.dragRectEl)
    this.stage.appendChild(this.formEl)
    this.stage.addEventListener('click', this.handleStageClick)
    this.stage.addEventListener('mousedown', this.handleMouseDown)
    window.addEventListener('mousemove', this.handleMouseMove)
    window.addEventListener('mouseup', this.handleMouseUp)
  }

  onChange(callback: (points: CalibrationPoint[]) => void): void {
    this.onChangeCallback = callback
  }

  /** Called when the drag-selected point range changes (normal mode only). */
  onSelect(callback: (range: PointRange | null) => void): void {
    this.onSelectCallback = callback
  }

  setMarkingMode(enabled: boolean): void {
    if (this.markingMode === enabled) return
    this.markingMode = enabled
    if (!enabled) this.cancelPending()
    this.selectedRange = null
    this.onSelectCallback?.(null)
    this.render()
  }

  /** Point indices (`pointIndex`, `PointRange`) are always in time-sorted order — matches the order `pdf_calibration::save_points`/`tempo_map` use server-side, so `main.ts`'s loop-range derivation can treat "index" and "time order" as the same thing. */
  setPoints(points: CalibrationPoint[]): void {
    this.points = [...points].sort((a, b) => a.time_ms - b.time_ms)
    this.render()
  }

  /** Current points, time-sorted — indices match `PointRange`/`onSelect`. */
  getPoints(): CalibrationPoint[] {
    return this.points
  }

  /** Highlights the point currently playing (driven by main.ts's PDF cursor poller), or clears it with `null` on stop. */
  setPlayingIndex(index: number | null): void {
    this.playingIndex = index
    this.render()
  }

  setPage(page: number): void {
    this.currentPage = page
    this.cancelPending()
    this.render()
  }

  /**
   * CV barline-detection assist (`crates/cv-barline`, optional/Phase 9):
   * directly adds a real calibration point for every detected barline x
   * (across all detected staff systems), auto-numbering them in reading
   * order (system top-to-bottom, then x left-to-right within a system) —
   * no separate "suggestion, click to confirm" step. The detector can and
   * does produce false positives (stems, chord stacks — see cv-barline's
   * module docs), so these are meant to be spot-corrected afterward via the
   * normal Mark-measures add/remove flow, not treated as guaranteed-correct.
   */
  addPointsFromBarlines(systems: StaffSystem[]): void {
    const sorted = [...systems].sort((a, b) => a.top - b.top)
    let measure = nextMeasure(this.points)
    const newPoints: CalibrationPoint[] = []
    let nextTime = nextTimeMs(this.points)

    for (const system of sorted) {
      const xs = [...system.barline_xs].sort((a, b) => a - b)
      const y = (system.top + system.bottom) / 2
      for (const x of xs) {
        newPoints.push({ page: this.currentPage, x, y, time_ms: nextTime, measure })
        measure += 1
        nextTime += 1000
      }
    }

    if (newPoints.length === 0) return
    this.points = [...this.points, ...newPoints].sort((a, b) => a.time_ms - b.time_ms)
    this.render()
    this.onChangeCallback?.(this.points)
  }

  /** Removes every calibration point for this file (all pages, not just the current one) — the caller is responsible for confirming with the user first, since this can't be undone. */
  clearAllPoints(): void {
    if (this.points.length === 0) return
    this.points = []
    this.selectedRange = null
    this.onSelectCallback?.(null)
    this.render()
    this.onChangeCallback?.(this.points)
  }

  destroy(): void {
    this.stage.removeEventListener('click', this.handleStageClick)
    this.stage.removeEventListener('mousedown', this.handleMouseDown)
    window.removeEventListener('mousemove', this.handleMouseMove)
    window.removeEventListener('mouseup', this.handleMouseUp)
    this.dotsLayer.remove()
    this.dragRectEl.remove()
    this.formEl.remove()
  }

  private handleStageClick = (e: MouseEvent): void => {
    if (!this.markingMode) return
    if (this.formEl.contains(e.target as Node)) return
    if ((e.target as HTMLElement).dataset.pointIndex !== undefined) return // handled by dot's own click

    const rect = this.stage.getBoundingClientRect()
    const pixelX = e.clientX - rect.left
    const pixelY = e.clientY - rect.top

    const canvas = this.stage.querySelector('canvas')
    if (!canvas) return
    // Canvas is rendered at native PDF-point resolution (pdf-engine.ts's
    // renderPdfPage uses the container's CSS width as its target render
    // width) but may be CSS-scaled to fit — convert click position from
    // displayed pixels back to the canvas's own native coordinate space.
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    this.openPendingForm(pixelX * scaleX, pixelY * scaleY, pixelX, pixelY)
  }

  /** Opens the measure confirmation form, positioned at `pixelX`/`pixelY` (displayed pixels, for the form's own CSS position) for a pending point at `canvasX`/`canvasY` (canvas-native pixel space, what actually gets stored). */
  private openPendingForm(canvasX: number, canvasY: number, pixelX: number, pixelY: number): void {
    this.pendingClick = { x: canvasX, y: canvasY }
    this.measureInput.value = String(nextMeasure(this.points))
    this.formEl.style.left = `${pixelX}px`
    this.formEl.style.top = `${pixelY}px`
    this.formEl.style.display = 'block'
  }

  private handleMouseDown = (e: MouseEvent): void => {
    if (this.markingMode) return
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
    const selectedIndices: number[] = []
    for (const box of Array.from(this.dotsLayer.children) as HTMLElement[]) {
      const boxRect = box.getBoundingClientRect()
      const bl = boxRect.left - stageRect.left
      const bt = boxRect.top - stageRect.top
      const br = bl + boxRect.width
      const bb = bt + boxRect.height
      const overlaps = bl < dragBox.right && br > dragBox.left && bt < dragBox.bottom && bb > dragBox.top
      if (overlaps) selectedIndices.push(Number(box.dataset.pointIndex))
    }

    this.selectedRange =
      selectedIndices.length === 0
        ? null
        : { startIndex: Math.min(...selectedIndices), endIndex: Math.max(...selectedIndices) }
    this.render()
    this.onSelectCallback?.(this.selectedRange)
  }

  private confirmPending(): void {
    if (!this.pendingClick) return
    const measure = Number(this.measureInput.value) || 0
    const point: CalibrationPoint = {
      page: this.currentPage,
      x: this.pendingClick.x,
      y: this.pendingClick.y,
      time_ms: nextTimeMs(this.points),
      measure,
    }
    this.points = [...this.points, point].sort((a, b) => a.time_ms - b.time_ms)
    this.cancelPending()
    this.render()
    this.onChangeCallback?.(this.points)
  }

  private cancelPending(): void {
    this.pendingClick = null
    this.formEl.style.display = 'none'
  }

  private removePoint(index: number): void {
    this.points = this.points.filter((_, i) => i !== index)
    this.render()
    this.onChangeCallback?.(this.points)
  }

  private render(): void {
    this.dotsLayer.innerHTML = ''
    const canvas = this.stage.querySelector('canvas')
    if (!canvas) return

    const pointsOnPage = this.points
      .map((p, index) => ({ p, index }))
      .filter(({ p }) => p.page === this.currentPage)

    for (const { p, index } of pointsOnPage) {
      const isSelected =
        !!this.selectedRange && index >= this.selectedRange.startIndex && index <= this.selectedRange.endIndex
      const isPlaying = index === this.playingIndex

      const dot = document.createElement('div')
      dot.dataset.pointIndex = String(index)
      dot.style.position = 'absolute'
      dot.style.left = `${(p.x / canvas.width) * 100}%`
      dot.style.top = `${(p.y / canvas.height) * 100}%`
      dot.style.transform = 'translate(-50%, -50%)'
      dot.style.width = isPlaying ? '22px' : '16px'
      dot.style.height = isPlaying ? '22px' : '16px'
      dot.style.borderRadius = '50%'
      dot.style.background = isPlaying
        ? 'rgba(0, 180, 0, 0.9)'
        : isSelected
          ? 'rgba(0, 150, 255, 0.9)'
          : 'rgba(255, 60, 0, 0.85)'
      dot.style.boxShadow = isPlaying
        ? '0 0 0 4px rgba(0, 180, 0, 0.35)'
        : isSelected
          ? '0 0 0 3px rgba(0, 150, 255, 0.35)'
          : 'none'
      dot.style.transition = 'width 0.1s, height 0.1s'
      dot.style.color = 'white'
      dot.style.fontSize = '9px'
      dot.style.display = 'flex'
      dot.style.alignItems = 'center'
      dot.style.justifyContent = 'center'
      dot.textContent = String(p.measure)
      if (this.markingMode) {
        dot.style.pointerEvents = 'auto'
        dot.style.cursor = 'pointer'
        dot.title = `Measure ${p.measure} — click to remove`
        dot.addEventListener('click', (e) => {
          e.stopPropagation()
          this.removePoint(index)
        })
      } else {
        dot.title = `Measure ${p.measure}`
      }
      this.dotsLayer.appendChild(dot)
    }
  }
}

/** New points append after the latest existing point's time, 1 second apart — only relative order/spacing matters for tempo derivation (see pdf_calibration.rs). */
function nextTimeMs(existing: CalibrationPoint[]): number {
  if (existing.length === 0) return 0
  return Math.max(...existing.map((p) => p.time_ms)) + 1000
}

/** Defaults a new point's measure to right after the latest existing point's (by time) — always the next measure — rather than always defaulting to measure 0, which made every point need manual correction. */
function nextMeasure(existing: CalibrationPoint[]): number {
  if (existing.length === 0) return 0
  const latest = existing.reduce((a, b) => (a.time_ms >= b.time_ms ? a : b))
  return latest.measure + 1
}
