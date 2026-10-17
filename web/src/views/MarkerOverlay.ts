import { addMarker, deleteMarker, listMarkers, updateMarker } from '../api-client'
import type { Marker, MarkerKind, MarkerPosition } from '../types'

/** Which kind of marker a click on the sheet places — `null` means no tool is active and clicks seek/select as usual. */
export type MarkerTool = MarkerKind

/** Per-tab knowledge the overlay can't derive itself (measure layout lives in `.mscz` positions or PDF calibration points). */
export interface MarkerHost {
  /** Where a new marker of `kind` should sit for a click at `click` — e.g. a text marker snaps to the top-left of the measure clicked on. */
  placementFor(kind: MarkerKind, click: MarkerPosition): MarkerPosition
  /** Where a legacy measure-anchored marker (no `position`) should be drawn, or `null` if that measure can't be found. */
  resolveLegacy(measureIndex: number): MarkerPosition | null
}

/** Pointer travel (px) below which a mousedown/mouseup on a marker counts as a click (edit) rather than a drag (move). */
const CLICK_SLOP_PX = 4

/** Text markers placed on the same spot stack upward instead of overlapping. */
const STACK_KEY_PRECISION = 4

interface Editor {
  el: HTMLDivElement
  input: HTMLInputElement
  kind: MarkerKind
  position: MarkerPosition
  /** `null` while creating a new marker. */
  markerId: string | null
  done: boolean
}

/**
 * Markers written directly on the sheet, like pencil on paper — no list,
 * no sidebar. Draws into a `.marker-layer` inside every page-stage under
 * the active tab's page container that currently shows a page (stages
 * advertise their page via `data-page`, set by `PageView`/PracticeView's
 * PDF renderer), so the same code covers single-page, book mode, `.mscz`
 * and PDF without knowing which is which.
 *
 * Positions are page fractions (see `MarkerPosition`), drawn as
 * percentages of the stage — zoom-independent, the same reason
 * `SelectionOverlay` and `CalibrationOverlay` use percentages. Marker
 * font size is in `cqw` (the layer is a size container), so markers scale
 * with the page like ink on it would.
 *
 * While a tool is active, the layer captures pointer input (stopping it
 * before the stage's own seek/select overlay sees it): clicking empty
 * space places a marker, clicking a marker edits it, dragging one moves
 * it. With no tool active, markers are display-only and every click falls
 * through to the sheet.
 */
export class MarkerOverlay {
  private root: HTMLElement | null = null
  private host: MarkerHost | null = null
  private fileHash: string | null = null
  private markers: Marker[] = []
  private tool: MarkerTool | null = null
  private editor: Editor | null = null
  private drag: { marker: Marker; el: HTMLElement; stage: HTMLElement; startX: number; startY: number; moved: boolean } | null = null
  private onToolChangeCallback: ((tool: MarkerTool | null) => void) | null = null
  private onErrorCallback: ((message: string) => void) | null = null
  /** Bumped on every `setTab`, so a slow `listMarkers` for a tab the user already switched away from can't overwrite the newer one's markers. */
  private loadGeneration = 0

  constructor() {
    window.addEventListener('mousemove', this.handleDragMove)
    window.addEventListener('mouseup', this.handleDragEnd)
  }

  onToolChange(callback: (tool: MarkerTool | null) => void): void {
    this.onToolChangeCallback = callback
  }

  onError(callback: (message: string) => void): void {
    this.onErrorCallback = callback
  }

  /** Whether markers can be placed at all for the current tab (needs a stable file hash to persist under). */
  get available(): boolean {
    return this.fileHash !== null
  }

  get activeTool(): MarkerTool | null {
    return this.tool
  }

  /** Points the overlay at a tab's page container. `fileHash` `null` means markers are unavailable for this tab (shown nowhere, tools disabled). */
  async setTab(root: HTMLElement | null, fileHash: string | null, host: MarkerHost | null): Promise<void> {
    this.closeEditor(false)
    this.root = root
    this.host = host
    this.fileHash = fileHash
    this.markers = []
    if (!fileHash) this.setTool(null)
    const generation = ++this.loadGeneration
    this.refresh()
    if (!fileHash) return
    try {
      const markers = await listMarkers(fileHash)
      if (generation !== this.loadGeneration) return
      this.markers = markers
    } catch (e) {
      this.onErrorCallback?.(`Failed to load markers: ${describeError(e)}`)
    }
    this.refresh()
  }

  setTool(tool: MarkerTool | null): void {
    if (tool && !this.available) tool = null
    if (tool === this.tool) return
    this.closeEditor(true)
    this.tool = tool
    this.refresh()
    this.onToolChangeCallback?.(tool)
  }

  /** Re-renders every visible page's markers — call whenever a stage starts showing a different page (or the stage set itself changes, e.g. book-mode toggle). */
  refresh(): void {
    if (!this.root) return
    for (const stage of this.stages()) this.renderStage(stage)
  }

  /** The active tab's page-stages that are currently showing a page. */
  private stages(): HTMLElement[] {
    if (!this.root) return []
    const stages = Array.from(this.root.querySelectorAll<HTMLElement>('.page-stage'))
    if (this.root.classList.contains('page-stage')) stages.unshift(this.root)
    return stages
  }

  private layerFor(stage: HTMLElement): HTMLDivElement {
    let layer = Array.from(stage.children).find((c) => c.classList.contains('marker-layer')) as HTMLDivElement | undefined
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'marker-layer'
      layer.addEventListener('mousedown', (e) => this.handleLayerMouseDown(e, stage))
      stage.appendChild(layer)
    }
    return layer
  }

  private renderStage(stage: HTMLElement): void {
    const layer = this.layerFor(stage)
    for (const el of Array.from(layer.querySelectorAll('.sheet-marker'))) el.remove()
    const page = stagePage(stage)
    layer.classList.toggle('placing', this.tool !== null && page !== null)
    layer.classList.toggle('placing-text', this.tool === 'text')
    layer.classList.toggle('placing-fingering', this.tool === 'fingering')
    if (page === null) {
      layer.style.display = 'none'
      return
    }
    layer.style.display = ''

    const stackCounts = new Map<string, number>()
    for (const marker of this.markers) {
      if (this.editor?.markerId === marker.id) continue
      const position = this.positionOf(marker)
      if (!position || position.page !== page) continue
      const el = document.createElement('div')
      el.className = `sheet-marker sheet-marker-${marker.kind}`
      el.dataset.markerId = marker.id
      el.style.left = `${position.x * 100}%`
      el.style.top = `${position.y * 100}%`
      if (marker.kind === 'fingering') {
        for (const digit of marker.text) {
          const span = document.createElement('span')
          span.textContent = digit
          el.appendChild(span)
        }
      } else {
        el.textContent = marker.text
        const key = `${position.x.toFixed(STACK_KEY_PRECISION)}:${position.y.toFixed(STACK_KEY_PRECISION)}`
        const stackIndex = stackCounts.get(key) ?? 0
        stackCounts.set(key, stackIndex + 1)
        el.style.setProperty('--stack-index', String(stackIndex))
      }
      layer.appendChild(el)
    }
  }

  private positionOf(marker: Marker): MarkerPosition | null {
    if (marker.position) return marker.position
    if (marker.measure_index !== undefined && marker.measure_index !== null) {
      return this.host?.resolveLegacy(marker.measure_index) ?? null
    }
    return null
  }

  private handleLayerMouseDown(e: MouseEvent, stage: HTMLElement): void {
    if (!this.tool || e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.marker-editor')) {
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    e.preventDefault()
    const page = stagePage(stage)
    if (page === null) return

    const markerEl = target.closest<HTMLElement>('.sheet-marker')
    const marker = markerEl && this.markers.find((m) => m.id === markerEl.dataset.markerId)
    if (markerEl && marker) {
      this.closeEditor(true)
      this.drag = { marker, el: markerEl, stage, startX: e.clientX, startY: e.clientY, moved: false }
      return
    }

    // A click while an editor is open just commits it — the user is
    // clicking away, not asking for another marker right there.
    if (this.editor) {
      this.closeEditor(true)
      return
    }
    const click = { page, ...stageFraction(stage, e.clientX, e.clientY) }
    const position = this.host?.placementFor(this.tool, click) ?? click
    this.openEditor(stage, this.tool, position, null, '')
  }

  private handleDragMove = (e: MouseEvent): void => {
    if (!this.drag) return
    if (!this.drag.moved && Math.hypot(e.clientX - this.drag.startX, e.clientY - this.drag.startY) < CLICK_SLOP_PX) return
    this.drag.moved = true
    const { x, y } = stageFraction(this.drag.stage, e.clientX, e.clientY)
    this.drag.el.style.left = `${x * 100}%`
    this.drag.el.style.top = `${y * 100}%`
    this.drag.el.classList.add('dragging')
  }

  private handleDragEnd = (e: MouseEvent): void => {
    if (!this.drag) return
    const { marker, stage, moved } = this.drag
    this.drag = null
    const page = stagePage(stage)
    if (page === null) return
    if (!moved) {
      const position = this.positionOf(marker) ?? { page, ...stageFraction(stage, e.clientX, e.clientY) }
      this.openEditor(stage, marker.kind, position, marker.id, marker.text)
      return
    }
    const { x, y } = stageFraction(stage, e.clientX, e.clientY)
    void this.save(() => updateMarker(this.fileHash!, marker.id, marker.text, { page, x, y }))
  }

  private openEditor(stage: HTMLElement, kind: MarkerKind, position: MarkerPosition, markerId: string | null, text: string): void {
    this.closeEditor(true)
    const layer = this.layerFor(stage)

    const el = document.createElement('div')
    el.className = `marker-editor marker-editor-${kind}`
    el.style.left = `${position.x * 100}%`
    el.style.top = `${position.y * 100}%`

    const input = document.createElement('input')
    input.type = 'text'
    input.value = text
    input.placeholder = kind === 'fingering' ? '1-5' : 'Note…'
    input.spellcheck = false
    if (kind === 'fingering') {
      input.inputMode = 'numeric'
      input.maxLength = 10
      input.addEventListener('input', () => {
        input.value = input.value.replace(/[^1-5]/g, '')
      })
    }
    el.appendChild(input)

    if (markerId) {
      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'marker-editor-delete'
      deleteBtn.title = 'Delete marker'
      deleteBtn.textContent = '✕'
      // mousedown, not click: keeps focus in the input so its blur-commit doesn't fire first.
      deleteBtn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const editor = this.editor
        if (!editor) return
        editor.done = true
        this.editor = null
        editor.el.remove()
        void this.save(() => deleteMarker(this.fileHash!, markerId))
      })
      el.appendChild(deleteBtn)
    }

    const editor: Editor = { el, input, kind, position, markerId, done: false }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        this.closeEditor(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.closeEditor(false)
      }
    })
    input.addEventListener('blur', () => {
      if (this.editor === editor) this.closeEditor(true)
    })

    this.editor = editor
    layer.appendChild(el)
    // Hide the marker being edited — the editor stands in for it.
    if (markerId) this.renderStage(stage)
    input.focus()
    input.select()
  }

  /** Closes the open editor, if any, saving its contents when `commit` (an emptied existing marker is deleted). */
  private closeEditor(commit: boolean): void {
    const editor = this.editor
    if (!editor || editor.done) return
    editor.done = true
    this.editor = null
    editor.el.remove()

    const text = editor.input.value.trim()
    const fileHash = this.fileHash
    if (!commit || !fileHash) {
      this.refresh()
      return
    }
    const original = editor.markerId ? this.markers.find((m) => m.id === editor.markerId) : null
    if (editor.markerId && !text) {
      void this.save(() => deleteMarker(fileHash, editor.markerId!))
    } else if (editor.markerId && text !== original?.text) {
      void this.save(() => updateMarker(fileHash, editor.markerId!, text, null))
    } else if (!editor.markerId && text) {
      void this.save(() => addMarker(fileHash, editor.kind, editor.position, text))
    } else {
      this.refresh()
    }
  }

  private async save(op: () => Promise<Marker[]>): Promise<void> {
    const fileHash = this.fileHash
    try {
      const markers = await op()
      if (fileHash !== this.fileHash) return
      this.markers = markers
    } catch (e) {
      this.onErrorCallback?.(`Failed to save marker: ${describeError(e)}`)
    }
    this.refresh()
  }
}

function stagePage(stage: HTMLElement): number | null {
  const raw = stage.dataset.page
  if (raw === undefined || raw === '') return null
  const page = Number(raw)
  return Number.isFinite(page) ? page : null
}

/** Client coordinates -> 0-1 fraction of `stage`'s box, clamped onto the page. */
function stageFraction(stage: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = stage.getBoundingClientRect()
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
