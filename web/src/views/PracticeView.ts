import { openScore, upgradeScore, getMeasurePositions, getMidi, type OpenScoreResult, type WebMscore, type Positions } from '../score-engine'
import { loadPdf, renderPdfPage, canvasToPngBytes, type PdfDocument } from '../pdf-engine'
import { PageView, ZOOM_STEP, MIN_ZOOM, MAX_ZOOM } from '../render/PageView'
import { SelectionOverlay, type MeasureRange } from '../render/SelectionOverlay'
import { BookPageView } from '../render/BookPageView'
import { CalibrationOverlay, type PointRange } from './CalibrationOverlay'
import { Cursor } from '../render/Cursor'
import { PlaybackHeadMarker } from '../render/PlaybackHeadMarker'
import {
  isTauri,
  importTimeline,
  loadMidi,
  playMidi,
  stopMidi,
  pauseMidi,
  resumeMidi,
  seekMidi,
  setPlaybackSpeed,
  setLoopRegion,
  setMetronomeEnabled,
  contentHash,
  recordRecentFile,
  hashBytes,
  listCalibrationPoints,
  saveCalibrationPoints,
  loadPdfTempoMap,
  detectBarlines,
  getKnowledgeLevel,
  setKnowledgeLevel,
} from '../api-client'
import { MarkerPanel } from './MarkerPanel'
import { PiecesIndex } from './PiecesIndex'
import { RatingStars } from './RatingStars'
import { TabBar, type TabInfo } from './TabBar'
import type { CalibrationPoint, KnowledgeLevel, StaffSystem, Timeline, TimelineEvent } from '../types'
import { initTheme, applyTheme, THEME_LABELS, type Theme } from '../theme'

/**
 * Everything that used to be a single set of global variables/objects,
 * bundled per open file (keyed by file hash) so switching tabs swaps state
 * wholesale instead of mutating shared globals. `pageView`/`selectionOverlay`
 * each own DOM-cached state (rendered SVG pages, measure selection boxes)
 * tied to a specific container element — one dedicated, hidden/shown
 * `pageContainerEl` per tab, rather than one shared instance repointed at a
 * new score, so switching back to an already-open tab never re-fetches
 * already-rendered pages (the "no re-fetch lag" requirement).
 *
 * Two kinds: `.mscz` tabs (real note data, full timeline/markers/pieces) and
 * PDF tabs (Phase 9 — no note data, just rendered pages + user-calibrated
 * tempo points for metronome-only playback). A discriminated union rather
 * than one shape with optional fields, since the two kinds share almost
 * nothing beyond "a tab with a title and a page area."
 */
/** stopped: head at rest, no audio engine activity. playing: Cursor is polling. paused: frozen mid-playback, resumable from exactly this position. */
type TransportState = 'stopped' | 'playing' | 'paused'

/** "Page display" mode: a single rendered page (today's default), or a two-page "book" spread (`BookPageView`). Both expose this exact shape — see `BookPageView`'s module docs for why that's the chosen integration point rather than threading a mode flag through every call site. */
interface PageDisplay {
  setScore(score: WebMscore, pageCount: number): Promise<void>
  showPage(index: number): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  readonly page: number
  readonly pages: number
  getZoom(): number
  setZoom(zoom: number): void
  setZoomToWidth(availableWidthPx: number): void
  setZoomToHeight(availableHeightPx: number): void
  getPositions(): Positions | null
  /** The concrete page-stage element currently showing `page`, or `null` — needed because book mode has two independent stages, only one of which holds any given page at a time. See `PageView.stageFor`'s docs. */
  stageFor(page: number): HTMLElement | null
}

/** Shared shape of `SelectionOverlay` and `BookPageView`'s own onSelect/onSeek facade (see that file's docs). */
interface SelectionSource {
  onSelect(callback: (range: MeasureRange | null) => void): void
  onSeek(callback: (elid: number) => void): void
  destroy(): void
  /**
   * Re-pushes the given page's measure-box positions into whichever
   * overlay(s) actually need them. For a plain `SelectionOverlay` this is
   * exactly `setPage`; `BookPageView` ignores the arguments and instead
   * re-derives each side's own correct page from its own `left`/`right`
   * state, since its two sides are never on the same page as each other.
   * Exists because `activateTab` needs to force this sync on every
   * (re)activation (see its own comment for why `PageView`'s onPageChange
   * callback alone isn't reliable there) without needing to branch on
   * which display mode is active.
   */
  resync(allElements: Positions['elements'], page: number): void
}

interface MsczTabState {
  kind: 'mscz'
  fileHash: string
  title: string
  score: WebMscore
  pageView: PageDisplay
  selectionOverlay: SelectionSource
  pageContainer: HTMLDivElement
  timeline: Timeline | null
  selection: MeasureRange | null
  speed: number
  loopRegion: [number, number] | null
  originalBytes: Uint8Array
  transportState: TransportState
  /** Where the playback-head marker currently sits, in the timeline's 1.0x-speed milliseconds — independent of whether audio is actually running. */
  headMs: number
  /** Whether this tab is currently showing a single page or a two-page "book" spread — toggled by the book-mode button, persisted per tab (not globally) since different open scores may suit different modes. */
  bookMode: boolean
}

interface PdfTabState {
  kind: 'pdf'
  fileHash: string
  title: string
  doc: PdfDocument
  pageCount: number
  currentPage: number
  zoom: number
  markingMode: boolean
  pageContainer: HTMLDivElement
  canvasContainer: HTMLDivElement
  calibrationOverlay: CalibrationOverlay
  points: CalibrationPoint[]
  selectedRange: PointRange | null
  numerator: number
  speed: number
  loopRegion: [number, number] | null
  transportState: TransportState
  headMs: number
}

type TabState = MsczTabState | PdfTabState

/** Default time signature numerator for calibration (used for bar-accent tracking) — no concept of a parsed time signature exists for a plain PDF, so this is a fixed assumption the user isn't currently able to change (future UI could expose it). */
const PDF_DEFAULT_NUMERATOR = 4
const PDF_BASE_WIDTH = 700
const PDF_ZOOM_STEP = 0.25
const PDF_MIN_ZOOM = 0.5
const PDF_MAX_ZOOM = 3

/**
 * The practice screen: toolbar/sidebar/tab-bar/page-area for opened files.
 * Reached from the library view by opening a file — `openBytes` is the
 * single entry point both the library view and this view's own open/drop/
 * recent-file handlers funnel through.
 */
export class PracticeView {
  readonly root: HTMLDivElement

  private readonly fileInput: HTMLInputElement
  private readonly statusEl: HTMLSpanElement
  private readonly navEl: HTMLDivElement
  private readonly transportEl: HTMLDivElement
  private readonly zoomGroupEl: HTMLDivElement
  private readonly pageIndicatorEl: HTMLSpanElement
  private readonly prevBtn: HTMLButtonElement
  private readonly nextBtn: HTMLButtonElement
  private readonly playBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly speedButtons: Record<number, HTMLButtonElement>
  private readonly metronomeCheckbox: HTMLInputElement
  private readonly pageContainerEl: HTMLDivElement
  private readonly emptyStateEl: HTMLDivElement
  private readonly selectionStatusEl: HTMLSpanElement
  private readonly loopStatusEl: HTMLSpanElement
  private readonly calibrationStatusEl: HTMLSpanElement
  private readonly ratingMountEl: HTMLSpanElement
  private readonly ratingStars: RatingStars
  private readonly pdfControlsEl: HTMLDivElement
  private readonly markingModeCheckbox: HTMLInputElement
  private readonly suggestBarlinesBtn: HTMLButtonElement
  private readonly clearPointsBtn: HTMLButtonElement
  private readonly zoomOutBtn: HTMLButtonElement
  private readonly zoomInBtn: HTMLButtonElement
  private readonly zoomIndicatorEl: HTMLSpanElement
  private readonly fitWidthBtn: HTMLButtonElement
  private readonly fitHeightBtn: HTMLButtonElement
  private readonly zoomResetBtn: HTMLButtonElement
  private readonly bookModeBtn: HTMLButtonElement
  private readonly themeSelectEl: HTMLSelectElement
  private readonly dropOverlay: HTMLDivElement
  private readonly openFileBtn: HTMLButtonElement

  private readonly tabs = new Map<string, TabState>()
  private activeHash: string | null = null

  private readonly tabBar: TabBar
  private readonly msczCursor: Cursor<TimelineEvent>
  private readonly pdfCursor: Cursor<CalibrationPoint>
  private readonly markerPanel: MarkerPanel
  private readonly piecesIndex: PiecesIndex
  private readonly cursorBoxEl: HTMLDivElement
  private readonly headMarker: PlaybackHeadMarker

  /** Called every time a file finishes opening and is recorded as a recent file — lets the library view refresh its recent-files list without this view needing to know it exists. */
  private onFileOpenedCallback: (() => void) | null = null

  constructor(container: HTMLElement) {
    initTheme()

    this.root = document.createElement('div')
    this.root.id = 'app'
    this.root.innerHTML = `
      <div class="toolbar">
        <span class="app-title">MusePractice</span>
        <div class="toolbar-group">
          <input id="file-input" type="file" accept=".mscz,.mscx,.pdf" />
          <button id="open-file-btn" class="primary" style="display:none;">Open file&hellip;</button>
        </div>
        <div id="nav" class="toolbar-group" style="display:none;">
          <button id="prev-page" class="icon-btn" title="Previous page">&larr;</button>
          <span id="page-indicator"></span>
          <button id="next-page" class="icon-btn" title="Next page">&rarr;</button>
        </div>
        <div id="transport" class="toolbar-group" style="display:none;">
          <button id="play-btn" class="icon-btn primary" disabled title="Play">&#9654;</button>
          <button id="stop-btn" class="icon-btn" disabled title="Stop">&#9632;</button>
          <button id="speed-05" class="speed-btn" disabled>0.5x</button>
          <button id="speed-075" class="speed-btn" disabled>0.75x</button>
          <button id="speed-10" class="speed-btn" disabled>1.0x</button>
          <label><input id="metronome-checkbox" type="checkbox" disabled /> Metronome</label>
        </div>
        <div id="zoom-group" class="toolbar-group zoom-control" style="display:none;">
          <button id="zoom-out" class="icon-btn" title="Zoom out">&minus;</button>
          <span id="zoom-indicator" class="zoom-indicator">100%</span>
          <button id="zoom-in" class="icon-btn" title="Zoom in">+</button>
          <button id="fit-width-btn" title="Fit to width">Fit width</button>
          <button id="fit-height-btn" title="Fit to height">Fit height</button>
          <button id="zoom-reset-btn" title="Reset zoom to 100%">100%</button>
          <button id="book-mode-btn" title="Book mode: show two pages side by side">&#128214; Book</button>
        </div>
        <div class="toolbar-spacer"></div>
        <div class="toolbar-group">
          <button id="back-to-library-btn" class="icon-btn" title="Back to library">&#128193; Library</button>
        </div>
        <div class="toolbar-group">
          <select id="theme-select" class="theme-select" title="Theme"></select>
        </div>
      </div>

      <div class="sidebar">
        <div id="pieces-index" class="sidebar-section"></div>
        <div id="marker-panel" class="sidebar-section"></div>
      </div>

      <div class="main-area">
        <div id="pdf-controls" class="pdf-toolbar">
          <label><input id="marking-mode-checkbox" type="checkbox" /> Mark measures</label>
          <button id="suggest-barlines-btn" style="display:none;">Suggest barlines</button>
          <button id="clear-points-btn" style="display:none;">Clear all points</button>
        </div>
        <div class="status-bar">
          <span id="status"></span>
          <span id="selection-status"></span>
          <span id="loop-status" class="loop-status"></span>
          <span id="calibration-status" class="calibration-status"></span>
          <span id="rating-mount" class="rating-mount" style="display:none;"></span>
        </div>
        <div id="page" class="page-area">
          <div class="empty-state" id="empty-state">
            <div>No file open</div>
            <div class="hint">Open a .mscz or .pdf file, or drag one onto this window</div>
          </div>
        </div>
      </div>

      <div id="tab-bar" class="tab-bar"></div>
      <div id="drop-overlay" class="drop-overlay" style="display:none;">Drop to open</div>
    `
    container.appendChild(this.root)

    this.fileInput = this.root.querySelector('#file-input')!
    this.statusEl = this.root.querySelector('#status')!
    this.navEl = this.root.querySelector('#nav')!
    this.transportEl = this.root.querySelector('#transport')!
    this.zoomGroupEl = this.root.querySelector('#zoom-group')!
    this.pageIndicatorEl = this.root.querySelector('#page-indicator')!
    this.prevBtn = this.root.querySelector('#prev-page')!
    this.nextBtn = this.root.querySelector('#next-page')!
    this.playBtn = this.root.querySelector('#play-btn')!
    this.stopBtn = this.root.querySelector('#stop-btn')!
    this.speedButtons = {
      0.5: this.root.querySelector('#speed-05')!,
      0.75: this.root.querySelector('#speed-075')!,
      1.0: this.root.querySelector('#speed-10')!,
    }
    this.metronomeCheckbox = this.root.querySelector('#metronome-checkbox')!
    this.pageContainerEl = this.root.querySelector('#page')!
    this.emptyStateEl = this.root.querySelector('#empty-state')!
    this.selectionStatusEl = this.root.querySelector('#selection-status')!
    this.loopStatusEl = this.root.querySelector('#loop-status')!
    this.calibrationStatusEl = this.root.querySelector('#calibration-status')!
    this.ratingMountEl = this.root.querySelector('#rating-mount')!
    this.ratingStars = new RatingStars()
    this.ratingMountEl.appendChild(this.ratingStars.el)
    this.ratingStars.onChange((level) => void this.handleRatingChange(level))
    this.pdfControlsEl = this.root.querySelector('#pdf-controls')!
    this.markingModeCheckbox = this.root.querySelector('#marking-mode-checkbox')!
    this.suggestBarlinesBtn = this.root.querySelector('#suggest-barlines-btn')!
    this.clearPointsBtn = this.root.querySelector('#clear-points-btn')!
    this.zoomOutBtn = this.root.querySelector('#zoom-out')!
    this.zoomInBtn = this.root.querySelector('#zoom-in')!
    this.zoomIndicatorEl = this.root.querySelector('#zoom-indicator')!
    this.fitWidthBtn = this.root.querySelector('#fit-width-btn')!
    this.fitHeightBtn = this.root.querySelector('#fit-height-btn')!
    this.zoomResetBtn = this.root.querySelector('#zoom-reset-btn')!
    this.bookModeBtn = this.root.querySelector('#book-mode-btn')!
    this.themeSelectEl = this.root.querySelector('#theme-select')!
    this.dropOverlay = this.root.querySelector('#drop-overlay')!
    this.openFileBtn = this.root.querySelector('#open-file-btn')!

    for (const theme of Object.keys(THEME_LABELS) as Theme[]) {
      const opt = document.createElement('option')
      opt.value = theme
      opt.textContent = THEME_LABELS[theme]
      this.themeSelectEl.appendChild(opt)
    }
    this.themeSelectEl.value = document.documentElement.getAttribute('data-theme') ?? 'light'
    this.themeSelectEl.addEventListener('change', () => applyTheme(this.themeSelectEl.value as Theme))

    const backToLibraryBtn = this.root.querySelector<HTMLButtonElement>('#back-to-library-btn')!
    backToLibraryBtn.addEventListener('click', () => {
      location.hash = '#/library'
    })

    const tabBarEl = this.root.querySelector<HTMLDivElement>('#tab-bar')!
    this.tabBar = new TabBar(tabBarEl)
    this.tabBar.onSwitch((hash) => void this.switchToTab(hash))
    this.tabBar.onClose((hash) => this.closeTab(hash))

    this.msczCursor = new Cursor<TimelineEvent>((event) => {
      const active = this.activeTab()
      if (!active || active.kind !== 'mscz') return
      if (!active.pageView.stageFor(event.page)) {
        void active.pageView.showPage(event.page)
      }
      this.mountOverlaysOnPage(active, event.page)
      const { width, height } = this.pageSize(active, event.page)
      this.cursorBoxEl.style.display = 'block'
      this.cursorBoxEl.style.left = `${(event.bbox.x / width) * 100}%`
      this.cursorBoxEl.style.top = `${(event.bbox.y / height) * 100}%`
      this.cursorBoxEl.style.width = `${(event.bbox.sx / width) * 100}%`
      this.cursorBoxEl.style.height = `${(event.bbox.sy / height) * 100}%`
      this.headMarker.setPosition((event.bbox.x / width) * 100, (event.bbox.y / height) * 100)
    })

    /**
     * PDF mode has no bbox to draw a highlight box from — only each
     * calibration point's own `{page, x, y}` — so this highlights the
     * *segment* currently playing (from the active point to the next one,
     * or a small fixed window past the last point) by driving
     * CalibrationOverlay's own selection highlighting, the same highlight
     * style drag-selecting a loop range already uses.
     */
    this.pdfCursor = new Cursor<CalibrationPoint>((_point, itemIndex) => {
      const active = this.activeTab()
      if (!active || active.kind !== 'pdf') return
      const points = active.calibrationOverlay.getPoints()
      const target = points[itemIndex]
      if (!target) return
      if (target.page !== active.currentPage) {
        void this.showPdfPage(active, target.page)
      }
      active.calibrationOverlay.setPlayingIndex(itemIndex)
      // target.x/y are already a 0-1 fraction of the page (see
      // CalibrationOverlay's module docs) — no canvas-size division needed.
      this.headMarker.setPosition(target.x * 100, target.y * 100)
    })

    const markerPanelEl = this.root.querySelector<HTMLDivElement>('#marker-panel')!
    this.markerPanel = new MarkerPanel(markerPanelEl)

    /**
     * A new marker attaches to the current selection's first measure (the
     * timeline's `measure_index`, looked up via the selection's start elid)
     * — matching the "click-drag-select" direct-manipulation style the loop
     * feature already uses, rather than a separate "pick a measure" step.
     */
    this.markerPanel.onRequestMeasureIndex(() => {
      const active = this.activeTab()
      if (!active || active.kind !== 'mscz' || !active.timeline || !active.selection) return null
      const event = active.timeline.events.find((e) => e.source_elid === active.selection!.startElid)
      return event?.measure_index ?? null
    })
    this.markerPanel.onJumpToMeasure((measureIndex) => this.jumpToMeasure(measureIndex))

    const piecesIndexEl = this.root.querySelector<HTMLDivElement>('#pieces-index')!
    this.piecesIndex = new PiecesIndex(piecesIndexEl)
    this.piecesIndex.onJumpToElid((elid) => this.jumpToElid(elid))

    this.cursorBoxEl = document.createElement('div')
    this.cursorBoxEl.style.position = 'absolute'
    this.cursorBoxEl.style.border = '2px solid var(--cursor-box)'
    this.cursorBoxEl.style.background = 'var(--cursor-fill)'
    this.cursorBoxEl.style.pointerEvents = 'none'
    this.cursorBoxEl.style.display = 'none'

    /**
     * Always-visible playback-head indicator (unlike cursorBoxEl, which only
     * shows while actively playing) — one shared instance, re-mounted onto
     * whichever tab's page-stage is active, same lifecycle as cursorBoxEl.
     */
    this.headMarker = new PlaybackHeadMarker()

    for (const [value, btn] of Object.entries(this.speedButtons)) {
      btn.addEventListener('click', () => this.setSpeed(Number(value)))
    }
    this.speedButtons[1.0].classList.add('active')

    this.metronomeCheckbox.addEventListener('change', () => {
      void setMetronomeEnabled(this.metronomeCheckbox.checked)
    })

    this.markingModeCheckbox.addEventListener('change', () => {
      const active = this.activeTab()
      if (!active || active.kind !== 'pdf') return
      active.markingMode = this.markingModeCheckbox.checked
      active.calibrationOverlay.setMarkingMode(active.markingMode)
      this.suggestBarlinesBtn.style.display = active.markingMode ? 'inline-block' : 'none'
      this.clearPointsBtn.style.display = active.markingMode ? 'inline-block' : 'none'
      this.calibrationStatusEl.textContent = this.markingModeStatusText(active)
    })

    this.suggestBarlinesBtn.addEventListener('click', async () => {
      const active = this.activeTab()
      if (!active || active.kind !== 'pdf') return
      const canvas = active.canvasContainer.querySelector('canvas')
      if (!canvas) return
      this.suggestBarlinesBtn.disabled = true
      try {
        const pngBytes = await canvasToPngBytes(canvas)
        const systems = await detectBarlines(pngBytes)
        const count = systems.reduce((n, s) => n + s.barline_xs.length, 0)
        active.calibrationOverlay.addPointsFromBarlines(systems)
        this.calibrationStatusEl.textContent = `Added ${count} calibration point(s) from detected barlines — double-check them, the detector isn't always right.`
      } catch (e) {
        console.error('Failed to detect barlines:', e)
        this.calibrationStatusEl.textContent = `Barline suggestion failed: ${e instanceof Error ? e.message : String(e)}`
      } finally {
        this.suggestBarlinesBtn.disabled = false
      }
    })

    this.clearPointsBtn.addEventListener('click', () => {
      const active = this.activeTab()
      if (!active || active.kind !== 'pdf') return
      const count = active.calibrationOverlay.getPoints().length
      if (count === 0) return
      if (!window.confirm(`Remove all ${count} calibration point(s) for this file? This can't be undone.`)) return
      active.calibrationOverlay.clearAllPoints()
      this.calibrationStatusEl.textContent = this.markingModeStatusText(active)
    })

    this.zoomOutBtn.addEventListener('click', () => this.zoomActiveTab(-ZOOM_STEP))
    this.zoomInBtn.addEventListener('click', () => this.zoomActiveTab(ZOOM_STEP))
    this.fitWidthBtn.addEventListener('click', () => this.fitActiveTabToWidth())
    this.fitHeightBtn.addEventListener('click', () => this.fitActiveTabToHeight())
    this.zoomResetBtn.addEventListener('click', () => this.resetActiveTabZoom())
    this.bookModeBtn.addEventListener('click', () => void this.toggleBookModeForActiveTab())

    /** Ctrl/Cmd+scroll zooms the active tab's page, like a PDF viewer or image editor — matches the gesture users expect instead of scrolling the page area. */
    this.pageContainerEl.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        this.zoomActiveTab(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
      },
      { passive: false },
    )

    this.playBtn.addEventListener('click', () => this.togglePlayPause())
    this.stopBtn.addEventListener('click', () => void this.stopActive())

    /** Spacebar toggles play/pause for the active tab, like a standard media player — same logic as the Play button's own click handler. */
    window.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'SELECT')) return
      if (!this.isVisible()) return
      e.preventDefault()
      this.togglePlayPause()
    })

    /** Escape stops playback outright, like the Stop button — a distinct action from Space's play/pause toggle. */
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (!this.isVisible()) return
      void this.stopActive()
    })

    /** F toggles zen mode (hide toolbar/sidebar/tab-bar, sheet only) — every other shortcut keeps working since they're all window-level listeners gated on isVisible(), never on whether the now-hidden controls are present in the DOM. */
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'f' && e.key !== 'F') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (!this.isVisible()) return
      e.preventDefault()
      this.toggleZenMode()
    })

    if (isTauri()) {
      // Desktop: use the native file dialog instead of the plain HTML file
      // input. `<input type="file">` never exposes the real filesystem path
      // (a deliberate browser security restriction), so files opened that way
      // couldn't be recorded in the recent-files list (no `path` to record) —
      // confirmed as the cause of PDFs (and .mscz files) never showing up there
      // when opened via this picker rather than drag-drop. The dialog plugin's
      // `open()` returns the real path, same as a dropped file's path.
      this.fileInput.style.display = 'none'
      this.openFileBtn.style.display = 'inline-block'
      this.openFileBtn.addEventListener('click', async () => {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const { readFile } = await import('@tauri-apps/plugin-fs')
        const path = await open({
          multiple: false,
          filters: [{ name: 'Scores', extensions: ['mscz', 'mscx', 'pdf'] }],
        })
        if (!path || Array.isArray(path)) return
        const bytes = await readFile(path)
        const filename = path.split(/[/\\]/).pop() ?? path
        await this.openBytes(bytes, filename, path)
      })
    } else {
      this.fileInput.addEventListener('change', async () => {
        const file = this.fileInput.files?.[0]
        if (!file) return
        const bytes = new Uint8Array(await file.arrayBuffer())
        await this.openBytes(bytes, file.name, null)
      })
    }

    this.prevBtn.addEventListener('click', () => this.goToPrevPage())
    this.nextBtn.addEventListener('click', () => this.goToNextPage())

    /** Left/Right arrow keys navigate pages, like a standard document viewer — ignored while a text input/button/select has focus (arrow keys have native meaning there: caret movement, button/option navigation). */
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'SELECT')) return
      if (!this.isVisible()) return
      e.preventDefault()
      if (e.key === 'ArrowLeft') this.goToPrevPage()
      else this.goToNextPage()
    })

    if (isTauri()) {
      // Desktop: dropped paths come from the OS, read as bytes via tauri-plugin-fs.
      // (dynamic imports keep these Tauri-only packages out of the web/server bundle)
      Promise.all([import('@tauri-apps/api/webview'), import('@tauri-apps/plugin-fs')]).then(
        ([{ getCurrentWebview }, { readFile }]) => {
          getCurrentWebview().onDragDropEvent(async (event) => {
            if (!this.isVisible()) return
            if (event.payload.type === 'enter' || event.payload.type === 'over') {
              this.dropOverlay.style.display = 'flex'
              return
            }
            this.dropOverlay.style.display = 'none'
            if (event.payload.type !== 'drop') return

            const path = event.payload.paths.find(isOpenableFile) ?? event.payload.paths[0]
            if (!path) return
            const bytes = await readFile(path)
            const filename = path.split(/[/\\]/).pop() ?? path
            await this.openBytes(bytes, filename, path)
          })
        },
      )
    } else {
      // Web/server: read dropped bytes client-side via the browser's DataTransfer API.
      window.addEventListener('dragover', (e) => {
        if (!this.isVisible()) return
        e.preventDefault()
        this.dropOverlay.style.display = 'flex'
      })
      window.addEventListener('dragleave', (e) => {
        if (!this.isVisible()) return
        if (e.target === document.documentElement || e.relatedTarget === null) {
          this.dropOverlay.style.display = 'none'
        }
      })
      window.addEventListener('drop', async (e) => {
        if (!this.isVisible()) return
        e.preventDefault()
        this.dropOverlay.style.display = 'none'
        const file = e.dataTransfer?.files[0]
        if (!file) return
        const bytes = new Uint8Array(await file.arrayBuffer())
        await this.openBytes(bytes, file.name, null)
      })
    }

    // Manual test hooks retained for Playwright/manual verification during development.
    ;(window as unknown as { __musepracticeOpenBytes: (bytes: Uint8Array, filename: string) => Promise<void> }).__musepracticeOpenBytes = (
      bytes: Uint8Array,
      filename: string,
    ) => this.openBytes(bytes, filename, null)
    ;(window as unknown as { __musepracticePageView: () => PageDisplay | null }).__musepracticePageView = () => {
      const active = this.activeTab()
      return active?.kind === 'mscz' ? active.pageView : null
    }
    ;(window as unknown as { __musepracticeGetTimeline: () => Timeline | null }).__musepracticeGetTimeline = () => {
      const active = this.activeTab()
      return active?.kind === 'mscz' ? active.timeline : null
    }
  }

  /** Called every time a file finishes opening and is recorded as a recent file. */
  onFileOpened(callback: () => void): void {
    this.onFileOpenedCallback = callback
  }

  private isVisible(): boolean {
    return this.root.style.display !== 'none'
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none'
  }

  private activeTab(): TabState | null {
    return this.activeHash ? this.tabs.get(this.activeHash) ?? null : null
  }

  /**
   * Mounts `cursorBoxEl`/`headMarker.el` onto whichever concrete page-stage
   * is currently showing `page` for `tab` — a no-op if that stage isn't
   * found (shouldn't happen for an mscz tab whose pageView already contains
   * `page`, but `stageFor` returning `null` is treated as "nothing to mount
   * onto" rather than throwing). In single-page mode this is always the same
   * one stage; in book mode it's whichever of the two sides actually holds
   * `page`, since the two sides are never on the same page as each other.
   */
  private mountOverlaysOnPage(tab: MsczTabState, page: number): void {
    const stage = tab.pageView.stageFor(page)
    if (!stage) return
    if (this.cursorBoxEl.parentElement !== stage) stage.appendChild(this.cursorBoxEl)
    if (this.headMarker.el.parentElement !== stage) stage.appendChild(this.headMarker.el)
  }

  /** Native page width/height (from the given page's own rendered SVG viewBox) for `tab` — the basis for the cursor box/head marker's percentage-of-page positioning. Falls back to 1 (avoids a divide-by-zero NaN) if that page isn't currently rendered anywhere. */
  private pageSize(tab: MsczTabState, page: number): { width: number; height: number } {
    const svg = tab.pageView.stageFor(page)?.querySelector('svg')
    const viewBox = svg?.getAttribute('viewBox')?.split(' ')
    if (!viewBox || viewBox.length < 4) return { width: 1, height: 1 }
    return { width: parseFloat(viewBox[2]) || 1, height: parseFloat(viewBox[3]) || 1 }
  }

  private renderTabBar(): void {
    const tabInfos: TabInfo[] = Array.from(this.tabs.values()).map((t) => ({ fileHash: t.fileHash, title: t.title }))
    this.tabBar.setTabs(tabInfos, this.activeHash)
  }

  /**
   * Converts a drag-selected elid range to a `[loop_start_ms, loop_end_ms]`
   * pair in the timeline's flattened (1.0x) space, for `setLoopRegion`.
   * `loop_end_ms` is the start time of the event *after* the last matching
   * one (or the timeline's duration if the selection reaches the end), so the
   * loop plays out the full duration of the last selected measure rather than
   * cutting off at its start.
   */
  private loopRegionForSelection(timeline: Timeline, range: MeasureRange): [number, number] | null {
    const matching = timeline.events
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => e.source_elid >= range.startElid && e.source_elid <= range.endElid)
    if (matching.length === 0) return null

    const startMs = Math.min(...matching.map(({ e }) => e.time_ms))
    const lastIndex = Math.max(...matching.map(({ index }) => index))
    const endMs = timeline.events[lastIndex + 1]?.time_ms ?? timeline.duration_ms
    return [startMs, endMs]
  }

  private async setLoop(range: MeasureRange | null): Promise<void> {
    const active = this.activeTab()
    if (!active || active.kind !== 'mscz') return
    active.loopRegion = (active.timeline && range && this.loopRegionForSelection(active.timeline, range)) || null
    this.loopStatusEl.textContent = active.loopRegion
      ? `Looping measures (elid ${range!.startElid}-${range!.endElid})`
      : ''
    await setLoopRegion(active.loopRegion)
  }

  /**
   * Same idea as `loopRegionForSelection`, but over calibration points
   * instead of `TimelineEvent`s — calibration points are "converting the PDF
   * to .mscz, but only the measure-boundary part," so this mirrors
   * `loopRegionForSelection`'s "end at the start of the next item after the
   * selection" rule exactly, just against `points[]`/`time_ms` instead of
   * `timeline.events[]`.
   */
  private loopRegionForPointRange(points: CalibrationPoint[], range: PointRange): [number, number] | null {
    if (points.length === 0) return null
    const startMs = points[range.startIndex]?.time_ms
    if (startMs === undefined) return null
    const endMs = points[range.endIndex + 1]?.time_ms ?? points[points.length - 1].time_ms + 2000
    return [startMs, endMs]
  }

  private async setPdfLoop(range: PointRange | null): Promise<void> {
    const active = this.activeTab()
    if (!active || active.kind !== 'pdf') return
    const points = active.calibrationOverlay.getPoints()
    active.loopRegion = (range && this.loopRegionForPointRange(points, range)) || null
    this.loopStatusEl.textContent = active.loopRegion
      ? `Looping between calibration points ${range!.startIndex}-${range!.endIndex}`
      : ''
    await setLoopRegion(active.loopRegion)
  }

  private setSpeed(speed: number): void {
    const active = this.activeTab()
    if (active) active.speed = speed
    for (const [value, btn] of Object.entries(this.speedButtons)) {
      btn.classList.toggle('active', Number(value) === speed)
    }
    void setPlaybackSpeed(speed)
  }

  private jumpToMeasure(measureIndex: number): void {
    const active = this.activeTab()
    if (!active || active.kind !== 'mscz' || !active.timeline) return
    const event = active.timeline.events.find((e) => e.measure_index === measureIndex)
    if (!event) return
    if (!active.pageView.stageFor(event.page)) {
      void active.pageView.showPage(event.page)
    }
  }

  /**
   * Pieces (unlike markers) are detected from the raw .mscx XML in document
   * order (crates/core/src/pieces.rs), the same index space as webmscore's
   * *printed, non-unrolled* `measurePositions().elements[]` — i.e. `elid`
   * space, not `TimelineEvent.measure_index`'s unrolled-events space. These
   * two numbers only coincide before any repeat has played; past the first
   * repeat they diverge, so a piece boundary must be looked up by
   * `source_elid`, not `measure_index`, or jumps land on the wrong page for
   * every piece after the first repeat anywhere earlier in the file.
   */
  private jumpToElid(elid: number): void {
    const active = this.activeTab()
    if (!active || active.kind !== 'mscz' || !active.timeline) return
    const event = active.timeline.events.find((e) => e.source_elid === elid)
    if (!event) return
    if (!active.pageView.stageFor(event.page)) {
      void active.pageView.showPage(event.page)
    }
  }

  /**
   * Stops the shared Rust player for every tab switch — the backend has no
   * per-tab state (one global `Player`), so a tab that was mid-play or paused
   * loses that backend state the moment another tab's audio needs the engine.
   * `departing`'s transportState is forced back to 'stopped' (but its `headMs`
   * is left untouched — it's purely a frontend position, not something
   * stopMidi() can meaningfully preserve) so reactivating it later starts
   * fresh rather than claiming to still be paused.
   */
  private async stopAudioForTabSwitch(departing?: TabState): Promise<void> {
    await stopMidi()
    this.msczCursor.stop()
    this.pdfCursor.stop()
    if (departing) departing.transportState = 'stopped'
    this.playBtn.disabled = true
    this.stopBtn.disabled = true
  }

  /** Mounts `tab.pageContainer` as the visible page, restores its UI state (speed/loop/selection), and re-points the shared panels. */
  private async activateTab(tab: TabState): Promise<void> {
    this.activeHash = tab.fileHash
    this.pageContainerEl.innerHTML = ''
    this.pageContainerEl.appendChild(tab.pageContainer)
    this.emptyStateEl.style.display = 'none'

    this.statusEl.textContent = tab.title
    this.calibrationStatusEl.textContent = ''
    this.pdfControlsEl.style.display = tab.kind === 'pdf' ? 'flex' : 'none'
    this.transportEl.style.display = 'flex'
    this.zoomGroupEl.style.display = 'flex'
    // Book mode needs SelectionOverlay's measure-box model, which PDF
    // mode's CalibrationOverlay doesn't share an interface with — see
    // BookPageView's module docs. Hidden rather than disabled for PDF tabs,
    // same treatment the .mscz-only transport controls already get.
    this.bookModeBtn.style.display = tab.kind === 'mscz' ? 'inline-block' : 'none'
    if (tab.kind === 'mscz') this.bookModeBtn.classList.toggle('active', tab.bookMode)
    void this.loadRatingForTab(tab)

    if (tab.kind === 'mscz') {
      this.cursorBoxEl.style.display = 'none'
      this.mountOverlaysOnPage(tab, tab.pageView.page)
      tab.transportState = 'stopped'

      // PageView's onPageChange callback (which normally drives this) is
      // gated on `activeHash === tabState.fileHash` — but openMsczBytes's
      // initial `showPage(0)` runs *before* activateTab ever sets activeHash,
      // so that first call is silently skipped and SelectionOverlay never
      // gets its measure boxes for the page shown on open. Syncing it
      // directly here (now that activeHash is correctly set, line 1 of this
      // function) guarantees it's populated every time the tab becomes
      // active, independent of that callback's timing.
      const positions = tab.pageView.getPositions()
      if (positions) tab.selectionOverlay.resync(positions.elements, tab.pageView.page)

      this.navEl.style.display = tab.pageView.pages > 1 ? 'flex' : 'none'
      this.pageIndicatorEl.textContent = `Page ${tab.pageView.page + 1} / ${tab.pageView.pages}`
      this.prevBtn.disabled = tab.pageView.page <= 0
      this.nextBtn.disabled = tab.pageView.page >= tab.pageView.pages - 1
      this.selectionStatusEl.textContent = tab.selection
        ? `Selected measures (elid ${tab.selection.startElid}-${tab.selection.endElid})`
        : ''
      this.loopStatusEl.textContent = tab.loopRegion ? 'Looping selected measures' : ''
      this.zoomIndicatorEl.textContent = `${Math.round(tab.pageView.getZoom() * 100)}%`
      this.zoomOutBtn.disabled = tab.pageView.getZoom() <= MIN_ZOOM
      this.zoomInBtn.disabled = tab.pageView.getZoom() >= MAX_ZOOM

      this.msczCursor.setItems(tab.timeline?.events ?? null)
      this.pdfCursor.setItems(null)
      await this.markerPanel.setFileHash(tab.fileHash)
      await this.piecesIndex.setScoreBytes(tab.originalBytes)

      const hasAudio = tab.timeline !== null
      this.renderTransportButtons(tab.transportState, hasAudio)
      for (const btn of Object.values(this.speedButtons)) btn.disabled = !hasAudio
      this.metronomeCheckbox.disabled = !hasAudio

      if (hasAudio) {
        this.setSpeed(tab.speed)
        const midiBytes = await getMidi(tab.score)
        await loadMidi(midiBytes)
        await setLoopRegion(tab.loopRegion)
        await setMetronomeEnabled(this.metronomeCheckbox.checked)
        this.updateMsczHeadMarker(tab)
      }
    } else {
      tab.canvasContainer.appendChild(this.headMarker.el)
      tab.transportState = 'stopped'
      this.selectionStatusEl.textContent = tab.selectedRange
        ? `Selected calibration points ${tab.selectedRange.startIndex}-${tab.selectedRange.endIndex}`
        : ''
      this.loopStatusEl.textContent = tab.loopRegion ? 'Looping between calibration points' : ''
      this.calibrationStatusEl.textContent = this.markingModeStatusText(tab)
      this.markingModeCheckbox.checked = tab.markingMode
      tab.calibrationOverlay.setMarkingMode(tab.markingMode)
      this.suggestBarlinesBtn.style.display = tab.markingMode ? 'inline-block' : 'none'
      this.clearPointsBtn.style.display = tab.markingMode ? 'inline-block' : 'none'
      this.zoomIndicatorEl.textContent = `${Math.round(tab.zoom * 100)}%`
      this.zoomOutBtn.disabled = tab.zoom <= PDF_MIN_ZOOM
      this.zoomInBtn.disabled = tab.zoom >= PDF_MAX_ZOOM

      this.msczCursor.setItems(null)
      this.pdfCursor.setItems(tab.calibrationOverlay.getPoints())
      await this.markerPanel.setFileHash(null)
      await this.piecesIndex.setScoreBytes(null)

      this.navEl.style.display = tab.pageCount > 1 ? 'flex' : 'none'
      this.pageIndicatorEl.textContent = `Page ${tab.currentPage + 1} / ${tab.pageCount}`
      this.prevBtn.disabled = tab.currentPage <= 0
      this.nextBtn.disabled = tab.currentPage >= tab.pageCount - 1
      // Re-render on every reactivation rather than trusting the previously
      // mounted canvas: pdf.js's PDFPageProxy caches per-page render state
      // internally, and a concurrent render from autoScanBarlines (which runs
      // in the background across every page right after a PDF is opened) can
      // land mid-flight while this tab is inactive, leaving the visible canvas
      // blank on the next switch-back. Cheap enough to always redo — a single
      // page re-render, not the whole document.
      await this.showPdfPage(tab, tab.currentPage)
      this.updatePdfHeadMarker(tab)

      const hasAudio = tab.points.length >= 2
      this.renderTransportButtons(tab.transportState, hasAudio)
      for (const btn of Object.values(this.speedButtons)) btn.disabled = !hasAudio
      this.metronomeCheckbox.disabled = !hasAudio

      if (hasAudio) {
        this.setSpeed(tab.speed)
        await this.loadPdfTabTempoMap(tab)
        await setLoopRegion(tab.loopRegion)
        await setMetronomeEnabled(this.metronomeCheckbox.checked)
      }
    }

    this.renderTabBar()
  }

  /** Derives and loads the tempo map for a PDF tab's current calibration points, for metronome-only playback. */
  private async loadPdfTabTempoMap(tab: PdfTabState): Promise<void> {
    const durationMs = Math.max(...tab.points.map((p) => p.time_ms)) + 4000
    await loadPdfTempoMap(tab.points, tab.numerator, durationMs)
  }

  private markingModeStatusText(tab: PdfTabState): string {
    return tab.markingMode
      ? `Marking mode: click the page to add a calibration point. ${tab.points.length} point(s) so far.`
      : `${tab.points.length} calibration point(s). Turn on "Mark measures" to add or remove them.`
  }

  /** Shows/loads the current tab's "knowledge level" rating in the status bar — hidden entirely for a tab with no stable file_hash (desktop hashing failed, or running outside Tauri), since rating has nothing to key off. */
  private async loadRatingForTab(tab: TabState): Promise<void> {
    if (!isTauri() || tab.fileHash.startsWith('untracked-')) {
      this.ratingMountEl.style.display = 'none'
      return
    }
    this.ratingMountEl.style.display = 'inline-flex'
    let level: KnowledgeLevel | null = null
    try {
      level = await getKnowledgeLevel(tab.fileHash)
    } catch (e) {
      console.error('Failed to load knowledge level:', e)
    }
    if (this.activeHash !== tab.fileHash) return // tab switched again while this was in flight
    this.ratingStars.setLevel(level)
  }

  private async handleRatingChange(level: KnowledgeLevel | null): Promise<void> {
    const active = this.activeTab()
    if (!active || active.fileHash.startsWith('untracked-')) return
    try {
      const applied = await setKnowledgeLevel(active.fileHash, level)
      this.ratingStars.setLevel(applied)
    } catch (e) {
      console.error('Failed to set knowledge level:', e)
    }
  }

  private setPdfZoom(tab: PdfTabState, zoom: number): void {
    tab.zoom = Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom))
    this.zoomIndicatorEl.textContent = `${Math.round(tab.zoom * 100)}%`
    this.zoomOutBtn.disabled = tab.zoom <= PDF_MIN_ZOOM
    this.zoomInBtn.disabled = tab.zoom >= PDF_MAX_ZOOM
    void this.showPdfPage(tab, tab.currentPage)
  }

  /** Zooms the active tab (either kind) by `delta` (positive = in, negative = out) — shared by the +/- buttons and ctrl+wheel. */
  private zoomActiveTab(delta: number): void {
    const active = this.activeTab()
    if (!active) return
    if (active.kind === 'mscz') {
      active.pageView.setZoom(active.pageView.getZoom() + delta)
    } else {
      this.setPdfZoom(active, active.zoom + delta * (PDF_ZOOM_STEP / ZOOM_STEP))
    }
  }

  /** `.page-area`'s content box, minus its own padding — the space a fit-to-width/height zoom should fill. */
  private pageAreaAvailableSize(): { width: number; height: number } {
    const style = getComputedStyle(this.pageContainerEl)
    const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    return {
      width: this.pageContainerEl.clientWidth - paddingX,
      height: this.pageContainerEl.clientHeight - paddingY,
    }
  }

  /**
   * PDF zoom isn't a pure CSS scale (unlike .mscz's SVG) — every zoom change
   * re-renders the canvas at a new resolution via showPdfPage, so there's no
   * live viewBox to read a native aspect ratio from the way PageView does.
   * Backs it out instead from the *currently mounted* canvas's own pixel size
   * together with the zoom it was rendered at (canvas.width/height already
   * bakes in devicePixelRatio too, which cancels out of the ratio).
   */
  private pdfNativeAspectRatio(tab: PdfTabState): number | null {
    const canvas = tab.canvasContainer.querySelector('canvas')
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null
    return canvas.width / canvas.height
  }

  private fitActiveTabToWidth(): void {
    const active = this.activeTab()
    if (!active) return
    const { width } = this.pageAreaAvailableSize()
    if (active.kind === 'mscz') {
      active.pageView.setZoomToWidth(width)
    } else {
      this.setPdfZoom(active, width / PDF_BASE_WIDTH)
    }
  }

  private fitActiveTabToHeight(): void {
    const active = this.activeTab()
    if (!active) return
    const { height } = this.pageAreaAvailableSize()
    if (active.kind === 'mscz') {
      active.pageView.setZoomToHeight(height)
    } else {
      const aspect = this.pdfNativeAspectRatio(active)
      if (!aspect) return
      const renderedHeightAtZoom1 = PDF_BASE_WIDTH / aspect
      this.setPdfZoom(active, height / renderedHeightAtZoom1)
    }
  }

  private resetActiveTabZoom(): void {
    const active = this.activeTab()
    if (!active) return
    if (active.kind === 'mscz') active.pageView.setZoom(1)
    else this.setPdfZoom(active, 1)
  }

  private async switchToTab(fileHash: string): Promise<void> {
    if (fileHash === this.activeHash) return
    const tab = this.tabs.get(fileHash)
    if (!tab) return
    await this.stopAudioForTabSwitch(this.activeTab() ?? undefined)
    await this.activateTab(tab)
  }

  private closeTab(fileHash: string): void {
    const tab = this.tabs.get(fileHash)
    if (!tab) return
    if (tab.kind === 'mscz') {
      tab.selectionOverlay.destroy()
      tab.score.destroy()
    } else {
      tab.calibrationOverlay.destroy()
    }
    this.tabs.delete(fileHash)

    if (this.activeHash === fileHash) {
      this.activeHash = null
      const next = this.tabs.values().next().value as TabState | undefined
      if (next) {
        void this.stopAudioForTabSwitch().then(() => this.activateTab(next))
      } else {
        void this.stopAudioForTabSwitch()
        this.pageContainerEl.innerHTML = ''
        this.pageContainerEl.appendChild(this.emptyStateEl)
        this.emptyStateEl.style.display = 'flex'
        this.navEl.style.display = 'none'
        this.transportEl.style.display = 'none'
        this.zoomGroupEl.style.display = 'none'
        this.pdfControlsEl.style.display = 'none'
        this.statusEl.textContent = ''
        this.selectionStatusEl.textContent = ''
        this.loopStatusEl.textContent = ''
        this.calibrationStatusEl.textContent = ''
        this.ratingMountEl.style.display = 'none'
        void this.markerPanel.setFileHash(null)
        void this.piecesIndex.setScoreBytes(null)
        this.playBtn.disabled = true
        this.stopBtn.disabled = true
        for (const btn of Object.values(this.speedButtons)) btn.disabled = true
        this.metronomeCheckbox.disabled = true
      }
    }
    this.renderTabBar()
  }

  async openBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
    if (isPdfFile(filename)) {
      await this.openPdfBytes(bytes, filename, path)
    } else {
      await this.openMsczBytes(bytes, filename, path)
    }
  }

  /**
   * Builds the `pageView`/`selectionOverlay` pair for an `.mscz` tab, in
   * either single-page (`PageView`+`SelectionOverlay`) or book/two-page
   * (`BookPageView`, which owns an equivalent pair internally — see its
   * module docs) mode. `getTabState` is a lazy accessor rather than the
   * `MsczTabState` object itself because the callbacks wired up here need to
   * close over it before it exists yet (it's constructed from this method's
   * own return value) — by the time any of these callbacks actually fire,
   * the caller has long since finished constructing the real tab state.
   */
  private createMsczPageDisplay(
    pageContainer: HTMLDivElement,
    bookMode: boolean,
    getTabState: () => MsczTabState,
  ): { pageView: PageDisplay; selectionOverlay: SelectionSource } {
    const onPageChange = (page: number, pages: number): void => {
      const tabState = getTabState()
      if (this.activeHash !== tabState.fileHash) return
      this.pageIndicatorEl.textContent = `Page ${page + 1} / ${pages}`
      this.prevBtn.disabled = page <= 0
      this.nextBtn.disabled = page >= pages - 1
      this.selectionStatusEl.textContent = ''
    }
    const onZoomChange = (zoom: number): void => {
      const tabState = getTabState()
      if (this.activeHash !== tabState.fileHash) return
      this.zoomIndicatorEl.textContent = `${Math.round(zoom * 100)}%`
      this.zoomOutBtn.disabled = zoom <= MIN_ZOOM
      this.zoomInBtn.disabled = zoom >= MAX_ZOOM
    }

    let pageView: PageDisplay
    let selectionOverlay: SelectionSource
    if (bookMode) {
      const book = new BookPageView(pageContainer, onPageChange, onZoomChange)
      pageView = book
      selectionOverlay = book
    } else {
      const singlePageView = new PageView(
        pageContainer,
        (page, pages, positions) => {
          onPageChange(page, pages)
          if (positions) singleSelectionOverlay.setPage(positions.elements, page)
        },
        onZoomChange,
      )
      const singleSelectionOverlay = new SelectionOverlay(pageContainer)
      pageView = singlePageView
      selectionOverlay = singleSelectionOverlay
    }

    selectionOverlay.onSelect((range) => {
      const tabState = getTabState()
      tabState.selection = range
      void this.setLoop(range)
      if (range && tabState.timeline) {
        const loopRegion = this.loopRegionForSelection(tabState.timeline, range)
        if (loopRegion) void this.seekActive(tabState, loopRegion[0])
      }
      if (this.activeHash !== tabState.fileHash) return
      this.selectionStatusEl.textContent = range
        ? `Selected measures (elid ${range.startElid}-${range.endElid})`
        : ''
    })

    selectionOverlay.onSeek((elid) => {
      const tabState = getTabState()
      const event = tabState.timeline?.events.find((e) => e.source_elid === elid)
      if (event) void this.seekActive(tabState, event.time_ms)
    })

    return { pageView, selectionOverlay }
  }

  private async openMsczBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
    this.statusEl.textContent = `Loading ${filename}...`

    // webmscore's worker-based load() transfers `data.buffer` into the worker
    // (an explicit `Transferable`, see node_modules/webmscore/src/worker-helper.js),
    // which detaches the original ArrayBuffer as a side effect — `bytes` itself
    // becomes unusable (reads throw "detached ArrayBuffer") immediately after
    // `openScore` returns. Keep a copy for anything needed later (e.g. hashing
    // the original file for markers).
    const originalBytes = bytes.slice()

    let result: OpenScoreResult
    try {
      result = await openScore(bytes)
    } catch (e) {
      this.statusEl.textContent = `Failed to open ${filename}: ${e instanceof Error ? e.message : String(e)}`
      return
    }

    let { score } = result
    const { needsUpgrade, metadata } = result

    // Upgrading is purely an in-memory re-save inside webmscore's own engine
    // (to the format version it natively works with) — it never touches the
    // user's original file on disk (upgradeScore's return value is only ever
    // persisted into this app's own cache, keyed by the *original* file's
    // hash — see the comment on hashing below). Nothing for the user to
    // decide here, so no confirmation prompt.
    if (needsUpgrade) {
      const upgradedBytes = await upgradeScore(score)
      score.destroy()
      result = await openScore(upgradedBytes)
      score = result.score
    }

    const title = metadata.title || filename

    // Hashed from `originalBytes` (captured before openScore() detaches the
    // original buffer), not any upgraded re-save of it — markers/tabs should
    // stay anchored to "this piece" across an MS4 upgrade round-trip, not fork
    // onto a new key.
    let fileHash: string | null = null
    if (isTauri()) {
      try {
        fileHash = await contentHash(originalBytes, filename)
      } catch (e) {
        console.error('Failed to compute file hash:', e)
        this.statusEl.textContent = `${title} opened, but markers/tabs are unavailable: ${e instanceof Error ? e.message : String(e)}`
      }
    }

    // Reopening a file that's already open as a tab just switches to it,
    // rather than creating a duplicate tab for the same score — still record
    // it as just-opened so its recency bumps in the library view's recent
    // list, exactly as if a fresh tab had been created.
    if (fileHash && this.tabs.has(fileHash)) {
      score.destroy()
      if (path) await this.recordAndNotifyRecentFile(path, fileHash, title)
      await this.switchToTab(fileHash)
      return
    }

    await this.stopAudioForTabSwitch(this.activeTab() ?? undefined)

    const pageContainer = document.createElement('div')
    pageContainer.className = 'page-stage'

    const { pageView, selectionOverlay } = this.createMsczPageDisplay(pageContainer, false, () => tabState)

    const tabState: MsczTabState = {
      kind: 'mscz',
      fileHash: fileHash ?? `untracked-${Date.now()}`,
      title,
      score,
      pageView,
      selectionOverlay,
      pageContainer,
      timeline: null,
      selection: null,
      speed: 1.0,
      loopRegion: null,
      originalBytes,
      transportState: 'stopped',
      headMs: 0,
      bookMode: false,
    }

    await pageView.setScore(score, metadata.pages)
    await pageView.showPage(0)

    if (isTauri() && fileHash) {
      const positions = await getMeasurePositions(score)
      const midiBytes = await getMidi(score)
      const { timeline } = await importTimeline(positions, midiBytes)
      tabState.timeline = timeline

      if (path) {
        await this.recordAndNotifyRecentFile(path, fileHash, title)
      }
    }

    this.tabs.set(tabState.fileHash, tabState)
    await this.activateTab(tabState)
  }

  /** Records the file in the recent-files list and tells the library view to refresh (it owns the visible recent-files UI now). */
  private async recordAndNotifyRecentFile(path: string, fileHash: string, title: string): Promise<void> {
    try {
      await recordRecentFile(path, fileHash, title)
    } catch (e) {
      console.error('Failed to record recent file:', e)
    }
    this.onFileOpenedCallback?.()
  }

  private async openPdfBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
    this.statusEl.textContent = `Loading ${filename}...`

    // pdf.js's getDocument() transfers `data.buffer` into its worker (passed
    // as an explicit Transferable in its internal postMessage call — see
    // node_modules/pdfjs-dist/build/pdf.mjs's GetDocRequest handling), which
    // detaches the original ArrayBuffer as a side effect, exactly like
    // webmscore's worker does for .mscz bytes (see openMsczBytes's comment).
    // Reading `bytes` again afterward (e.g. to hash it) silently throws,
    // which was quietly skipping calibration loading AND recent-files
    // recording for every PDF open — confirmed as the actual cause of PDFs
    // never showing up in Recent Files even via drag-drop (a real `path` was
    // always present; `fileHash` just silently came back null). Keep a real
    // copy before calling loadPdf(), same fix as the .mscz path.
    const originalBytes = bytes.slice()

    let doc: PdfDocument
    try {
      doc = await loadPdf(bytes)
    } catch (e) {
      this.statusEl.textContent = `Failed to open ${filename}: ${e instanceof Error ? e.message : String(e)}`
      return
    }

    const title = filename

    let fileHash: string | null = null
    if (isTauri()) {
      try {
        fileHash = await hashBytes(originalBytes)
      } catch (e) {
        console.error('Failed to compute file hash:', e)
        this.statusEl.textContent = `${title} opened, but calibration is unavailable: ${e instanceof Error ? e.message : String(e)}`
      }
    }

    if (fileHash && this.tabs.has(fileHash)) {
      if (path) await this.recordAndNotifyRecentFile(path, fileHash, title)
      await this.switchToTab(fileHash)
      return
    }

    await this.stopAudioForTabSwitch(this.activeTab() ?? undefined)

    const pageContainer = document.createElement('div')
    pageContainer.style.position = 'relative'
    const canvasContainer = document.createElement('div')
    // Shrink-wraps exactly to the canvas's own CSS size (a plain block <div>
    // would otherwise stretch to its parent's full width, leaving blank space
    // to the right of the canvas whenever the zoomed canvas is narrower than
    // the available page width) — CalibrationOverlay positions its dots as
    // percentages of `canvasContainer`'s own box (`stage`'s `inset: 0`
    // children), so that box must exactly match the canvas's box or every
    // dot's position silently drifts off-target.
    canvasContainer.style.position = 'relative'
    canvasContainer.style.display = 'inline-block'
    canvasContainer.className = 'page-stage'
    pageContainer.appendChild(canvasContainer)
    // Theme tint/texture for the PDF canvas (see theme.css's .raster-overlay
    // comment) — a real element kept immediately after the <canvas> so it
    // paints above the page but below CalibrationOverlay's dots/drag-rect/form
    // layers, appended next.
    const rasterOverlay = document.createElement('div')
    rasterOverlay.className = 'raster-overlay'
    canvasContainer.appendChild(rasterOverlay)
    const calibrationOverlay = new CalibrationOverlay(canvasContainer)

    const tabState: PdfTabState = {
      kind: 'pdf',
      fileHash: fileHash ?? `untracked-${Date.now()}`,
      title,
      doc,
      pageCount: doc.numPages,
      currentPage: 0,
      zoom: 1,
      markingMode: false,
      pageContainer,
      canvasContainer,
      calibrationOverlay,
      points: [],
      selectedRange: null,
      numerator: PDF_DEFAULT_NUMERATOR,
      speed: 1.0,
      loopRegion: null,
      transportState: 'stopped',
      headMs: 0,
    }

    calibrationOverlay.onSelect((range) => {
      tabState.selectedRange = range
      void this.setPdfLoop(range)
      if (range) {
        const loopRegion = this.loopRegionForPointRange(calibrationOverlay.getPoints(), range)
        if (loopRegion) void this.seekActive(tabState, loopRegion[0])
      }
      if (this.activeHash !== tabState.fileHash) return
      this.selectionStatusEl.textContent = range
        ? `Selected calibration points ${range.startIndex}-${range.endIndex}`
        : ''
    })

    calibrationOverlay.onSeek((pointIndex) => {
      const point = calibrationOverlay.getPoints()[pointIndex]
      if (point) void this.seekActive(tabState, point.time_ms)
    })

    calibrationOverlay.onChange((points) => {
      tabState.points = points
      if (!tabState.fileHash.startsWith('untracked-')) {
        void saveCalibrationPoints(tabState.fileHash, points).catch((e) =>
          console.error('Failed to save calibration points:', e),
        )
      }
      if (this.activeHash !== tabState.fileHash) return
      this.calibrationStatusEl.textContent = this.markingModeStatusText(tabState)
      const hasAudio = points.length >= 2
      const isPlaying = !this.stopBtn.disabled
      this.playBtn.disabled = !hasAudio || isPlaying
      for (const btn of Object.values(this.speedButtons)) btn.disabled = !hasAudio
      this.metronomeCheckbox.disabled = !hasAudio
    })

    let needsAutoScan = false
    if (fileHash) {
      try {
        tabState.points = await listCalibrationPoints(fileHash)
        calibrationOverlay.setPoints(tabState.points)
        needsAutoScan = tabState.points.length === 0
      } catch (e) {
        console.error('Failed to load calibration points:', e)
      }

      if (path) {
        await this.recordAndNotifyRecentFile(path, fileHash, title)
      }
    }

    await this.showPdfPage(tabState, 0)

    this.tabs.set(tabState.fileHash, tabState)
    await this.activateTab(tabState)

    // Auto-scan only an uncalibrated PDF (fresh open, zero existing points) —
    // never re-scan one the user has already calibrated/corrected, which
    // would silently fight their edits. Runs after activateTab so the page is
    // already visible and the user isn't staring at a blank/unresponsive UI
    // while it works; renders each page to its own offscreen canvas (not
    // tab.canvasContainer) so it doesn't interfere with the user navigating
    // pages while the scan is still running in the background.
    if (needsAutoScan) {
      void this.autoScanBarlines(tabState)
    }
  }

  private async autoScanBarlines(tab: PdfTabState): Promise<void> {
    const pageResults: { page: number; systems: StaffSystem[]; canvasWidth: number; canvasHeight: number }[] = []
    for (let pageNumber = 0; pageNumber < tab.pageCount; pageNumber++) {
      if (!this.tabs.has(tab.fileHash)) return // tab closed mid-scan
      if (this.activeHash === tab.fileHash) {
        this.calibrationStatusEl.textContent = `Scanning for barlines: page ${pageNumber + 1} / ${tab.pageCount}...`
      }
      try {
        const canvas = await renderPdfPage(tab.doc, pageNumber + 1, PDF_BASE_WIDTH * tab.zoom)
        const pngBytes = await canvasToPngBytes(canvas)
        const systems = await detectBarlines(pngBytes)
        pageResults.push({ page: pageNumber, systems, canvasWidth: canvas.width, canvasHeight: canvas.height })
      } catch (e) {
        console.error(`Failed to scan page ${pageNumber + 1} for barlines:`, e)
      }
    }

    if (!this.tabs.has(tab.fileHash)) return
    tab.calibrationOverlay.addPointsFromBarlinesAcrossPages(pageResults)
    if (this.activeHash === tab.fileHash) {
      const count = pageResults.reduce((n, r) => n + r.systems.reduce((m, s) => m + s.barline_xs.length, 0), 0)
      this.calibrationStatusEl.textContent = `Auto-detected ${count} calibration point(s) across ${tab.pageCount} page(s) — double-check them, the detector isn't always right.`
    }
  }

  private async showPdfPage(tab: PdfTabState, pageNumber: number): Promise<void> {
    if (pageNumber < 0 || pageNumber >= tab.pageCount) return
    tab.currentPage = pageNumber
    const canvas = await renderPdfPage(tab.doc, pageNumber + 1, PDF_BASE_WIDTH * tab.zoom)
    if (tab.currentPage !== pageNumber) return // stale: navigated elsewhere while this render was in flight
    // Remove only the old <canvas>, not canvasContainer's whole subtree —
    // CalibrationOverlay's own layers (dots/drag-rect/form) are also mounted
    // inside canvasContainer (so they stay sized/positioned exactly to the
    // canvas, see that constructor call's comment), and innerHTML = '' would
    // silently detach them from the DOM on every page change/zoom, leaving
    // `render()` drawing into disconnected nodes nothing ever displays.
    tab.canvasContainer.querySelector('canvas')?.remove()
    tab.canvasContainer.insertBefore(canvas, tab.canvasContainer.firstChild)
    tab.calibrationOverlay.setPage(pageNumber)

    if (this.activeHash === tab.fileHash) {
      this.pageIndicatorEl.textContent = `Page ${pageNumber + 1} / ${tab.pageCount}`
      this.prevBtn.disabled = pageNumber <= 0
      this.nextBtn.disabled = pageNumber >= tab.pageCount - 1
    }
  }

  /** Updates the Play button's icon/title and both buttons' disabled state to match `state` — called every time a tab's transportState changes, including on tab (re)activation. */
  private renderTransportButtons(state: TransportState, hasAudio: boolean): void {
    this.playBtn.disabled = !hasAudio
    this.playBtn.innerHTML = state === 'playing' ? '&#9208;' : '&#9654;'
    this.playBtn.title = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Play'
    this.stopBtn.disabled = !hasAudio || state === 'stopped'
  }

  /** Moves the always-visible head marker to `headMs` for the active `.mscz` tab, by finding the timeline event whose window contains it (same "last event at or before this time" rule Cursor's own poll lookup uses) — also flips to that event's page if needed, since the marker only makes sense on the currently-displayed page. */
  private updateMsczHeadMarker(tab: MsczTabState): void {
    if (!tab.timeline || tab.timeline.events.length === 0) return
    let event = tab.timeline.events[0]
    for (const e of tab.timeline.events) {
      if (e.time_ms > tab.headMs) break
      event = e
    }
    if (!tab.pageView.stageFor(event.page)) void tab.pageView.showPage(event.page)
    if (this.activeHash !== tab.fileHash) return
    this.mountOverlaysOnPage(tab, event.page)
    const { width, height } = this.pageSize(tab, event.page)
    this.headMarker.setPosition((event.bbox.x / width) * 100, (event.bbox.y / height) * 100)
  }

  /** Same idea as updateMsczHeadMarker, but over calibration points — nearest point at or before `headMs`. */
  private updatePdfHeadMarker(tab: PdfTabState): void {
    const points = tab.calibrationOverlay.getPoints()
    if (points.length === 0) return
    let point = points[0]
    for (const p of points) {
      if (p.time_ms > tab.headMs) break
      point = p
    }
    if (point.page !== tab.currentPage) void this.showPdfPage(tab, point.page)
    if (this.activeHash !== tab.fileHash) return
    // point.x/y are already a 0-1 fraction of the page — no canvas-size division needed.
    this.headMarker.setPosition(point.x * 100, point.y * 100)
  }

  private updateHeadMarker(tab: TabState): void {
    if (tab.kind === 'mscz') this.updateMsczHeadMarker(tab)
    else this.updatePdfHeadMarker(tab)
  }

  /** Moves `tab`'s playback head to `targetMs` and updates the marker immediately — safe in any transport state (seeking while stopped/paused just repositions the marker; seeking while playing also repositions the live audio engine via seekMidi). Clears the active loop if `targetMs` falls outside it, per "an explicit seek always wins over a standing loop." */
  private async seekActive(tab: TabState, targetMs: number): Promise<void> {
    tab.headMs = targetMs
    const [loopStart, loopEnd] = tab.loopRegion ?? [null, null]
    if (loopStart !== null && loopEnd !== null && (targetMs < loopStart || targetMs > loopEnd)) {
      if (tab.kind === 'mscz') await this.setLoop(null)
      else await this.setPdfLoop(null)
    }
    if (this.activeHash === tab.fileHash) await seekMidi(targetMs)
    this.updateHeadMarker(tab)
  }

  private async playActive(): Promise<void> {
    const active = this.activeTab()
    if (!active || active.transportState === 'playing') return

    if (active.transportState === 'paused') {
      await resumeMidi()
      active.transportState = 'playing'
      if (active.kind === 'mscz') this.msczCursor.start()
      else this.pdfCursor.start()
      this.renderTransportButtons('playing', true)
      return
    }

    if (active.kind === 'pdf') {
      await this.loadPdfTabTempoMap(active)
      this.pdfCursor.setItems(active.calibrationOverlay.getPoints())
    }
    await playMidi(false)
    await setPlaybackSpeed(active.speed)
    await setLoopRegion(active.loopRegion)
    // play() (Rust) always resets to position 0 — follow up with a seek so
    // playback actually starts from wherever the head marker currently sits
    // (e.g. after a prior seek/selection while stopped), not always the
    // piece's absolute start.
    if (active.headMs > 0) await seekMidi(active.headMs)
    active.transportState = 'playing'
    if (active.kind === 'mscz') this.msczCursor.start()
    else this.pdfCursor.start()
    this.renderTransportButtons('playing', true)
  }

  private async pauseActive(): Promise<void> {
    const active = this.activeTab()
    if (!active || active.transportState !== 'playing') return
    await pauseMidi()
    this.msczCursor.stop()
    this.pdfCursor.stop()
    active.transportState = 'paused'
    this.renderTransportButtons('paused', true)
  }

  private async stopActive(): Promise<void> {
    const active = this.activeTab()
    if (!active || active.transportState === 'stopped') return
    await stopMidi()
    this.msczCursor.stop()
    this.pdfCursor.stop()
    if (active.kind === 'pdf') active.calibrationOverlay.setPlayingIndex(null)
    active.transportState = 'stopped'
    // Head resets to the active loop's start if one is set (loop stays
    // armed across Stop, see setLoop/setPdfLoop), else all the way to 0.
    active.headMs = active.loopRegion?.[0] ?? 0
    this.updateHeadMarker(active)
    this.renderTransportButtons('stopped', true)
  }

  private togglePlayPause(): void {
    const active = this.activeTab()
    if (!active) return
    if (active.transportState === 'playing') void this.pauseActive()
    else void this.playActive()
  }

  private toggleZenMode(): void {
    this.root.classList.toggle('zen-mode')
  }

  /**
   * Rebuilds the active `.mscz` tab's `pageView`/`selectionOverlay` in the
   * other display mode, preserving the current page and zoom. A full
   * tear-down/rebuild rather than mutating in place — `PageView` and
   * `BookPageView` each own their own DOM subtree
   * (`score-svg-layer`/measure boxes), so swapping modes cleanly means
   * destroying the old subtree and constructing the new one fresh, the same
   * way opening a brand-new tab already does.
   */
  private async toggleBookModeForActiveTab(): Promise<void> {
    const active = this.activeTab()
    if (!active || active.kind !== 'mscz') return

    const currentPage = active.pageView.page
    const currentZoom = active.pageView.getZoom()
    const pageCount = active.pageView.pages
    const nextBookMode = !active.bookMode

    active.selectionOverlay.destroy()
    active.pageContainer.innerHTML = ''
    active.pageContainer.classList.toggle('book-spread', nextBookMode)

    const { pageView, selectionOverlay } = this.createMsczPageDisplay(active.pageContainer, nextBookMode, () => active)
    active.pageView = pageView
    active.selectionOverlay = selectionOverlay
    active.bookMode = nextBookMode

    this.cursorBoxEl.style.display = 'none'

    await pageView.setScore(active.score, pageCount)
    // setScore resets to page 0 / zoom 1 internally (see PageView.setScore) —
    // restore what the user actually had showing before the mode switch.
    await pageView.showPage(currentPage)
    pageView.setZoom(currentZoom)
    this.mountOverlaysOnPage(active, pageView.page)

    this.bookModeBtn.classList.toggle('active', nextBookMode)
  }

  private goToPrevPage(): void {
    const active = this.activeTab()
    if (!active) return
    if (active.kind === 'mscz') void active.pageView.prev()
    else void this.showPdfPage(active, active.currentPage - 1)
  }

  private goToNextPage(): void {
    const active = this.activeTab()
    if (!active) return
    if (active.kind === 'mscz') void active.pageView.next()
    else void this.showPdfPage(active, active.currentPage + 1)
  }
}

function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name)
}

function isOpenableFile(name: string): boolean {
  return /\.(mscz|mscx|pdf)$/i.test(name)
}
