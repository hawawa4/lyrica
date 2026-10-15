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
 * PDF mode (Phase 9): measures are positioned entirely by the CV
 * barline-detection assist (`addPointsFromBarlines`/
 * `addPointsFromBarlinesAcrossPages`) — there is no manual click-to-place/
 * click-to-remove UI (an earlier version had one, gated behind a
 * "Marking mode" toggle; removed once the CV detector proved reliable
 * enough that hand-placing/correcting individual measures stopped being
 * worth the interaction-mode complexity). If the detector gets a page
 * wrong, the fix is re-running auto-detect or clearing all measures for the
 * file and re-scanning, not hand correction.
 *
 * The page's only remaining interaction is drag-select a rectangle to
 * select a *range* of existing measures (like `SelectionOverlay`'s
 * drag-to-select-measures for `.mscz`) for `main.ts`'s L-to-loop, plus
 * double-click-to-seek on the nearest measure.
 *
 * Positions are stored as a **fraction (0-1) of the page's own width/height**
 * — zoom-independent, matching `CalibrationPoint.x`/`y`'s documented contract
 * ("PDF points at scale 1... stays valid across window resizes"). Every
 * place a point is created (click-to-place, CV barline detection) divides by
 * *that moment's* canvas width/height to get this fraction; every place a
 * point is displayed or hit-tested (`render()`, `handleStageClick`,
 * `handleDoubleClick`) multiplies by the *current* canvas's width/height.
 * Storing raw canvas-native pixels instead (an earlier version of this file
 * did) silently broke after any zoom change made since a point was placed —
 * the stored pixel offset no longer corresponded to the same place on the
 * page once the canvas was re-rendered at a different resolution.
 */
export class CalibrationOverlay {
  private readonly dotsLayer: HTMLDivElement
  private readonly dragRectEl: HTMLDivElement
  private points: CalibrationPoint[] = []
  private currentPage = 0
  private dragStart: { x: number; y: number } | null = null
  private selectedRange: PointRange | null = null
  private playingIndex: number | null = null
  private onChangeCallback: ((points: CalibrationPoint[]) => void) | null = null
  private onSelectCallback: ((range: PointRange | null) => void) | null = null
  private onSeekCallback: ((pointIndex: number) => void) | null = null

  constructor(private readonly stage: HTMLElement) {
    this.dotsLayer = document.createElement('div')
    this.dotsLayer.style.position = 'absolute'
    this.dotsLayer.style.inset = '0'
    this.dotsLayer.style.pointerEvents = 'none'

    this.dragRectEl = document.createElement('div')
    this.dragRectEl.style.position = 'absolute'
    this.dragRectEl.style.border = '1px dashed var(--selection-border)'
    this.dragRectEl.style.background = 'var(--selection)'
    this.dragRectEl.style.pointerEvents = 'none'
    this.dragRectEl.style.display = 'none'

    this.stage.appendChild(this.dotsLayer)
    this.stage.appendChild(this.dragRectEl)
    this.stage.addEventListener('mousedown', this.handleMouseDown)
    window.addEventListener('mousemove', this.handleMouseMove)
    window.addEventListener('mouseup', this.handleMouseUp)
    this.stage.addEventListener('dblclick', this.handleDoubleClick)
  }

  onChange(callback: (points: CalibrationPoint[]) => void): void {
    this.onChangeCallback = callback
  }

  /** Called when the drag-selected measure range changes. */
  onSelect(callback: (range: PointRange | null) => void): void {
    this.onSelectCallback = callback
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
    this.render()
  }

  /**
   * CV barline-detection assist (`crates/cv-barline`, optional/Phase 9):
   * directly adds a real calibration point for every detected barline x on
   * the current page (across all detected staff systems), auto-numbering
   * them in reading order (system top-to-bottom, then x left-to-right
   * within a system) — no separate "suggestion, click to confirm" step. The
   * detector can and does produce false positives (stems, chord stacks —
   * see cv-barline's module docs). There's no manual correction UI for
   * individual measures (see this file's module docs) — if the detector
   * gets a page wrong, the fix is re-running this (or `clearAllPoints` then
   * re-scanning), not treated as guaranteed-correct on the first pass.
   */
  addPointsFromBarlines(systems: StaffSystem[]): void {
    const canvas = this.stage.querySelector('canvas')
    if (!canvas) return
    const newPoints = this.pointsFromBarlines(
      this.currentPage,
      systems,
      nextMeasure(this.points),
      nextTimeMs(this.points),
      canvas.width,
      canvas.height,
    )
    if (newPoints.length === 0) return
    this.points = [...this.points, ...newPoints].sort((a, b) => a.time_ms - b.time_ms)
    this.render()
    this.onChangeCallback?.(this.points)
  }

  /**
   * Same idea as `addPointsFromBarlines`, but for a whole-document scan
   * (`main.ts`'s auto-scan-on-open): takes one `(page, systems)` pair per
   * *already-rendered* page (so this method does no rendering/detection
   * itself — that's main.ts's job, since it needs the live canvas/API
   * calls), with measure numbers and `time_ms` continuing to increment
   * across the whole document rather than resetting per page. Fires
   * `onChange` exactly once at the end (not once per page) — a 45-page scan
   * would otherwise trigger 45 redundant saves of a growing array.
   */
  addPointsFromBarlinesAcrossPages(
    pageResults: { page: number; systems: StaffSystem[]; canvasWidth: number; canvasHeight: number }[],
  ): void {
    let measure = nextMeasure(this.points)
    let nextTime = nextTimeMs(this.points)
    const allNewPoints: CalibrationPoint[] = []

    for (const { page, systems, canvasWidth, canvasHeight } of pageResults) {
      const newPoints = this.pointsFromBarlines(page, systems, measure, nextTime, canvasWidth, canvasHeight)
      allNewPoints.push(...newPoints)
      measure += newPoints.length
      nextTime += newPoints.length * 1000
    }

    if (allNewPoints.length === 0) return
    this.points = [...this.points, ...allNewPoints].sort((a, b) => a.time_ms - b.time_ms)
    this.render()
    this.onChangeCallback?.(this.points)
  }

  /**
   * `canvasWidth`/`canvasHeight` are the pixel dimensions of the canvas the
   * CV detector's `systems` were measured against (the same canvas
   * `canvasToPngBytes` read from) — `barline_xs`/`top`/`bottom` are raw
   * pixel coordinates in that canvas's space, so dividing by these converts
   * them to the zoom-independent 0-1 fraction this class stores everywhere
   * else (see module docs).
   */
  private pointsFromBarlines(
    page: number,
    systems: StaffSystem[],
    startMeasure: number,
    startTimeMs: number,
    canvasWidth: number,
    canvasHeight: number,
  ): CalibrationPoint[] {
    const sorted = [...systems].sort((a, b) => a.top - b.top)
    let measure = startMeasure
    let time_ms = startTimeMs
    const points: CalibrationPoint[] = []

    for (const system of sorted) {
      const xs = [...system.barline_xs].sort((a, b) => a - b)
      const y = (system.top + system.bottom) / 2 / canvasHeight
      for (const x of xs) {
        points.push({ page, x: x / canvasWidth, y, time_ms, measure })
        measure += 1
        time_ms += 1000
      }
    }
    return points
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

  /** Called with the index (time-sorted, matches getPoints()) of the calibration point nearest a double-click, for seeking the playback head there. */
  onSeek(callback: (pointIndex: number) => void): void {
    this.onSeekCallback = callback
  }

  destroy(): void {
    this.stage.removeEventListener('mousedown', this.handleMouseDown)
    window.removeEventListener('mousemove', this.handleMouseMove)
    window.removeEventListener('mouseup', this.handleMouseUp)
    this.stage.removeEventListener('dblclick', this.handleDoubleClick)
    this.dotsLayer.remove()
    this.dragRectEl.remove()
  }

  /** Nearest measure on the current page, by on-screen pixel distance from a double-click, for seeking the playback head there. */
  private handleDoubleClick = (e: MouseEvent): void => {
    const canvas = this.stage.querySelector('canvas')
    if (!canvas) return
    const rect = this.stage.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    let nearestIndex = -1
    let nearestDistSq = Infinity
    this.points.forEach((p, index) => {
      if (p.page !== this.currentPage) return
      // p.x/p.y are fractions (0-1) of the page — scale by the *displayed*
      // size (rect.width/height), not canvas.width/height, since clickX/Y
      // are already in displayed-pixel space.
      const dx = clickX - p.x * rect.width
      const dy = clickY - p.y * rect.height
      const distSq = dx * dx + dy * dy
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq
        nearestIndex = index
      }
    })
    if (nearestIndex !== -1) this.onSeekCallback?.(nearestIndex)
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
      // p.x/p.y are already a 0-1 fraction of the page — no canvas-size
      // division needed, which is exactly why this representation survives
      // a zoom change: the fraction means the same thing at every zoom.
      dot.style.left = `${p.x * 100}%`
      dot.style.top = `${p.y * 100}%`
      dot.style.transform = 'translate(-50%, -50%)'
      dot.style.width = isPlaying ? '22px' : '16px'
      dot.style.height = isPlaying ? '22px' : '16px'
      dot.style.borderRadius = '50%'
      dot.style.background = isPlaying
        ? 'var(--point-playing)'
        : isSelected
          ? 'var(--point-selected)'
          : 'var(--point-idle)'
      dot.style.boxShadow = isPlaying
        ? '0 0 0 4px var(--success-soft)'
        : isSelected
          ? '0 0 0 3px var(--accent-soft)'
          : 'none'
      dot.style.transition = 'width 0.1s, height 0.1s'
      dot.style.color = 'var(--accent-text)'
      dot.style.fontSize = '9px'
      dot.style.display = 'flex'
      dot.style.alignItems = 'center'
      dot.style.justifyContent = 'center'
      dot.textContent = String(p.measure)
      dot.title = `Measure ${p.measure}`
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
