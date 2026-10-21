import { openScore, upgradeScore, getMeasurePositions, getMidi, type OpenScoreResult, type WebMscore, type Positions } from '../score-engine'
import { loadPdf, renderPdfPage, canvasToPngBytes, type PdfDocument } from '../pdf-engine'
import { PageView, ZOOM_STEP, MIN_ZOOM, MAX_ZOOM, PAGE_RENDERED_EVENT } from '../render/PageView'
import { SelectionOverlay, type MeasureRange } from '../render/SelectionOverlay'
import { BookPageView } from '../render/BookPageView'
import { ScrollPageView } from '../render/ScrollPageView'
import { NearViewportObserver, CurrentPageTracker, preserveScrollRatio } from '../render/scroll-utils'
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
  setMetronomeVolume,
  contentHash,
  recordRecentFile,
  hashBytes,
  listCalibrationPoints,
  saveCalibrationPoints,
  loadPdfTempoMap,
  detectBarlines,
  getKnowledgeLevel,
  setKnowledgeLevel,
  detectPieces,
  getPlaybackPosition,
  adaptScoreForEngine,
} from '../api-client'
import { MarkerOverlay, type MarkerHost, type MarkerTool } from './MarkerOverlay'
import { PiecesIndex } from './PiecesIndex'
import { RatingStars } from './RatingStars'
import { TabBar, type TabInfo } from './TabBar'
import type { CalibrationPoint, KnowledgeLevel, Piece, StaffSystem, Timeline, TimelineEvent } from '../types'
import { initTheme, applyTheme, THEME_LABELS, THEME_ICONS, type Theme } from '../theme'

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
 * Two kinds: `.mscz` tabs (real note data, full timeline/pieces) and
 * PDF tabs (no note data, just rendered pages + user-calibrated
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
  /** Highlights `range` without firing `onSelect` — `null` clears the highlight. */
  setSelection(range: MeasureRange | null): void
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
  /** Cached `saveMidi()` output — re-exporting it on every tab activation costs seconds on a long multi-piece score. */
  midiBytes: Uint8Array | null
  /** Piece boundaries for a multi-piece file (see `PiecesIndex`), detected once at open. Empty/single-entry for an ordinary single-piece file. */
  pieces: Piece[]
  selection: MeasureRange | null
  speed: number
  loopRegion: [number, number] | null
  originalBytes: Uint8Array
  transportState: TransportState
  /** Where the playback-head marker currently sits, in the timeline's 1.0x-speed milliseconds — independent of whether audio is actually running. */
  headMs: number
  /** Whether this tab is currently showing a single page or a two-page "book" spread — toggled by the book-mode button, persisted per tab (not globally) since different open scores may suit different modes. */
  bookMode: boolean
  /** Scroll mode (all pages in one continuous strip) — vertical, or horizontal when `bookMode` is also on. */
  scrollMode: boolean
}

/** One rendered PDF page's own container + measure overlay — `PdfTabState`'s `canvasContainer`/`calibrationOverlay`/`currentPage` fields are exactly this shape; book mode adds a second one (`rightPane`) rather than duplicating these three fields inline. */
interface PdfPane {
  canvasContainer: HTMLDivElement
  calibrationOverlay: CalibrationOverlay
  currentPage: number
}

interface PdfTabState {
  kind: 'pdf'
  fileHash: string
  title: string
  doc: PdfDocument
  pageCount: number
  currentPage: number
  zoom: number
  pageContainer: HTMLDivElement
  canvasContainer: HTMLDivElement
  calibrationOverlay: CalibrationOverlay
  /** Book mode's second page-stage, alongside this tab's own primary `canvasContainer`/`calibrationOverlay`/`currentPage` (which always plays the "left" role) — `null` outside book mode. Both panes' `CalibrationOverlay`s are independently interactive (drag-select, double-click-seek) and are kept showing the same underlying `points` array; only the primary one owns persistence (`onChange` -> `saveCalibrationPoints`), since both views are always in sync on the same data, not independent copies. */
  extraPanes: PdfPane[]
  /** The page the primary pane shows — equals `currentPage` except in scroll mode, where `currentPage` is whichever page is most in view while the primary pane stays on page 0. */
  primaryPage: number
  /** Whether this tab is currently showing a single page or a two-page "book" spread — mirrors `MsczTabState.bookMode`. */
  bookMode: boolean
  /** Scroll mode: `extraPanes` holds every page after the first, rendered lazily as they near the viewport. */
  scrollMode: boolean
  /** width/height of each page, filled in when scroll mode is first entered (placeholders need it before a page renders). */
  aspects: number[] | null
  /** Scroll mode's zoom each page was last rendered at — a page is re-rendered when this differs from the current zoom. */
  scrollRendered: Map<number, number>
  scrollNear: NearViewportObserver | null
  scrollTracker: CurrentPageTracker | null
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
  private readonly gotoMeasureInput: HTMLInputElement
  private readonly gotoMeasureBtn: HTMLButtonElement
  private readonly playBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly speedButtons: Record<number, HTMLButtonElement>
  private readonly metronomeBtn: HTMLButtonElement
  private readonly metronomeVolumeInput: HTMLInputElement
  /** Whether the click track is on — a global setting (the audio engine has one player), kept across tab switches. */
  private metronomeOn = false
  private readonly pageContainerEl: HTMLDivElement
  private readonly emptyStateEl: HTMLDivElement
  private readonly selectionStatusEl: HTMLSpanElement
  private readonly loopStatusEl: HTMLSpanElement
  private readonly calibrationStatusEl: HTMLSpanElement
  private readonly ratingMountEl: HTMLSpanElement
  private readonly ratingStars: RatingStars
  private readonly pdfControlsEl: HTMLDivElement
  private readonly rescanMeasuresBtn: HTMLButtonElement
  private readonly zoomOutBtn: HTMLButtonElement
  private readonly zoomInBtn: HTMLButtonElement
  private readonly zoomIndicatorEl: HTMLInputElement
  private readonly fitWidthBtn: HTMLButtonElement
  private readonly fitHeightBtn: HTMLButtonElement
  private readonly zoomResetBtn: HTMLButtonElement
  private readonly bookModeBtn: HTMLButtonElement
  private readonly scrollModeBtn: HTMLButtonElement
  private readonly markerToolsEl: HTMLDivElement
  private readonly textToolBtn: HTMLButtonElement
  private readonly fingeringToolBtn: HTMLButtonElement
  private readonly themeSwitchEl: HTMLDivElement
  private readonly dropOverlay: HTMLDivElement
  private readonly libraryBtn: HTMLButtonElement
  private readonly loadingOverlayEl: HTMLDivElement
  private readonly loadingTitleEl: HTMLDivElement
  private readonly loadingStepEl: HTMLDivElement
  /** How many opens are in flight — the loading overlay stays up until the last one finishes. */
  private loadingCount = 0

  private readonly tabs = new Map<string, TabState>()
  private activeHash: string | null = null

  private readonly tabBar: TabBar
  private readonly msczCursor: Cursor<TimelineEvent>
  private readonly pdfCursor: Cursor<CalibrationPoint>
  private readonly markerOverlay: MarkerOverlay
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
        <span class="app-title">Lyrica</span>
        <div class="toolbar-group">
          <input id="file-input" type="file" accept=".mscz,.mscx,.pdf" />
          <button id="back-to-library-btn" class="primary" style="display:none;" title="Back to library">&#128193; Library</button>
        </div>
        <div id="nav" class="toolbar-group" style="display:none;">
          <button id="prev-page" class="icon-btn" title="Previous page">&larr;</button>
          <span id="page-indicator"></span>
          <button id="next-page" class="icon-btn" title="Next page">&rarr;</button>
          <input id="goto-measure-input" type="number" min="1" placeholder="Measure" class="goto-measure-input" />
          <button id="goto-measure-btn" title="Go to measure">Go</button>
        </div>
        <div id="transport" class="toolbar-group" style="display:none;">
          <button id="play-btn" class="icon-btn primary" disabled title="Play">&#9654;</button>
          <button id="stop-btn" class="icon-btn" disabled title="Stop">&#9632;</button>
          <button id="speed-05" class="speed-btn" disabled>0.5x</button>
          <button id="speed-075" class="speed-btn" disabled>0.75x</button>
          <button id="speed-10" class="speed-btn" disabled>1.0x</button>
          <div class="metronome-control">
            <button id="metronome-btn" class="icon-btn metronome-btn" disabled aria-pressed="false" title="Metronome (M)">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 3h6l4 18H5L9 3z" />
                <path d="M5.9 17h12.2" />
                <path d="M12 17l5-11" />
                <circle cx="15.6" cy="9.1" r="1.3" fill="currentColor" />
              </svg>
            </button>
            <input id="metronome-volume" type="range" min="0" max="100" step="1" class="metronome-volume" title="Metronome volume" aria-label="Metronome volume" />
          </div>
        </div>
        <div id="zoom-group" class="toolbar-group zoom-control" style="display:none;">
          <button id="zoom-out" class="icon-btn" title="Zoom out">&minus;</button>
          <input id="zoom-indicator" class="zoom-indicator" type="text" inputmode="numeric" value="100%" title="Zoom level — click and type a percentage, then press Enter" aria-label="Zoom percentage" />
          <button id="zoom-in" class="icon-btn" title="Zoom in">+</button>
          <button id="fit-width-btn" title="Fit to width">Fit width</button>
          <button id="fit-height-btn" title="Fit to height">Fit height</button>
          <button id="zoom-reset-btn" title="Reset zoom to 100%">100%</button>
          <button id="book-mode-btn" class="book-mode-btn" title="Book mode: show two pages side by side">&#128214; Book mode</button>
          <button id="scroll-mode-btn" class="book-mode-btn" title="Scroll mode: all pages in one continuous strip (with Book mode: scrolls sideways)">&#8597; Scroll mode</button>
        </div>
        <div id="marker-tools" class="toolbar-group marker-tools" style="display:none;">
          <button id="marker-tools-toggle" class="marker-tools-header" aria-expanded="true" title="Collapse/expand the markers panel"><span class="collapsible-disclosure">&#9660;</span> Markers</button>
          <div id="marker-tools-body" class="marker-tools-body">
            <button id="text-tool-btn" class="marker-tool-btn" title="Text marker (T): click a measure to write a note above it">&#9998; Text</button>
            <button id="fingering-tool-btn" class="marker-tool-btn" title="Fingering (G): click where the numbers go, type digits 1-5">Fingering</button>
          </div>
        </div>
        <div class="toolbar-spacer"></div>
        <div class="toolbar-group">
          <div id="theme-switch" class="theme-switch" role="radiogroup" aria-label="Theme"></div>
        </div>
      </div>

      <div class="sidebar">
        <div id="pieces-index" class="sidebar-section"></div>
      </div>

      <div class="main-area">
        <div class="status-bar">
          <span id="status"></span>
          <span id="selection-status"></span>
          <span id="loop-status" class="loop-status"></span>
          <span id="calibration-status" class="calibration-status"></span>
          <span id="rating-mount" class="rating-mount" style="display:none;"></span>
        </div>
        <div class="page-area-wrap">
          <div id="pdf-controls" class="pdf-overlay-controls" style="display:none;">
            <button id="toggle-measure-markers-btn" class="icon-btn" aria-pressed="true" title="Show/hide measure markers"></button>
            <button id="rescan-measures-btn" class="icon-btn" title="Rescan measures (clears and re-detects all measure markers)">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>
            </button>
          </div>
          <div id="page" class="page-area">
            <div class="empty-state" id="empty-state">
              <div>No file open</div>
              <div class="hint">Open a .mscz or .pdf file, or drag one onto this window</div>
            </div>
          </div>
          <div id="loading-overlay" class="loading-overlay" style="display:none;" role="status" aria-live="polite">
            <div class="loading-card">
              <div class="spinner"></div>
              <div class="loading-title"></div>
              <div class="loading-step"></div>
            </div>
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
    this.gotoMeasureInput = this.root.querySelector('#goto-measure-input')!
    this.gotoMeasureBtn = this.root.querySelector('#goto-measure-btn')!
    this.playBtn = this.root.querySelector('#play-btn')!
    this.stopBtn = this.root.querySelector('#stop-btn')!
    this.speedButtons = {
      0.5: this.root.querySelector('#speed-05')!,
      0.75: this.root.querySelector('#speed-075')!,
      1.0: this.root.querySelector('#speed-10')!,
    }
    this.metronomeBtn = this.root.querySelector('#metronome-btn')!
    this.metronomeVolumeInput = this.root.querySelector('#metronome-volume')!
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
    this.rescanMeasuresBtn = this.root.querySelector('#rescan-measures-btn')!
    this.zoomOutBtn = this.root.querySelector('#zoom-out')!
    this.zoomInBtn = this.root.querySelector('#zoom-in')!
    this.zoomIndicatorEl = this.root.querySelector('#zoom-indicator')!
    this.fitWidthBtn = this.root.querySelector('#fit-width-btn')!
    this.fitHeightBtn = this.root.querySelector('#fit-height-btn')!
    this.zoomResetBtn = this.root.querySelector('#zoom-reset-btn')!
    this.bookModeBtn = this.root.querySelector('#book-mode-btn')!
    this.scrollModeBtn = this.root.querySelector('#scroll-mode-btn')!
    this.markerToolsEl = this.root.querySelector('#marker-tools')!
    this.textToolBtn = this.root.querySelector('#text-tool-btn')!
    this.fingeringToolBtn = this.root.querySelector('#fingering-tool-btn')!
    this.themeSwitchEl = this.root.querySelector('#theme-switch')!
    this.dropOverlay = this.root.querySelector('#drop-overlay')!
    this.libraryBtn = this.root.querySelector('#back-to-library-btn')!
    this.loadingOverlayEl = this.root.querySelector('#loading-overlay')!
    this.loadingTitleEl = this.root.querySelector('.loading-title')!
    this.loadingStepEl = this.root.querySelector('.loading-step')!

    // Three icon buttons, exactly one pressed (radio semantics).
    const themeButtons = new Map<Theme, HTMLButtonElement>()
    const syncThemeButtons = (): void => {
      const current = document.documentElement.getAttribute('data-theme') ?? 'light'
      for (const [theme, btn] of themeButtons) {
        btn.classList.toggle('active', theme === current)
        btn.setAttribute('aria-checked', String(theme === current))
      }
    }
    for (const theme of Object.keys(THEME_LABELS) as Theme[]) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'icon-btn theme-btn'
      btn.setAttribute('role', 'radio')
      btn.title = `${THEME_LABELS[theme]} theme`
      btn.innerHTML = THEME_ICONS[theme]
      btn.addEventListener('click', () => {
        applyTheme(theme)
        syncThemeButtons()
      })
      themeButtons.set(theme, btn)
      this.themeSwitchEl.appendChild(btn)
    }
    syncThemeButtons()

    this.libraryBtn.addEventListener('click', () => {
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
      this.revealIfOffscreen(active, this.cursorBoxEl)
      active.headMs = event.time_ms
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
      if (!this.pdfPaneFor(active, target.page)) {
        void this.showPdfPage(active, target.page)
      }
      this.setPdfPlayingIndex(active, target.page, itemIndex)
      const pane = this.pdfPaneFor(active, target.page)
      if (pane) pane.canvasContainer.appendChild(this.headMarker.el)
      // target.x/y are already a 0-1 fraction of the page (see
      // CalibrationOverlay's module docs) — no canvas-size division needed.
      this.headMarker.setPosition(target.x * 100, target.y * 100)
      this.revealIfOffscreen(active, this.headMarker.el)
      active.headMs = target.time_ms
    })

    this.markerOverlay = new MarkerOverlay()
    this.markerOverlay.onToolChange((tool) => this.renderMarkerToolButtons(tool))
    this.markerOverlay.onError((message) => {
      this.statusEl.textContent = message
    })
    this.textToolBtn.addEventListener('click', () => this.toggleMarkerTool('text'))
    this.fingeringToolBtn.addEventListener('click', () => this.toggleMarkerTool('fingering'))
    // Any stage of the active tab switching page (navigation, book-mode
    // spread, zoom re-render of a PDF) needs that page's markers drawn.
    this.pageContainerEl.addEventListener(PAGE_RENDERED_EVENT, () => this.markerOverlay.refresh())

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

    this.metronomeBtn.addEventListener('click', () => this.setMetronomeOn(!this.metronomeOn))
    this.metronomeVolumeInput.value = String(Math.round(loadMetronomeVolume() * 100))
    this.metronomeVolumeInput.addEventListener('input', () => {
      const volume = Number(this.metronomeVolumeInput.value) / 100
      saveMetronomeVolume(volume)
      void setMetronomeVolume(volume)
    })
    if (isTauri()) void setMetronomeVolume(loadMetronomeVolume())

    const MARKERS_KEY = 'lyrica-measure-markers-visible'
    const markersToggle = this.root.querySelector<HTMLButtonElement>('#toggle-measure-markers-btn')!
    const EYE_OPEN = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>'
    const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.8 10.8 0 0 1 12 19C5.5 19 1.5 12 1.5 12a19 19 0 0 1 4.6-5.4M9.9 5.2A10 10 0 0 1 12 5c6.5 0 10.5 7 10.5 7a19 19 0 0 1-2.2 3.2M14.1 14.1A3 3 0 0 1 9.9 9.9M2 2l20 20"/></svg>'
    const setMarkersVisible = (visible: boolean): void => {
      this.pageContainerEl.classList.toggle('hide-measure-markers', !visible)
      markersToggle.innerHTML = visible ? EYE_OPEN : EYE_OFF
      markersToggle.setAttribute('aria-pressed', String(visible))
      markersToggle.classList.toggle('active', visible)
    }
    let markersVisible = true
    try {
      markersVisible = localStorage.getItem(MARKERS_KEY) !== '0'
    } catch {
      // localStorage unavailable — default stands.
    }
    setMarkersVisible(markersVisible)
    markersToggle.addEventListener('click', () => {
      markersVisible = !markersVisible
      setMarkersVisible(markersVisible)
      try {
        localStorage.setItem(MARKERS_KEY, markersVisible ? '1' : '0')
      } catch {
        // Best-effort persistence only.
      }
    })

    const markerToolsToggle = this.root.querySelector<HTMLButtonElement>('#marker-tools-toggle')!
    const markerToolsBody = this.root.querySelector<HTMLDivElement>('#marker-tools-body')!
    markerToolsToggle.addEventListener('click', () => {
      const collapsed = markerToolsBody.style.display !== 'none'
      markerToolsBody.style.display = collapsed ? 'none' : ''
      markerToolsToggle.setAttribute('aria-expanded', String(!collapsed))
      markerToolsToggle.querySelector('.collapsible-disclosure')!.innerHTML = collapsed ? '&#9654;' : '&#9660;'
    })

    this.rescanMeasuresBtn.addEventListener('click', async () => {
      const active = this.activeTab()
      if (!active || active.kind !== 'pdf') return
      const count = active.calibrationOverlay.getPoints().length
      if (count > 0 && !window.confirm(`Clear and rescan all ${count} marked measure(s) for this file? This can't be undone.`)) return
      active.calibrationOverlay.clearAllPoints()
      this.syncRightPanePoints(active)
      this.rescanMeasuresBtn.disabled = true
      try {
        await this.autoScanBarlines(active)
      } finally {
        this.rescanMeasuresBtn.disabled = false
      }
    })

    const commitTypedZoom = (): void => {
      const percent = parseFloat(this.zoomIndicatorEl.value.replace('%', '').trim())
      const active = this.activeTab()
      if (Number.isFinite(percent) && percent > 0) this.setActiveTabZoom(percent / 100)
      else if (active) this.setZoomIndicator(active.kind === 'mscz' ? active.pageView.getZoom() : active.zoom)
    }
    this.zoomIndicatorEl.addEventListener('focus', () => this.zoomIndicatorEl.select())
    this.zoomIndicatorEl.addEventListener('keydown', (e) => {
      e.stopPropagation() // typing digits/arrows here must not trigger page-nav or other window-level shortcuts
      if (e.key === 'Enter') {
        commitTypedZoom()
        this.zoomIndicatorEl.blur()
      } else if (e.key === 'Escape') {
        const active = this.activeTab()
        if (active) this.setZoomIndicator(active.kind === 'mscz' ? active.pageView.getZoom() : active.zoom)
        this.zoomIndicatorEl.blur()
      }
    })
    this.zoomIndicatorEl.addEventListener('blur', commitTypedZoom)

    this.zoomOutBtn.addEventListener('click', () => this.zoomActiveTab(-ZOOM_STEP))
    this.zoomInBtn.addEventListener('click', () => this.zoomActiveTab(ZOOM_STEP))
    this.fitWidthBtn.addEventListener('click', () => this.fitActiveTabToWidth())
    this.fitHeightBtn.addEventListener('click', () => this.fitActiveTabToHeight())
    this.zoomResetBtn.addEventListener('click', () => this.resetActiveTabZoom())
    this.bookModeBtn.addEventListener('click', () => void this.setDisplayModeForActiveTab({ book: !this.activeTab()?.bookMode }))
    this.scrollModeBtn.addEventListener('click', () => void this.setDisplayModeForActiveTab({ scroll: !this.activeTab()?.scrollMode }))

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

    /**
     * A click on the empty area around the page (outside every page-stage)
     * clears the selection/loop — clicks *on* a page are handled by its own
     * SelectionOverlay/CalibrationOverlay (click = seek, drag = select).
     * `.book-spread` is excluded because the spread wrapper itself carries
     * `.page-stage` for `.mscz` tabs, though the gap between its two pages
     * is still "outside the page".
     */
    this.pageContainerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      const target = e.target as Element | null
      if (target?.closest('.page-stage:not(.book-spread)')) return
      const active = this.activeTab()
      if (active) void this.clearSelection(active)
    })

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

    /** Escape puts down the active marker tool if there is one, else stops playback outright, like the Stop button — a distinct action from Space's play/pause toggle. */
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (!this.isVisible()) return
      if (this.markerOverlay.activeTool) {
        this.markerOverlay.setTool(null)
        return
      }
      void this.stopActive()
    })

    /** T / G pick up the text / fingering marker tool (pressing it again puts it down). G rather than F, which is already zen mode. */
    window.addEventListener('keydown', (e) => {
      const tool: MarkerTool | null = e.key === 't' || e.key === 'T' ? 'text' : e.key === 'g' || e.key === 'G' ? 'fingering' : null
      if (!tool || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (!this.isVisible() || !this.markerOverlay.available) return
      e.preventDefault()
      this.toggleMarkerTool(tool)
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

    /** M toggles the metronome — same checkbox the Metronome label already drives, just reachable without clicking it. */
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'm' && e.key !== 'M') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (!this.isVisible()) return
      if (this.metronomeBtn.disabled) return
      e.preventDefault()
      this.setMetronomeOn(!this.metronomeOn)
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
      this.libraryBtn.style.display = 'inline-block'
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

    this.gotoMeasureBtn.addEventListener('click', () => this.goToMeasureFromInput())
    this.gotoMeasureInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.goToMeasureFromInput()
    })

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
    ;(window as unknown as { __lyricaOpenBytes: (bytes: Uint8Array, filename: string) => Promise<void> }).__lyricaOpenBytes = (
      bytes: Uint8Array,
      filename: string,
    ) => this.openBytes(bytes, filename, null)
    ;(window as unknown as { __lyricaPageView: () => PageDisplay | null }).__lyricaPageView = () => {
      const active = this.activeTab()
      return active?.kind === 'mscz' ? active.pageView : null
    }
    ;(window as unknown as { __lyricaGetTimeline: () => Timeline | null }).__lyricaGetTimeline = () => {
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

  /** Every pane currently mounted for `tab`: the primary one, then `extraPanes` (book mode's right page, or scroll mode's remaining pages). */
  private pdfPanes(tab: PdfTabState): PdfPane[] {
    return [{ canvasContainer: tab.canvasContainer, calibrationOverlay: tab.calibrationOverlay, currentPage: tab.primaryPage }, ...tab.extraPanes]
  }

  /** The pane showing `page`, if any — mirrors `.mscz`'s `PageDisplay.stageFor`; panes are never on the same page as each other. */
  private pdfPaneFor(tab: PdfTabState, page: number): PdfPane | null {
    return this.pdfPanes(tab).find((p) => p.currentPage === page) ?? null
  }

  /** Sets the "currently playing" highlight on whichever pane holds `page`, clearing it on every other pane — a point only ever plays on one page at a time. */
  private setPdfPlayingIndex(tab: PdfTabState, page: number, itemIndex: number | null): void {
    for (const pane of this.pdfPanes(tab)) pane.calibrationOverlay.setPlayingIndex(pane.currentPage === page ? itemIndex : null)
  }

  /** Scroll mode only: brings `el` (the playback cursor/head marker) into view if it has drifted out of the visible part of the page area. */
  private revealIfOffscreen(tab: TabState, el: HTMLElement): void {
    if (!tab.scrollMode) return
    const area = this.pageContainerEl.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const m = 60
    if (r.top >= area.top + m && r.bottom <= area.bottom - m && r.left >= area.left + m && r.right <= area.right - m) return
    el.scrollIntoView({ block: 'center', inline: 'center' })
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
      ? `Looping measures ${range!.startIndex}-${range!.endIndex}`
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
    if (!active) return
    if (active.kind === 'mscz') {
      if (!active.timeline) return
      const event = active.timeline.events.find((e) => e.measure_index === measureIndex)
      if (!event) return
      if (!active.pageView.stageFor(event.page)) {
        void active.pageView.showPage(event.page)
      }
      return
    }
    const point = active.calibrationOverlay.getPoints().find((p) => p.measure === measureIndex)
    if (!point) return
    if (!this.pdfPaneFor(active, point.page)) void this.showPdfPage(active, point.page)
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
    // A remounted scroll-mode strip starts at scrollTop 0 — return to the page the user was on.
    if (tab.scrollMode) {
      if (tab.kind === 'pdf') void this.showPdfScrollPage(tab, tab.currentPage)
      else void tab.pageView.showPage(tab.pageView.page)
    }

    this.statusEl.textContent = tab.title
    this.calibrationStatusEl.textContent = ''
    this.pdfControlsEl.style.display = tab.kind === 'pdf' ? 'flex' : 'none'
    this.transportEl.style.display = 'flex'
    this.zoomGroupEl.style.display = 'flex'
    this.bookModeBtn.style.display = 'inline-block'
    this.bookModeBtn.classList.toggle('active', tab.bookMode)
    this.scrollModeBtn.style.display = 'inline-block'
    this.scrollModeBtn.classList.toggle('active', tab.scrollMode)
    void this.loadRatingForTab(tab)
    // "untracked-" tabs have no stable file_hash (desktop hashing failed, or
    // running outside Tauri), so there's nothing to persist markers under.
    const markerHash = tab.fileHash.startsWith('untracked-') ? null : tab.fileHash
    this.markerToolsEl.style.display = markerHash ? 'flex' : 'none'
    void this.markerOverlay.setTab(tab.pageContainer, markerHash, this.markerHostFor(tab))

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
      this.setZoomIndicator(tab.pageView.getZoom())
      this.zoomOutBtn.disabled = tab.pageView.getZoom() <= MIN_ZOOM
      this.zoomInBtn.disabled = tab.pageView.getZoom() >= MAX_ZOOM

      this.msczCursor.setItems(tab.timeline?.events ?? null)
      this.pdfCursor.setItems(null)
      this.piecesIndex.setPieces(tab.pieces)

      const hasAudio = tab.timeline !== null
      this.renderTransportButtons(tab.transportState, hasAudio)
      for (const btn of Object.values(this.speedButtons)) btn.disabled = !hasAudio
      this.metronomeBtn.disabled = !hasAudio

      if (hasAudio) {
        this.setSpeed(tab.speed)
        tab.midiBytes ??= await getMidi(tab.score)
        await loadMidi(tab.midiBytes)
        await setLoopRegion(tab.loopRegion)
        await setMetronomeEnabled(this.metronomeOn)
        this.updateMsczHeadMarker(tab)
      }
    } else {
      tab.canvasContainer.appendChild(this.headMarker.el)
      tab.transportState = 'stopped'
      this.selectionStatusEl.textContent = tab.selectedRange
        ? `Selected measures ${tab.selectedRange.startIndex}-${tab.selectedRange.endIndex}`
        : ''
      this.loopStatusEl.textContent = tab.loopRegion ? 'Looping measures' : ''
      this.calibrationStatusEl.textContent = this.measureStatusText(tab)
      this.setZoomIndicator(tab.zoom)
      this.zoomOutBtn.disabled = tab.zoom <= PDF_MIN_ZOOM
      this.zoomInBtn.disabled = tab.zoom >= PDF_MAX_ZOOM

      this.msczCursor.setItems(null)
      this.pdfCursor.setItems(tab.calibrationOverlay.getPoints())
      this.piecesIndex.setPieces(null) // pieces index is .mscz-only — no raw XML to detect boundaries from in a PDF

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
      this.metronomeBtn.disabled = !hasAudio

      if (hasAudio) {
        this.setSpeed(tab.speed)
        await this.loadPdfTabTempoMap(tab)
        await setLoopRegion(tab.loopRegion)
        await setMetronomeEnabled(this.metronomeOn)
      }
    }

    this.renderTabBar()
  }

  /** Derives and loads the tempo map for a PDF tab's current calibration points, for metronome-only playback. */
  private async loadPdfTabTempoMap(tab: PdfTabState): Promise<void> {
    const durationMs = Math.max(...tab.points.map((p) => p.time_ms)) + 4000
    await loadPdfTempoMap(tab.points, tab.numerator, durationMs)
  }

  /** Measures are placed entirely by the CV auto-detector now (see `CalibrationOverlay`'s module docs) — this just reports the count, not an editable-mode status. */
  private measureStatusText(tab: PdfTabState): string {
    return `${tab.points.length} measure(s) detected.`
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

  /** Shows `zoom` (a 1.0 = 100% fraction) in the editable zoom field. */
  private setZoomIndicator(zoom: number): void {
    this.zoomIndicatorEl.value = `${Math.round(zoom * 100)}%`
  }

  /** Applies a typed zoom (1.0 = 100%) to the active tab, clamped to that kind's range; the field is re-synced to whatever was actually applied. */
  private setActiveTabZoom(zoom: number): void {
    const active = this.activeTab()
    if (!active) return
    if (active.kind === 'mscz') {
      active.pageView.setZoom(zoom)
    } else {
      this.setPdfZoom(active, zoom)
    }
  }

  private setPdfZoom(tab: PdfTabState, zoom: number): void {
    tab.zoom = Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom))
    this.setZoomIndicator(tab.zoom)
    this.zoomOutBtn.disabled = tab.zoom <= PDF_MIN_ZOOM
    this.zoomInBtn.disabled = tab.zoom >= PDF_MAX_ZOOM
    if (tab.scrollMode) this.relayoutPdfScroll(tab)
    else void this.showPdfPage(tab, tab.currentPage)
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
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return tab.aspects?.[0] ?? null
    return canvas.width / canvas.height
  }

  private fitActiveTabToWidth(): void {
    const active = this.activeTab()
    if (!active) return
    const { width } = this.pageAreaAvailableSize()
    if (active.kind === 'mscz') {
      active.pageView.setZoomToWidth(width)
    } else {
      // Book mode shows two pages side by side, so each gets half the
      // available width — same halving BookPageView.setZoomToWidth does
      // for .mscz's own book mode.
      const availableWidth = active.bookMode ? width / 2 : width // scroll+book (horizontal strip) also shows ~two pages across
      this.setPdfZoom(active, availableWidth / PDF_BASE_WIDTH)
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
      this.teardownPdfExtras(tab)
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
        void this.markerOverlay.setTab(null, null, null)
        this.markerToolsEl.style.display = 'none'
        this.piecesIndex.setPieces(null)
        this.playBtn.disabled = true
        this.stopBtn.disabled = true
        for (const btn of Object.values(this.speedButtons)) btn.disabled = true
        this.metronomeBtn.disabled = true
      }
    }
    this.renderTabBar()
  }

  async openBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
    this.beginLoading(filename)
    try {
      if (isPdfFile(filename)) {
        await this.openPdfBytes(bytes, filename, path)
      } else {
        await this.openMsczBytes(bytes, filename, path)
      }
    } catch (e) {
      console.error(`Failed to open ${filename}:`, e)
      this.statusEl.textContent = `Failed to open ${filename}: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      this.endLoading()
    }
  }

  /**
   * Opens a file by path (desktop only), showing the loading overlay from
   * the very start — reading a large file off disk is itself part of the
   * wait. Used by the library view, which switches to this view first so the
   * user watches progress here instead of a library that seems to ignore
   * their click.
   */
  async openPath(path: string): Promise<void> {
    const filename = path.split(/[/\\]/).pop() ?? path
    this.beginLoading(filename)
    try {
      this.setLoadingStep('Reading file…')
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(path)
      await this.openBytes(bytes, filename, path)
    } catch (e) {
      console.error(`Failed to read ${path}:`, e)
      this.statusEl.textContent = `Failed to open ${filename}: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      this.endLoading()
    }
  }

  /** Shows the loading overlay (spinner + `filename` + current step) over the page area. Nestable: stays up until every `beginLoading` has its `endLoading`. */
  private beginLoading(filename: string): void {
    this.loadingCount++
    this.loadingTitleEl.textContent = `Opening ${filename}`
    this.loadingStepEl.textContent = ''
    this.loadingOverlayEl.style.display = 'flex'
  }

  private setLoadingStep(step: string): void {
    this.loadingStepEl.textContent = step
  }

  private endLoading(): void {
    this.loadingCount = Math.max(0, this.loadingCount - 1)
    if (this.loadingCount === 0) this.loadingOverlayEl.style.display = 'none'
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
    scrollMode: boolean,
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
      this.setZoomIndicator(zoom)
      this.zoomOutBtn.disabled = zoom <= MIN_ZOOM
      this.zoomInBtn.disabled = zoom >= MAX_ZOOM
    }

    let pageView: PageDisplay
    let selectionOverlay: SelectionSource
    if (scrollMode) {
      const scroll = new ScrollPageView(pageContainer, bookMode, this.pageContainerEl, onPageChange, onZoomChange)
      pageView = scroll
      selectionOverlay = scroll
    } else if (bookMode) {
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
      const event = tabState.timeline && this.eventForElidNearHead(tabState.timeline, elid, tabState.headMs)
      if (event) void this.seekActive(tabState, event.time_ms)
    })

    return { pageView, selectionOverlay }
  }

  private async openMsczBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
    this.setLoadingStep('Loading score…')

    // webmscore's worker-based load() transfers `data.buffer` into the worker
    // (an explicit `Transferable`, see node_modules/webmscore/src/worker-helper.js),
    // which detaches the original ArrayBuffer as a side effect — `bytes` itself
    // becomes unusable (reads throw "detached ArrayBuffer") immediately after
    // `openScore` returns. Keep a copy for anything needed later (e.g. hashing
    // the original file for markers).
    const originalBytes = bytes.slice()

    // Score files from newer MuseScore versions get rewritten into a form the
    // engine understands first (it would otherwise silently drop e.g. every
    // key signature). In-memory only; hashing/pieces still use originalBytes.
    let engineBytes: Uint8Array = originalBytes
    try {
      engineBytes = await adaptScoreForEngine(originalBytes)
    } catch (e) {
      console.error('Failed to adapt score for the engine, loading it as-is:', e)
    }
    // openScore detaches the buffer it's given; the timeline needs a copy of
    // what was loaded.
    let loadedBytes: Uint8Array = engineBytes === originalBytes ? originalBytes : engineBytes.slice()

    let result: OpenScoreResult
    try {
      result = await openScore(engineBytes === originalBytes ? bytes : engineBytes)
    } catch (e) {
      this.statusEl.textContent = `Failed to open ${filename}: ${e instanceof Error ? e.message : String(e)}`
      return
    }

    let { score } = result
    const { needsUpgrade, metadata } = result
    // `loadedBytes` must stay exactly what webmscore ends up holding (the
    // upgraded re-save, if any) — the timeline reads its measure layout from
    // it, so it has to describe the score the positions/MIDI came from.

    // Upgrading is purely an in-memory re-save inside webmscore's own engine
    // (to the format version it natively works with) — it never touches the
    // user's original file on disk (upgradeScore's return value is only ever
    // persisted into this app's own cache, keyed by the *original* file's
    // hash — see the comment on hashing below). Nothing for the user to
    // decide here, so no confirmation prompt.
    if (needsUpgrade) {
      this.setLoadingStep('Converting from an older MuseScore format…')
      const upgradedBytes = await upgradeScore(score)
      score.destroy()
      loadedBytes = upgradedBytes.slice() // openScore detaches the buffer it's given
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
        this.setLoadingStep('Checking file…')
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

    const { pageView, selectionOverlay } = this.createMsczPageDisplay(pageContainer, false, false, () => tabState)

    const tabState: MsczTabState = {
      kind: 'mscz',
      fileHash: fileHash ?? `untracked-${Date.now()}`,
      title,
      score,
      pageView,
      selectionOverlay,
      pageContainer,
      timeline: null,
      midiBytes: null,
      pieces: [],
      selection: null,
      speed: 1.0,
      loopRegion: null,
      originalBytes,
      transportState: 'stopped',
      headMs: 0,
      bookMode: false,
      scrollMode: false,
    }

    this.setLoadingStep('Laying out pages…')
    await pageView.setScore(score, metadata.pages)
    this.setLoadingStep('Rendering first page…')
    await pageView.showPage(0)

    if (isTauri() && fileHash) {
      this.setLoadingStep('Preparing playback…')
      const positions = pageView.getPositions() ?? (await getMeasurePositions(score))
      tabState.midiBytes = await getMidi(score)
      this.setLoadingStep('Building playback timeline…')
      const { timeline } = await importTimeline(positions, tabState.midiBytes, loadedBytes)
      tabState.timeline = timeline
      this.setLoadingStep('Finding pieces…')
      try {
        tabState.pieces = await detectPieces(originalBytes)
      } catch (e) {
        console.error('Failed to detect pieces:', e)
      }

      if (path) {
        await this.recordAndNotifyRecentFile(path, fileHash, title)
      }
    }

    this.setLoadingStep('Loading audio…')
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

  /** Builds one PDF page-stage div (shrink-wraps to the canvas it'll later contain, plus the theme raster-overlay) — shared by the primary pane and, in book mode, the second `rightPane`. The caller still constructs the `CalibrationOverlay` itself, since that needs to happen after this container is placed in its final spot in the DOM. */
  private createPdfCanvasContainer(): HTMLDivElement {
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
    // Theme tint/texture for the PDF canvas (see theme.css's .raster-overlay
    // comment) — a real element kept immediately after the <canvas> so it
    // paints above the page but below CalibrationOverlay's dots/drag-rect/form
    // layers, appended next.
    const rasterOverlay = document.createElement('div')
    rasterOverlay.className = 'raster-overlay'
    canvasContainer.appendChild(rasterOverlay)
    return canvasContainer
  }

  private async openPdfBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
    this.setLoadingStep('Loading PDF…')

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
    const canvasContainer = this.createPdfCanvasContainer()
    pageContainer.appendChild(canvasContainer)
    const calibrationOverlay = new CalibrationOverlay(canvasContainer)

    const tabState: PdfTabState = {
      kind: 'pdf',
      fileHash: fileHash ?? `untracked-${Date.now()}`,
      title,
      doc,
      pageCount: doc.numPages,
      currentPage: 0,
      zoom: 1,
      pageContainer,
      canvasContainer,
      calibrationOverlay,
      extraPanes: [],
      primaryPage: 0,
      bookMode: false,
      scrollMode: false,
      aspects: null,
      scrollRendered: new Map(),
      scrollNear: null,
      scrollTracker: null,
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
      for (const pane of tabState.extraPanes) pane.calibrationOverlay.setSelection(range)
      void this.setPdfLoop(range)
      if (range) {
        const loopRegion = this.loopRegionForPointRange(calibrationOverlay.getPoints(), range)
        if (loopRegion) void this.seekActive(tabState, loopRegion[0])
      }
      if (this.activeHash !== tabState.fileHash) return
      this.selectionStatusEl.textContent = range
        ? `Selected measures ${range.startIndex}-${range.endIndex}`
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
      this.calibrationStatusEl.textContent = this.measureStatusText(tabState)
      const hasAudio = points.length >= 2
      const isPlaying = !this.stopBtn.disabled
      this.playBtn.disabled = !hasAudio || isPlaying
      for (const btn of Object.values(this.speedButtons)) btn.disabled = !hasAudio
      this.metronomeBtn.disabled = !hasAudio
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

    this.setLoadingStep('Rendering first page…')
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
    this.syncRightPanePoints(tab)
    if (this.activeHash === tab.fileHash) {
      const count = pageResults.reduce((n, r) => n + r.systems.reduce((m, s) => m + s.barline_xs.length, 0), 0)
      this.calibrationStatusEl.textContent = `Auto-detected ${count} measure(s) across ${tab.pageCount} page(s) — double-check them, the detector isn't always right.`
    }
  }

  /**
   * Single-page mode: shows exactly `pageNumber`. Book mode: aligns
   * `pageNumber` down to its even spread start (0&1, 2&3, ...) — same rule
   * `BookPageView.showPage` uses for `.mscz` — and renders that page into
   * the primary/left pane, `+1` into `rightPane` (left blank past the last
   * page, for an odd-paged document's final spread).
   */
  private async showPdfPage(tab: PdfTabState, pageNumber: number): Promise<void> {
    if (pageNumber < 0 || pageNumber >= tab.pageCount) return
    if (tab.scrollMode) return this.showPdfScrollPage(tab, pageNumber)
    const spreadStart = tab.bookMode ? pageNumber - (pageNumber % 2) : pageNumber

    tab.currentPage = spreadStart
    tab.primaryPage = spreadStart
    await this.renderPdfPane(tab, { canvasContainer: tab.canvasContainer, calibrationOverlay: tab.calibrationOverlay, currentPage: tab.currentPage }, spreadStart, () => tab.currentPage === spreadStart)
    if (tab.currentPage !== spreadStart) return // stale: navigated elsewhere while this render was in flight

    const right = tab.bookMode ? tab.extraPanes[0] : undefined
    if (right) {
      const rightPage = spreadStart + 1
      if (rightPage >= tab.pageCount) {
        right.canvasContainer.querySelector('canvas')?.remove()
        right.currentPage = rightPage
        setStagePage(right.canvasContainer, null)
      } else {
        right.currentPage = rightPage
        await this.renderPdfPane(tab, right, rightPage, () => right.currentPage === rightPage)
      }
    }

    this.updatePdfPageIndicator(tab)
  }

  private updatePdfPageIndicator(tab: PdfTabState): void {
    if (this.activeHash !== tab.fileHash) return
    const start = tab.currentPage
    const spread = tab.bookMode && !tab.scrollMode
    this.pageIndicatorEl.textContent = spread
      ? `Pages ${start + 1}-${Math.min(start + 2, tab.pageCount)} / ${tab.pageCount}`
      : `Page ${start + 1} / ${tab.pageCount}`
    this.prevBtn.disabled = start <= 0
    this.nextBtn.disabled = start >= tab.pageCount - (spread ? 2 : 1)
  }

  /** Scroll mode's `showPdfPage`: scrolls to the page (its placeholder is already the right size) and makes sure it's rendered. */
  private async showPdfScrollPage(tab: PdfTabState, pageNumber: number): Promise<void> {
    tab.currentPage = pageNumber
    tab.scrollTracker?.setCurrent(pageNumber)
    this.pdfPanes(tab)[pageNumber]?.canvasContainer.scrollIntoView({ block: 'start', inline: 'start' })
    this.updatePdfPageIndicator(tab)
    await this.renderPdfScrollPane(tab, pageNumber)
  }

  /** Renders scroll-mode page `pageNumber` at the tab's current zoom unless it already is. */
  private async renderPdfScrollPane(tab: PdfTabState, pageNumber: number): Promise<void> {
    const pane = this.pdfPanes(tab)[pageNumber]
    if (!pane || !tab.scrollMode) return
    const zoom = tab.zoom
    if (tab.scrollRendered.get(pageNumber) === zoom) return
    tab.scrollRendered.set(pageNumber, zoom)
    try {
      const canvas = await renderPdfPage(tab.doc, pageNumber + 1, PDF_BASE_WIDTH * zoom)
      if (!tab.scrollMode || tab.scrollRendered.get(pageNumber) !== zoom) return // mode or zoom changed mid-render
      pane.canvasContainer.querySelector('canvas')?.remove()
      pane.canvasContainer.insertBefore(canvas, pane.canvasContainer.firstChild)
    } catch (e) {
      tab.scrollRendered.delete(pageNumber)
      console.error(`Failed to render page ${pageNumber + 1}:`, e)
    }
  }

  /** Sizes every scroll-mode pane to its page's footprint at the current zoom, so unrendered pages reserve the right room. */
  private sizePdfScrollPanes(tab: PdfTabState): void {
    const width = PDF_BASE_WIDTH * tab.zoom
    this.pdfPanes(tab).forEach((pane, i) => {
      const aspect = tab.aspects?.[i] ?? tab.aspects?.[0] ?? 0.77
      pane.canvasContainer.style.width = `${width}px`
      pane.canvasContainer.style.height = `${width / aspect}px`
    })
  }

  /** Zoom change in scroll mode: resize all placeholders, keep the reading position, and re-render whatever is near the viewport. */
  private relayoutPdfScroll(tab: PdfTabState): void {
    preserveScrollRatio(this.pageContainerEl, () => this.sizePdfScrollPanes(tab))
    this.observePdfScroll(tab)
  }

  /** (Re)starts the near-viewport render observer and current-page tracker over scroll mode's panes. */
  private observePdfScroll(tab: PdfTabState): void {
    tab.scrollNear?.disconnect()
    tab.scrollTracker?.disconnect()
    tab.scrollNear = new NearViewportObserver(this.pageContainerEl, (i) => void this.renderPdfScrollPane(tab, i))
    tab.scrollTracker = new CurrentPageTracker(this.pageContainerEl, (i) => {
      tab.currentPage = i
      this.updatePdfPageIndicator(tab)
    })
    tab.scrollTracker.setCurrent(tab.currentPage)
    this.pdfPanes(tab).forEach((pane, i) => {
      tab.scrollNear!.observe(pane.canvasContainer, i)
      tab.scrollTracker!.observe(pane.canvasContainer, i)
    })
  }

  /** Renders `pageNumber` into one pane (left or right), guarded by `stillCurrent` against a stale response landing after the user navigated elsewhere while this render was in flight — same race `showPdfPage` itself already guarded against before book mode gave it two panes to manage instead of one. */
  private async renderPdfPane(tab: PdfTabState, pane: PdfPane, pageNumber: number, stillCurrent: () => boolean): Promise<void> {
    const canvas = await renderPdfPage(tab.doc, pageNumber + 1, PDF_BASE_WIDTH * tab.zoom)
    if (!stillCurrent()) return
    // Remove only the old <canvas>, not canvasContainer's whole subtree —
    // CalibrationOverlay's own layers (dots/drag-rect) are also mounted
    // inside canvasContainer (so they stay sized/positioned exactly to the
    // canvas, see that constructor call's comment), and innerHTML = '' would
    // silently detach them from the DOM on every page change/zoom, leaving
    // `render()` drawing into disconnected nodes nothing ever displays.
    pane.canvasContainer.querySelector('canvas')?.remove()
    pane.canvasContainer.insertBefore(canvas, pane.canvasContainer.firstChild)
    pane.calibrationOverlay.setPage(pageNumber)
    setStagePage(pane.canvasContainer, pageNumber)
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
    if (!this.pdfPaneFor(tab, point.page)) void this.showPdfPage(tab, point.page)
    if (this.activeHash !== tab.fileHash) return
    const pane = this.pdfPaneFor(tab, point.page)
    if (pane) pane.canvasContainer.appendChild(this.headMarker.el)
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
      await this.clearSelection(tab)
    }
    if (this.activeHash === tab.fileHash) await seekMidi(targetMs)
    this.updateHeadMarker(tab)
  }

  /** Clears `tab`'s measure selection — its highlight on every pane, the status text, and the loop it armed. */
  private async clearSelection(tab: TabState): Promise<void> {
    if (tab.kind === 'mscz') {
      tab.selection = null
      tab.selectionOverlay.setSelection(null)
    } else {
      tab.selectedRange = null
      tab.calibrationOverlay.setSelection(null)
      for (const pane of tab.extraPanes) pane.calibrationOverlay.setSelection(null)
    }
    if (this.activeHash !== tab.fileHash) return
    this.selectionStatusEl.textContent = ''
    if (tab.kind === 'mscz') await this.setLoop(null)
    else await this.setPdfLoop(null)
  }

  /**
   * Start time of the piece playing at `positionMs` (the latest piece
   * boundary at or before the measure playing then, matched in the same
   * unrolled pass, so a repeat inside the piece doesn't confuse it). A
   * single-piece file has its only boundary at measure 0, i.e. time 0.
   */
  private pieceStartMs(tab: MsczTabState, positionMs: number): number {
    const events = tab.timeline?.events
    if (!events || events.length === 0) return 0
    let current = 0
    while (current + 1 < events.length && events[current + 1].time_ms <= positionMs) current++
    const elid = events[current].source_elid
    const pieceStartElid = tab.pieces.reduce((best, p) => (p.start_measure_index <= elid ? Math.max(best, p.start_measure_index) : best), 0)
    for (let i = current; i >= 0; i--) {
      if (events[i].source_elid === pieceStartElid) return events[i].time_ms
    }
    return 0
  }

  /**
   * A printed measure can play several times (repeats, D.S./D.C.); clicking
   * it seeks to the pass nearest the current head rather than always the
   * first one, so clicking inside a repeated section you're already in
   * doesn't jump back a whole pass.
   */
  private eventForElidNearHead(timeline: Timeline, elid: number, headMs: number): TimelineEvent | null {
    let best: TimelineEvent | null = null
    for (const e of timeline.events) {
      if (e.source_elid !== elid) continue
      if (!best || Math.abs(e.time_ms - headMs) < Math.abs(best.time_ms - headMs)) best = e
    }
    return best
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
    // headMs only moves on explicit seeks, not while audio plays — ask the
    // engine where playback actually got to, to know which piece we're in.
    let positionMs = active.headMs
    try {
      positionMs = (await getPlaybackPosition()) * 1000
    } catch (e) {
      console.error('Failed to read playback position:', e)
    }
    await stopMidi()
    this.msczCursor.stop()
    this.pdfCursor.stop()
    // The "currently playing" highlight only means anything while playing
    // (or paused mid-measure) — the head marker alone shows where play resumes.
    this.cursorBoxEl.style.display = 'none'
    if (active.kind === 'pdf') {
      active.calibrationOverlay.setPlayingIndex(null)
      for (const pane of active.extraPanes) pane.calibrationOverlay.setPlayingIndex(null)
    }
    active.transportState = 'stopped'
    // Head resets to the active loop's start if one is set (loop stays
    // armed across Stop, see setLoop/setPdfLoop), else to the start of the
    // piece being played — never all the way back to the top of a
    // multi-piece file.
    active.headMs = active.loopRegion?.[0] ?? (active.kind === 'mscz' ? this.pieceStartMs(active, positionMs) : 0)
    this.updateHeadMarker(active)
    this.renderTransportButtons('stopped', true)
  }

  private togglePlayPause(): void {
    const active = this.activeTab()
    if (!active) return
    if (active.transportState === 'playing') void this.pauseActive()
    else void this.playActive()
  }

  private setMetronomeOn(on: boolean): void {
    this.metronomeOn = on
    this.metronomeBtn.classList.toggle('active', on)
    this.metronomeBtn.setAttribute('aria-pressed', String(on))
    this.metronomeBtn.title = on ? 'Metronome on (M)' : 'Metronome off (M)'
    void setMetronomeEnabled(on)
  }

  private toggleZenMode(): void {
    this.root.classList.toggle('zen-mode')
  }

  /**
   * Switches the active tab's page display between single page, two-page
   * "book" spread, vertical scroll (all pages in one strip) and — scroll +
   * book — a horizontal strip, preserving the current page and zoom.
   *
   * `.mscz`: a full tear-down/rebuild of `pageView`/`selectionOverlay` — each
   * display owns its own DOM subtree, so swapping cleanly means destroying
   * the old one and constructing the new one, as opening a new tab does.
   *
   * PDF: the primary pane is reused; `extraPanes` is rebuilt (the book
   * spread's right page, or every other page in scroll mode).
   */
  private async setDisplayModeForActiveTab(change: { book?: boolean; scroll?: boolean }): Promise<void> {
    const active = this.activeTab()
    if (!active) return
    const book = change.book ?? active.bookMode
    const scroll = change.scroll ?? active.scrollMode
    if (active.kind === 'mscz') await this.setMsczDisplayMode(active, book, scroll)
    else await this.setPdfDisplayMode(active, book, scroll)
    this.bookModeBtn.classList.toggle('active', book)
    this.scrollModeBtn.classList.toggle('active', scroll)
  }

  private async setMsczDisplayMode(active: MsczTabState, book: boolean, scroll: boolean): Promise<void> {
    const currentPage = active.pageView.page
    const currentZoom = active.pageView.getZoom()
    const pageCount = active.pageView.pages

    active.selectionOverlay.destroy()
    active.pageContainer.innerHTML = ''
    active.pageContainer.className = scroll ? '' : book ? 'page-stage book-spread' : 'page-stage'

    const { pageView, selectionOverlay } = this.createMsczPageDisplay(active.pageContainer, book, scroll, () => active)
    active.pageView = pageView
    active.selectionOverlay = selectionOverlay
    active.bookMode = book
    active.scrollMode = scroll

    this.cursorBoxEl.style.display = 'none'

    await pageView.setScore(active.score, pageCount)
    // setScore resets to page 0 / zoom 1 internally (see PageView.setScore) —
    // restore what the user actually had showing before the mode switch.
    // Zoom first: in scroll mode it sets the page footprints showPage scrolls to.
    pageView.setZoom(currentZoom)
    await pageView.showPage(currentPage)
    this.mountOverlaysOnPage(active, pageView.page)
  }

  /** Removes every extra pane (and scroll observers/sizing), leaving just the primary pane, unstyled for any mode. */
  private teardownPdfExtras(tab: PdfTabState): void {
    tab.scrollNear?.disconnect()
    tab.scrollTracker?.disconnect()
    tab.scrollNear = null
    tab.scrollTracker = null
    tab.scrollRendered.clear()
    for (const pane of tab.extraPanes) {
      pane.calibrationOverlay.destroy()
      pane.canvasContainer.remove()
    }
    tab.extraPanes = []
    tab.canvasContainer.classList.remove('book-page', 'scroll-page')
    tab.canvasContainer.style.width = ''
    tab.canvasContainer.style.height = ''
  }

  private async ensurePdfAspects(tab: PdfTabState): Promise<number[]> {
    if (tab.aspects) return tab.aspects
    const aspects: number[] = []
    for (let i = 1; i <= tab.pageCount; i++) {
      const vp = (await tab.doc.getPage(i)).getViewport({ scale: 1 })
      aspects.push(vp.width / vp.height)
    }
    tab.aspects = aspects
    return aspects
  }

  private async setPdfDisplayMode(active: PdfTabState, book: boolean, scroll: boolean): Promise<void> {
    const currentPage = active.currentPage
    this.teardownPdfExtras(active)
    active.bookMode = book
    active.scrollMode = scroll
    active.pageContainer.classList.remove('scroll-spread', 'scroll-vertical', 'scroll-horizontal')
    active.pageContainer.classList.toggle('book-spread', book && !scroll)
    this.headMarker.el.remove()

    if (scroll) {
      await this.ensurePdfAspects(active)
      active.pageContainer.classList.add('scroll-spread', book ? 'scroll-horizontal' : 'scroll-vertical')
      active.canvasContainer.classList.add('scroll-page')
      active.primaryPage = 0
      active.calibrationOverlay.setPage(0)
      setStagePage(active.canvasContainer, 0)
      active.canvasContainer.querySelector('canvas')?.remove()
      for (let i = 1; i < active.pageCount; i++) {
        const container = this.createPdfCanvasContainer()
        container.classList.add('scroll-page')
        active.pageContainer.appendChild(container)
        const overlay = new CalibrationOverlay(container)
        overlay.setPoints(active.points)
        overlay.setPage(i)
        this.wirePdfPaneInteractions(active, overlay)
        setStagePage(container, i)
        active.extraPanes.push({ canvasContainer: container, calibrationOverlay: overlay, currentPage: i })
      }
      active.currentPage = Math.min(currentPage, active.pageCount - 1)
      this.sizePdfScrollPanes(active)
      this.observePdfScroll(active)
      await this.showPdfScrollPage(active, active.currentPage)
      return
    }

    if (book) {
      active.canvasContainer.classList.add('book-page')
      const rightCanvasContainer = this.createPdfCanvasContainer()
      rightCanvasContainer.classList.add('book-page', 'book-page-right')
      active.pageContainer.appendChild(rightCanvasContainer)
      const rightCalibrationOverlay = new CalibrationOverlay(rightCanvasContainer)
      rightCalibrationOverlay.setPoints(active.points)
      this.wirePdfPaneInteractions(active, rightCalibrationOverlay)
      active.extraPanes = [{ canvasContainer: rightCanvasContainer, calibrationOverlay: rightCalibrationOverlay, currentPage: currentPage + 1 }]
    }
    await this.showPdfPage(active, currentPage)
  }

  /** Wires a `CalibrationOverlay` (the right pane's — the primary/left one is already wired at tab construction) into the same selection/seek handling every pane shares, minus persistence (the primary pane alone owns `onChange` -> `saveCalibrationPoints`, since both panes always show the same underlying point list rather than independent copies — see `PdfTabState.rightPane`'s docs). */
  private wirePdfPaneInteractions(tab: PdfTabState, overlay: CalibrationOverlay): void {
    overlay.onSelect((range) => {
      tab.selectedRange = range
      tab.calibrationOverlay.setSelection(range)
      void this.setPdfLoop(range)
      if (range) {
        const loopRegion = this.loopRegionForPointRange(overlay.getPoints(), range)
        if (loopRegion) void this.seekActive(tab, loopRegion[0])
      }
      if (this.activeHash !== tab.fileHash) return
      this.selectionStatusEl.textContent = range ? `Selected measures ${range.startIndex}-${range.endIndex}` : ''
    })
    overlay.onSeek((pointIndex) => {
      const point = overlay.getPoints()[pointIndex]
      if (point) void this.seekActive(tab, point.time_ms)
    })
  }

  /** Re-pushes the primary pane's point list into `rightPane`'s independent `CalibrationOverlay` instance — call after any mutation (`addPointsFromBarlines*`, `clearAllPoints`) made through the primary pane, so book mode's second pane doesn't silently go stale relative to it. No-op outside book mode. */
  private syncRightPanePoints(tab: PdfTabState): void {
    for (const pane of tab.extraPanes) pane.calibrationOverlay.setPoints(tab.calibrationOverlay.getPoints())
  }

  /** Picks up `tool`, or puts it down if it's already the active one. */
  private toggleMarkerTool(tool: MarkerTool): void {
    this.markerOverlay.setTool(this.markerOverlay.activeTool === tool ? null : tool)
  }

  private renderMarkerToolButtons(tool: MarkerTool | null): void {
    this.textToolBtn.classList.toggle('active', tool === 'text')
    this.fingeringToolBtn.classList.toggle('active', tool === 'fingering')
  }

  /**
   * Tab-kind-specific placement for `MarkerOverlay`. `.mscz`: a text marker
   * snaps to the top-left of the measure clicked on (or nearest to the
   * click — clicking just above a staff is the natural "write it above the
   * measure" gesture, and that's outside the measure's own box), so it sits
   * above that measure. PDF tabs have no measure boxes, only barline points,
   * so text goes exactly where it was clicked. Fingering always goes exactly
   * where it was clicked.
   */
  private markerHostFor(tab: TabState): MarkerHost {
    if (tab.kind === 'mscz') {
      return {
        placementFor: (kind, click) => {
          if (kind !== 'text') return click
          const elements = tab.pageView.getPositions()?.elements.filter((e) => e.page === click.page) ?? []
          if (elements.length === 0) return click
          const { width, height } = this.pageSize(tab, click.page)
          const px = click.x * width
          const py = click.y * height
          const verticalGap = (e: (typeof elements)[number]): number => Math.max(0, e.y - py, py - (e.y + e.sy))
          const inColumn = elements.filter((e) => px >= e.x && px <= e.x + e.sx)
          const candidates = inColumn.length > 0 ? inColumn : elements
          const nearest = candidates.reduce((best, e) => (verticalGap(e) < verticalGap(best) ? e : best))
          return { page: click.page, x: nearest.x / width, y: nearest.y / height }
        },
        resolveLegacy: (measureIndex) => {
          const event = tab.timeline?.events.find((e) => e.measure_index === measureIndex)
          if (!event) return null
          const { width, height } = this.pageSize(tab, event.page)
          return { page: event.page, x: event.bbox.x / width, y: event.bbox.y / height }
        },
      }
    }
    return {
      placementFor: (_kind, click) => click,
      resolveLegacy: (measureIndex) => {
        const point = tab.calibrationOverlay.getPoints().find((p) => p.measure === measureIndex)
        return point ? { page: point.page, x: point.x, y: point.y } : null
      },
    }
  }

  /** Toolbar "go to measure" input — 1-based like the number a musician would actually call out ("measure 24"), converted to this app's internal 0-based `measure_index` before jumping. */
  private goToMeasureFromInput(): void {
    const raw = Number(this.gotoMeasureInput.value)
    if (!Number.isFinite(raw) || raw < 1) return
    this.jumpToMeasure(Math.floor(raw) - 1)
  }

  private goToPrevPage(): void {
    const active = this.activeTab()
    if (!active) return
    if (active.kind === 'mscz') {
      void active.pageView.prev()
    } else {
      const step = active.bookMode && !active.scrollMode ? 2 : 1
      void this.showPdfPage(active, active.currentPage - step)
    }
  }

  private goToNextPage(): void {
    const active = this.activeTab()
    if (!active) return
    if (active.kind === 'mscz') {
      void active.pageView.next()
    } else {
      const step = active.bookMode && !active.scrollMode ? 2 : 1
      void this.showPdfPage(active, active.currentPage + step)
    }
  }
}

/** Records which page a PDF page-stage shows (`null`: none) and announces it — the PDF-side twin of what `PageView.setContent` does for `.mscz` stages. */
function setStagePage(stage: HTMLElement, page: number | null): void {
  if (page === null) delete stage.dataset.page
  else stage.dataset.page = String(page)
  stage.dispatchEvent(new CustomEvent(PAGE_RENDERED_EVENT, { bubbles: true }))
}

const METRONOME_VOLUME_KEY = 'lyrica.metronomeVolume'
const DEFAULT_METRONOME_VOLUME = 0.8

/** Last-used metronome volume (0-1) — a per-machine convenience, so browser storage is enough; falls back to the default when storage is unavailable. */
function loadMetronomeVolume(): number {
  try {
    const stored = Number(localStorage.getItem(METRONOME_VOLUME_KEY))
    if (localStorage.getItem(METRONOME_VOLUME_KEY) !== null && Number.isFinite(stored)) return Math.min(1, Math.max(0, stored))
  } catch {
    // storage unavailable — default stands
  }
  return DEFAULT_METRONOME_VOLUME
}

function saveMetronomeVolume(volume: number): void {
  try {
    localStorage.setItem(METRONOME_VOLUME_KEY, String(volume))
  } catch {
    // storage unavailable — the setting just won't persist
  }
}

function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name)
}

function isOpenableFile(name: string): boolean {
  return /\.(mscz|mscx|pdf)$/i.test(name)
}
