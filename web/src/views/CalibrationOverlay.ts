import type { CalibrationPoint } from '../types'

/**
 * PDF mode (Phase 9): click-to-place calibration points directly on a
 * rendered PDF page. Each click opens a small inline form to assign
 * measure+beat; existing points render as small numbered dots the user can
 * click to remove.
 *
 * Placement/removal only happens in "marking mode" (`setMarkingMode(true)`,
 * toggled explicitly by the user via main.ts — off by default). A PDF is
 * typically opened already calibrated from a past session; without an
 * explicit toggle, an ordinary click while reading/practicing would
 * silently add an unwanted point. Points still render while marking mode is
 * off (so the user can see what's calibrated), just non-interactive.
 *
 * Positions are stored in PDF-point space (the page's own coordinate system
 * at `scale: 1`, matching `pdf-engine.ts`'s `renderPdfPage`), not raw pixel
 * offsets into the canvas — so calibration stays valid across window
 * resizes/zoom, the same reasoning `SelectionOverlay` uses for `.mscz`
 * measure boxes.
 */
export class CalibrationOverlay {
  private readonly dotsLayer: HTMLDivElement
  private readonly formEl: HTMLDivElement
  private readonly measureInput: HTMLInputElement
  private readonly beatInput: HTMLInputElement
  private points: CalibrationPoint[] = []
  private currentPage = 0
  private markingMode = false
  private pendingClick: { x: number; y: number } | null = null
  private onChangeCallback: ((points: CalibrationPoint[]) => void) | null = null

  constructor(private readonly stage: HTMLElement) {
    this.dotsLayer = document.createElement('div')
    this.dotsLayer.style.position = 'absolute'
    this.dotsLayer.style.inset = '0'

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
      <label style="font-size: 12px; margin-left: 6px;">Beat <input type="number" min="0" value="0" style="width: 40px;" /></label>
      <div style="margin-top: 4px;">
        <button class="confirm" style="font-size: 12px;">Add</button>
        <button class="cancel" style="font-size: 12px;">Cancel</button>
      </div>
    `
    const inputs = this.formEl.querySelectorAll('input')
    this.measureInput = inputs[0]
    this.beatInput = inputs[1]
    this.formEl.querySelector('.confirm')!.addEventListener('click', () => this.confirmPending())
    this.formEl.querySelector('.cancel')!.addEventListener('click', () => this.cancelPending())

    this.stage.appendChild(this.dotsLayer)
    this.stage.appendChild(this.formEl)
    this.stage.addEventListener('click', this.handleStageClick)
  }

  onChange(callback: (points: CalibrationPoint[]) => void): void {
    this.onChangeCallback = callback
  }

  setMarkingMode(enabled: boolean): void {
    this.markingMode = enabled
    if (!enabled) this.cancelPending()
    this.render()
  }

  setPoints(points: CalibrationPoint[]): void {
    this.points = points
    this.render()
  }

  setPage(page: number): void {
    this.currentPage = page
    this.cancelPending()
    this.render()
  }

  destroy(): void {
    this.stage.removeEventListener('click', this.handleStageClick)
    this.dotsLayer.remove()
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

    this.pendingClick = { x: pixelX * scaleX, y: pixelY * scaleY }
    this.measureInput.value = '0'
    this.beatInput.value = '0'
    this.formEl.style.left = `${pixelX}px`
    this.formEl.style.top = `${pixelY}px`
    this.formEl.style.display = 'block'
  }

  private confirmPending(): void {
    if (!this.pendingClick) return
    const measure = Number(this.measureInput.value) || 0
    const beat = Number(this.beatInput.value) || 0
    const point: CalibrationPoint = {
      page: this.currentPage,
      x: this.pendingClick.x,
      y: this.pendingClick.y,
      time_ms: nextTimeMs(this.points),
      measure,
      beat,
    }
    this.points = [...this.points, point]
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
      const dot = document.createElement('div')
      dot.dataset.pointIndex = String(index)
      dot.style.position = 'absolute'
      dot.style.left = `${(p.x / canvas.width) * 100}%`
      dot.style.top = `${(p.y / canvas.height) * 100}%`
      dot.style.transform = 'translate(-50%, -50%)'
      dot.style.width = '16px'
      dot.style.height = '16px'
      dot.style.borderRadius = '50%'
      dot.style.background = 'rgba(255, 60, 0, 0.85)'
      dot.style.color = 'white'
      dot.style.fontSize = '9px'
      dot.style.display = 'flex'
      dot.style.alignItems = 'center'
      dot.style.justifyContent = 'center'
      dot.textContent = `${p.measure}.${p.beat}`
      if (this.markingMode) {
        dot.style.cursor = 'pointer'
        dot.title = `Measure ${p.measure}, beat ${p.beat} — click to remove`
        dot.addEventListener('click', (e) => {
          e.stopPropagation()
          this.removePoint(index)
        })
      } else {
        dot.title = `Measure ${p.measure}, beat ${p.beat}`
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
