import './theme.css'
import './app.css'
import { openScore, upgradeScore, getMeasurePositions, getMidi, type OpenScoreResult, type WebMscore } from './score-engine'
import { loadPdf, renderPdfPage, canvasToPngBytes, type PdfDocument } from './pdf-engine'
import { PageView, ZOOM_STEP, MIN_ZOOM, MAX_ZOOM } from './render/PageView'
import { SelectionOverlay, type MeasureRange } from './render/SelectionOverlay'
import { CalibrationOverlay, type PointRange } from './views/CalibrationOverlay'
import { Cursor } from './render/Cursor'
import {
  isTauri,
  importTimeline,
  loadMidi,
  playMidi,
  stopMidi,
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
} from './api-client'
import { MarkerPanel } from './views/MarkerPanel'
import { PiecesIndex } from './views/PiecesIndex'
import { TabBar, type TabInfo } from './views/TabBar'
import { RecentFilesList } from './views/RecentFilesList'
import type { CalibrationPoint, StaffSystem, Timeline, TimelineEvent } from './types'
import { initTheme, applyTheme, THEME_LABELS, type Theme } from './theme'

initTheme()

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
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
    </div>
    <div class="toolbar-spacer"></div>
    <div class="toolbar-group">
      <select id="theme-select" class="theme-select" title="Theme"></select>
    </div>
  </div>

  <div class="sidebar">
    <div id="pieces-index" class="sidebar-section"></div>
    <div id="marker-panel" class="sidebar-section"></div>
    <div id="recent-files" class="sidebar-section"></div>
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
    </div>
    <div id="page" class="page-area">
      <div class="empty-state" id="empty-state">
        <div>No file open</div>
        <div class="hint">Open a .mscz or .pdf file, or drag one onto this window</div>
      </div>
    </div>
  </div>

  <div id="tab-bar" class="tab-bar"></div>
`

const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const navEl = document.querySelector<HTMLDivElement>('#nav')!
const transportEl = document.querySelector<HTMLDivElement>('#transport')!
const zoomGroupEl = document.querySelector<HTMLDivElement>('#zoom-group')!
const pageIndicatorEl = document.querySelector<HTMLSpanElement>('#page-indicator')!
const prevBtn = document.querySelector<HTMLButtonElement>('#prev-page')!
const nextBtn = document.querySelector<HTMLButtonElement>('#next-page')!
const playBtn = document.querySelector<HTMLButtonElement>('#play-btn')!
const stopBtn = document.querySelector<HTMLButtonElement>('#stop-btn')!
const speedButtons = {
  0.5: document.querySelector<HTMLButtonElement>('#speed-05')!,
  0.75: document.querySelector<HTMLButtonElement>('#speed-075')!,
  1.0: document.querySelector<HTMLButtonElement>('#speed-10')!,
}
const metronomeCheckbox = document.querySelector<HTMLInputElement>('#metronome-checkbox')!
const pageContainerEl = document.querySelector<HTMLDivElement>('#page')!
const emptyStateEl = document.querySelector<HTMLDivElement>('#empty-state')!
const selectionStatusEl = document.querySelector<HTMLSpanElement>('#selection-status')!
const loopStatusEl = document.querySelector<HTMLSpanElement>('#loop-status')!
const calibrationStatusEl = document.querySelector<HTMLSpanElement>('#calibration-status')!
const pdfControlsEl = document.querySelector<HTMLDivElement>('#pdf-controls')!
const markingModeCheckbox = document.querySelector<HTMLInputElement>('#marking-mode-checkbox')!
const suggestBarlinesBtn = document.querySelector<HTMLButtonElement>('#suggest-barlines-btn')!
const clearPointsBtn = document.querySelector<HTMLButtonElement>('#clear-points-btn')!
const zoomOutBtn = document.querySelector<HTMLButtonElement>('#zoom-out')!
const zoomInBtn = document.querySelector<HTMLButtonElement>('#zoom-in')!
const zoomIndicatorEl = document.querySelector<HTMLSpanElement>('#zoom-indicator')!
const themeSelectEl = document.querySelector<HTMLSelectElement>('#theme-select')!
const dropOverlay = document.querySelector<HTMLDivElement>('#drop-overlay')!

for (const theme of Object.keys(THEME_LABELS) as Theme[]) {
  const opt = document.createElement('option')
  opt.value = theme
  opt.textContent = THEME_LABELS[theme]
  themeSelectEl.appendChild(opt)
}
themeSelectEl.value = document.documentElement.getAttribute('data-theme') ?? 'light'
themeSelectEl.addEventListener('change', () => applyTheme(themeSelectEl.value as Theme))

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
interface MsczTabState {
  kind: 'mscz'
  fileHash: string
  title: string
  score: WebMscore
  pageView: PageView
  selectionOverlay: SelectionOverlay
  pageContainer: HTMLDivElement
  timeline: Timeline | null
  selection: MeasureRange | null
  speed: number
  loopRegion: [number, number] | null
  originalBytes: Uint8Array
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
}

type TabState = MsczTabState | PdfTabState

const tabs = new Map<string, TabState>()

/** Default time signature numerator for calibration (used for bar-accent tracking) — no concept of a parsed time signature exists for a plain PDF, so this is a fixed assumption the user isn't currently able to change (future UI could expose it). */
const PDF_DEFAULT_NUMERATOR = 4
const PDF_BASE_WIDTH = 700
const PDF_ZOOM_STEP = 0.25
const PDF_MIN_ZOOM = 0.5
const PDF_MAX_ZOOM = 3
let activeHash: string | null = null

const tabBarEl = document.querySelector<HTMLDivElement>('#tab-bar')!
const tabBar = new TabBar(tabBarEl)
tabBar.onSwitch((hash) => void switchToTab(hash))
tabBar.onClose((hash) => closeTab(hash))

const recentFilesEl = document.querySelector<HTMLDivElement>('#recent-files')!
const recentFilesList = new RecentFilesList(recentFilesEl)
recentFilesList.onOpen((entry) => void reopenRecentFile(entry.path))
void recentFilesList.refresh()

const msczCursor = new Cursor<TimelineEvent>((event) => {
  const active = activeTab()
  if (!active || active.kind !== 'mscz') return
  if (event.page !== active.pageView.page) {
    active.pageView.showPage(event.page)
  }
  cursorBoxEl.style.display = 'block'
  cursorBoxEl.style.left = `${(event.bbox.x / currentPageWidth()) * 100}%`
  cursorBoxEl.style.top = `${(event.bbox.y / currentPageHeight()) * 100}%`
  cursorBoxEl.style.width = `${(event.bbox.sx / currentPageWidth()) * 100}%`
  cursorBoxEl.style.height = `${(event.bbox.sy / currentPageHeight()) * 100}%`
})

/**
 * PDF mode has no bbox to draw a highlight box from — only each calibration
 * point's own `{page, x, y}` — so this highlights the *segment* currently
 * playing (from the active point to the next one, or a small fixed window
 * past the last point) by driving CalibrationOverlay's own selection
 * highlighting, the same highlight style drag-selecting a loop range
 * already uses.
 */
const pdfCursor = new Cursor<CalibrationPoint>((_point, itemIndex) => {
  const active = activeTab()
  if (!active || active.kind !== 'pdf') return
  const points = active.calibrationOverlay.getPoints()
  const target = points[itemIndex]
  if (!target) return
  if (target.page !== active.currentPage) {
    void showPdfPage(active, target.page)
  }
  active.calibrationOverlay.setPlayingIndex(itemIndex)
})

const markerPanelEl = document.querySelector<HTMLDivElement>('#marker-panel')!
const markerPanel = new MarkerPanel(markerPanelEl)

/**
 * A new marker attaches to the current selection's first measure (the
 * timeline's `measure_index`, looked up via the selection's start elid) —
 * matching the "click-drag-select" direct-manipulation style the loop
 * feature already uses, rather than a separate "pick a measure" step.
 */
markerPanel.onRequestMeasureIndex(() => {
  const active = activeTab()
  if (!active || active.kind !== 'mscz' || !active.timeline || !active.selection) return null
  const event = active.timeline.events.find((e) => e.source_elid === active.selection!.startElid)
  return event?.measure_index ?? null
})

/**
 * Jumps to the page containing the TimelineEvent at the given `measure_index`
 * — the *flattened/repeats-unrolled* index space (`TimelineEvent`s are built
 * one per entry in webmscore's already-unrolled `events[]`, see
 * crates/core/src/timeline.rs). This is the space markers are stored in
 * (`onRequestMeasureIndex` above also reads/writes `measure_index`, not
 * `source_elid`), so marker jump-to and timeline/cursor lookups share it.
 */
function jumpToMeasure(measureIndex: number): void {
  const active = activeTab()
  if (!active || active.kind !== 'mscz' || !active.timeline) return
  const event = active.timeline.events.find((e) => e.measure_index === measureIndex)
  if (!event) return
  if (event.page !== active.pageView.page) {
    void active.pageView.showPage(event.page)
  }
}

markerPanel.onJumpToMeasure(jumpToMeasure)

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
function jumpToElid(elid: number): void {
  const active = activeTab()
  if (!active || active.kind !== 'mscz' || !active.timeline) return
  const event = active.timeline.events.find((e) => e.source_elid === elid)
  if (!event) return
  if (event.page !== active.pageView.page) {
    void active.pageView.showPage(event.page)
  }
}

const piecesIndexEl = document.querySelector<HTMLDivElement>('#pieces-index')!
const piecesIndex = new PiecesIndex(piecesIndexEl)
piecesIndex.onJumpToElid(jumpToElid)

function activeTab(): TabState | null {
  return activeHash ? tabs.get(activeHash) ?? null : null
}

/**
 * Converts a drag-selected elid range to a `[loop_start_ms, loop_end_ms]`
 * pair in the timeline's flattened (1.0x) space, for `setLoopRegion`.
 * `loop_end_ms` is the start time of the event *after* the last matching
 * one (or the timeline's duration if the selection reaches the end), so the
 * loop plays out the full duration of the last selected measure rather than
 * cutting off at its start.
 */
function loopRegionForSelection(timeline: Timeline, range: MeasureRange): [number, number] | null {
  const matching = timeline.events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.source_elid >= range.startElid && e.source_elid <= range.endElid)
  if (matching.length === 0) return null

  const startMs = Math.min(...matching.map(({ e }) => e.time_ms))
  const lastIndex = Math.max(...matching.map(({ index }) => index))
  const endMs = timeline.events[lastIndex + 1]?.time_ms ?? timeline.duration_ms
  return [startMs, endMs]
}

async function setLoop(range: MeasureRange | null): Promise<void> {
  const active = activeTab()
  if (!active || active.kind !== 'mscz') return
  active.loopRegion = (active.timeline && range && loopRegionForSelection(active.timeline, range)) || null
  loopStatusEl.textContent = active.loopRegion
    ? `Looping measures (elid ${range!.startElid}-${range!.endElid})`
    : ''
  await setLoopRegion(active.loopRegion)
}

/**
 * Same idea as `loopRegionForSelection`, but over calibration points instead
 * of `TimelineEvent`s — the user's own framing (see main.ts's PdfTabState
 * docs / the conversation this was designed in) is that calibration points
 * are "converting the PDF to .mscz, but only the measure-boundary part," so
 * this mirrors `loopRegionForSelection`'s "end at the start of the next item
 * after the selection" rule exactly, just against `points[]`/`time_ms`
 * instead of `timeline.events[]`.
 */
function loopRegionForPointRange(points: CalibrationPoint[], range: PointRange): [number, number] | null {
  if (points.length === 0) return null
  const startMs = points[range.startIndex]?.time_ms
  if (startMs === undefined) return null
  const endMs = points[range.endIndex + 1]?.time_ms ?? points[points.length - 1].time_ms + 2000
  return [startMs, endMs]
}

async function setPdfLoop(range: PointRange | null): Promise<void> {
  const active = activeTab()
  if (!active || active.kind !== 'pdf') return
  const points = active.calibrationOverlay.getPoints()
  active.loopRegion = (range && loopRegionForPointRange(points, range)) || null
  loopStatusEl.textContent = active.loopRegion
    ? `Looping between calibration points ${range!.startIndex}-${range!.endIndex}`
    : ''
  await setLoopRegion(active.loopRegion)
}

window.addEventListener('keydown', (e) => {
  const active = activeTab()
  if (e.key.toLowerCase() !== 'l' || !isTauri() || !active) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (active.kind === 'mscz' && active.timeline) {
    void setLoop(active.selection)
  } else if (active.kind === 'pdf' && !active.markingMode) {
    void setPdfLoop(active.selectedRange)
  }
})

function setSpeed(speed: number): void {
  const active = activeTab()
  if (active) active.speed = speed
  for (const [value, btn] of Object.entries(speedButtons)) {
    btn.classList.toggle('active', Number(value) === speed)
  }
  void setPlaybackSpeed(speed)
}

for (const [value, btn] of Object.entries(speedButtons)) {
  btn.addEventListener('click', () => setSpeed(Number(value)))
}
speedButtons[1.0].classList.add('active')

metronomeCheckbox.addEventListener('change', () => {
  void setMetronomeEnabled(metronomeCheckbox.checked)
})

const cursorBoxEl = document.createElement('div')
cursorBoxEl.style.position = 'absolute'
cursorBoxEl.style.border = '2px solid var(--cursor-box)'
cursorBoxEl.style.background = 'var(--cursor-fill)'
cursorBoxEl.style.pointerEvents = 'none'
cursorBoxEl.style.display = 'none'

function currentPageWidth(): number {
  const svg = activeTab()?.pageContainer.querySelector('svg')
  return svg ? parseFloat(svg.getAttribute('viewBox')?.split(' ')[2] ?? '0') : 1
}

function currentPageHeight(): number {
  const svg = activeTab()?.pageContainer.querySelector('svg')
  return svg ? parseFloat(svg.getAttribute('viewBox')?.split(' ')[3] ?? '0') : 1
}

function renderTabBar(): void {
  const tabInfos: TabInfo[] = Array.from(tabs.values()).map((t) => ({ fileHash: t.fileHash, title: t.title }))
  tabBar.setTabs(tabInfos, activeHash)
}

/** Stops shared audio playback — the backend owns one synth/stream for the whole app, not one per tab. */
async function stopAudioForTabSwitch(): Promise<void> {
  await stopMidi()
  msczCursor.stop()
  pdfCursor.stop()
  playBtn.disabled = true
  stopBtn.disabled = true
}

/** Mounts `tab.pageContainer` as the visible page, restores its UI state (speed/loop/selection), and re-points the shared panels. */
async function activateTab(tab: TabState): Promise<void> {
  activeHash = tab.fileHash
  pageContainerEl.innerHTML = ''
  pageContainerEl.appendChild(tab.pageContainer)
  emptyStateEl.style.display = 'none'

  statusEl.textContent = tab.title
  calibrationStatusEl.textContent = ''
  pdfControlsEl.style.display = tab.kind === 'pdf' ? 'flex' : 'none'
  transportEl.style.display = 'flex'
  zoomGroupEl.style.display = 'flex'

  if (tab.kind === 'mscz') {
    tab.pageContainer.appendChild(cursorBoxEl)
    cursorBoxEl.style.display = 'none'

    navEl.style.display = tab.pageView.pages > 1 ? 'flex' : 'none'
    pageIndicatorEl.textContent = `Page ${tab.pageView.page + 1} / ${tab.pageView.pages}`
    prevBtn.disabled = tab.pageView.page <= 0
    nextBtn.disabled = tab.pageView.page >= tab.pageView.pages - 1
    selectionStatusEl.textContent = tab.selection
      ? `Selected measures (elid ${tab.selection.startElid}-${tab.selection.endElid}) — press L to loop`
      : ''
    loopStatusEl.textContent = tab.loopRegion ? 'Looping selected measures' : ''
    zoomIndicatorEl.textContent = `${Math.round(tab.pageView.getZoom() * 100)}%`
    zoomOutBtn.disabled = tab.pageView.getZoom() <= MIN_ZOOM
    zoomInBtn.disabled = tab.pageView.getZoom() >= MAX_ZOOM

    msczCursor.setItems(tab.timeline?.events ?? null)
    pdfCursor.setItems(null)
    await markerPanel.setFileHash(tab.fileHash)
    await piecesIndex.setScoreBytes(tab.originalBytes)

    const hasAudio = tab.timeline !== null
    playBtn.disabled = !hasAudio
    stopBtn.disabled = true
    for (const btn of Object.values(speedButtons)) btn.disabled = !hasAudio
    metronomeCheckbox.disabled = !hasAudio

    if (hasAudio) {
      setSpeed(tab.speed)
      const midiBytes = await getMidi(tab.score)
      await loadMidi(midiBytes)
      await setLoopRegion(tab.loopRegion)
      await setMetronomeEnabled(metronomeCheckbox.checked)
    }
  } else {
    selectionStatusEl.textContent = tab.selectedRange
      ? `Selected calibration points ${tab.selectedRange.startIndex}-${tab.selectedRange.endIndex} — press L to loop`
      : ''
    loopStatusEl.textContent = tab.loopRegion ? 'Looping between calibration points' : ''
    calibrationStatusEl.textContent = markingModeStatusText(tab)
    markingModeCheckbox.checked = tab.markingMode
    tab.calibrationOverlay.setMarkingMode(tab.markingMode)
    suggestBarlinesBtn.style.display = tab.markingMode ? 'inline-block' : 'none'
    clearPointsBtn.style.display = tab.markingMode ? 'inline-block' : 'none'
    zoomIndicatorEl.textContent = `${Math.round(tab.zoom * 100)}%`
    zoomOutBtn.disabled = tab.zoom <= PDF_MIN_ZOOM
    zoomInBtn.disabled = tab.zoom >= PDF_MAX_ZOOM

    msczCursor.setItems(null)
    pdfCursor.setItems(tab.calibrationOverlay.getPoints())
    await markerPanel.setFileHash(null)
    await piecesIndex.setScoreBytes(null)

    navEl.style.display = tab.pageCount > 1 ? 'flex' : 'none'
    pageIndicatorEl.textContent = `Page ${tab.currentPage + 1} / ${tab.pageCount}`
    prevBtn.disabled = tab.currentPage <= 0
    nextBtn.disabled = tab.currentPage >= tab.pageCount - 1

    const hasAudio = tab.points.length >= 2
    playBtn.disabled = !hasAudio
    stopBtn.disabled = true
    for (const btn of Object.values(speedButtons)) btn.disabled = !hasAudio
    metronomeCheckbox.disabled = !hasAudio

    if (hasAudio) {
      setSpeed(tab.speed)
      await loadPdfTabTempoMap(tab)
      await setLoopRegion(tab.loopRegion)
      await setMetronomeEnabled(metronomeCheckbox.checked)
    }
  }

  renderTabBar()
}

/** Derives and loads the tempo map for a PDF tab's current calibration points, for metronome-only playback. */
async function loadPdfTabTempoMap(tab: PdfTabState): Promise<void> {
  const durationMs = Math.max(...tab.points.map((p) => p.time_ms)) + 4000
  await loadPdfTempoMap(tab.points, tab.numerator, durationMs)
}

function markingModeStatusText(tab: PdfTabState): string {
  return tab.markingMode
    ? `Marking mode: click the page to add a calibration point. ${tab.points.length} point(s) so far.`
    : `${tab.points.length} calibration point(s). Turn on "Mark measures" to add or remove them.`
}

markingModeCheckbox.addEventListener('change', () => {
  const active = activeTab()
  if (!active || active.kind !== 'pdf') return
  active.markingMode = markingModeCheckbox.checked
  active.calibrationOverlay.setMarkingMode(active.markingMode)
  suggestBarlinesBtn.style.display = active.markingMode ? 'inline-block' : 'none'
  clearPointsBtn.style.display = active.markingMode ? 'inline-block' : 'none'
  calibrationStatusEl.textContent = markingModeStatusText(active)
})

suggestBarlinesBtn.addEventListener('click', async () => {
  const active = activeTab()
  if (!active || active.kind !== 'pdf') return
  const canvas = active.canvasContainer.querySelector('canvas')
  if (!canvas) return
  suggestBarlinesBtn.disabled = true
  try {
    const pngBytes = await canvasToPngBytes(canvas)
    const systems = await detectBarlines(pngBytes)
    const count = systems.reduce((n, s) => n + s.barline_xs.length, 0)
    active.calibrationOverlay.addPointsFromBarlines(systems)
    calibrationStatusEl.textContent = `Added ${count} calibration point(s) from detected barlines — double-check them, the detector isn't always right.`
  } catch (e) {
    console.error('Failed to detect barlines:', e)
    calibrationStatusEl.textContent = `Barline suggestion failed: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    suggestBarlinesBtn.disabled = false
  }
})

clearPointsBtn.addEventListener('click', () => {
  const active = activeTab()
  if (!active || active.kind !== 'pdf') return
  const count = active.calibrationOverlay.getPoints().length
  if (count === 0) return
  if (!window.confirm(`Remove all ${count} calibration point(s) for this file? This can't be undone.`)) return
  active.calibrationOverlay.clearAllPoints()
  calibrationStatusEl.textContent = markingModeStatusText(active)
})

function setPdfZoom(tab: PdfTabState, zoom: number): void {
  tab.zoom = Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom))
  zoomIndicatorEl.textContent = `${Math.round(tab.zoom * 100)}%`
  zoomOutBtn.disabled = tab.zoom <= PDF_MIN_ZOOM
  zoomInBtn.disabled = tab.zoom >= PDF_MAX_ZOOM
  void showPdfPage(tab, tab.currentPage)
}

/** Zooms the active tab (either kind) by `delta` (positive = in, negative = out) — shared by the +/- buttons and ctrl+wheel. */
function zoomActiveTab(delta: number): void {
  const active = activeTab()
  if (!active) return
  if (active.kind === 'mscz') {
    active.pageView.setZoom(active.pageView.getZoom() + delta)
  } else {
    setPdfZoom(active, active.zoom + delta * (PDF_ZOOM_STEP / ZOOM_STEP))
  }
}

zoomOutBtn.addEventListener('click', () => zoomActiveTab(-ZOOM_STEP))
zoomInBtn.addEventListener('click', () => zoomActiveTab(ZOOM_STEP))

/** Ctrl/Cmd+scroll zooms the active tab's page, like a PDF viewer or image editor — matches the gesture users expect instead of scrolling the page area. */
pageContainerEl.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    zoomActiveTab(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
  },
  { passive: false },
)

async function switchToTab(fileHash: string): Promise<void> {
  if (fileHash === activeHash) return
  const tab = tabs.get(fileHash)
  if (!tab) return
  await stopAudioForTabSwitch()
  await activateTab(tab)
}

function closeTab(fileHash: string): void {
  const tab = tabs.get(fileHash)
  if (!tab) return
  if (tab.kind === 'mscz') {
    tab.selectionOverlay.destroy()
    tab.score.destroy()
  } else {
    tab.calibrationOverlay.destroy()
  }
  tabs.delete(fileHash)

  if (activeHash === fileHash) {
    activeHash = null
    const next = tabs.values().next().value as TabState | undefined
    if (next) {
      void stopAudioForTabSwitch().then(() => activateTab(next))
    } else {
      void stopAudioForTabSwitch()
      pageContainerEl.innerHTML = ''
      pageContainerEl.appendChild(emptyStateEl)
      emptyStateEl.style.display = 'flex'
      navEl.style.display = 'none'
      transportEl.style.display = 'none'
      zoomGroupEl.style.display = 'none'
      pdfControlsEl.style.display = 'none'
      statusEl.textContent = ''
      selectionStatusEl.textContent = ''
      loopStatusEl.textContent = ''
      calibrationStatusEl.textContent = ''
      void markerPanel.setFileHash(null)
      void piecesIndex.setScoreBytes(null)
      playBtn.disabled = true
      stopBtn.disabled = true
      for (const btn of Object.values(speedButtons)) btn.disabled = true
      metronomeCheckbox.disabled = true
      void recentFilesList.refresh()
    }
  }
  renderTabBar()
}

function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name)
}

async function openBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
  if (isPdfFile(filename)) {
    await openPdfBytes(bytes, filename, path)
  } else {
    await openMsczBytes(bytes, filename, path)
  }
}

async function openMsczBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
  statusEl.textContent = `Loading ${filename}...`

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
    statusEl.textContent = `Failed to open ${filename}: ${e instanceof Error ? e.message : String(e)}`
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
      statusEl.textContent = `${title} opened, but markers/tabs are unavailable: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // Reopening a file that's already open as a tab just switches to it,
  // rather than creating a duplicate tab for the same score.
  if (fileHash && tabs.has(fileHash)) {
    score.destroy()
    await switchToTab(fileHash)
    return
  }

  await stopAudioForTabSwitch()

  const pageContainer = document.createElement('div')
  pageContainer.className = 'page-stage'

  const pageView = new PageView(
    pageContainer,
    (page, pages, positions) => {
      if (activeHash !== tabState.fileHash) return
      pageIndicatorEl.textContent = `Page ${page + 1} / ${pages}`
      prevBtn.disabled = page <= 0
      nextBtn.disabled = page >= pages - 1
      selectionStatusEl.textContent = ''
      if (positions) {
        selectionOverlay.setPage(positions.elements, page)
      }
    },
    (zoom) => {
      if (activeHash !== tabState.fileHash) return
      zoomIndicatorEl.textContent = `${Math.round(zoom * 100)}%`
      zoomOutBtn.disabled = zoom <= MIN_ZOOM
      zoomInBtn.disabled = zoom >= MAX_ZOOM
    },
  )
  const selectionOverlay = new SelectionOverlay(pageContainer)

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
  }

  selectionOverlay.onSelect((range) => {
    tabState.selection = range
    if (activeHash !== tabState.fileHash) return
    selectionStatusEl.textContent = range
      ? `Selected measures (elid ${range.startElid}-${range.endElid}) — press L to loop`
      : ''
  })

  await pageView.setScore(score, metadata.pages)
  await pageView.showPage(0)

  if (isTauri() && fileHash) {
    const positions = await getMeasurePositions(score)
    const midiBytes = await getMidi(score)
    const { timeline } = await importTimeline(positions, midiBytes)
    tabState.timeline = timeline

    if (path) {
      await recordAndRefreshRecentFile(path, fileHash, title)
    }
  }

  tabs.set(tabState.fileHash, tabState)
  await activateTab(tabState)
}

/** Records the file in the recent-files list and refreshes the (currently hidden, since a tab is now open) list's data so it's correct whenever it's next shown — e.g. after this tab closes. */
async function recordAndRefreshRecentFile(path: string, fileHash: string, title: string): Promise<void> {
  try {
    await recordRecentFile(path, fileHash, title)
  } catch (e) {
    console.error('Failed to record recent file:', e)
  }
  void recentFilesList.refresh()
}

async function openPdfBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
  statusEl.textContent = `Loading ${filename}...`

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
    statusEl.textContent = `Failed to open ${filename}: ${e instanceof Error ? e.message : String(e)}`
    return
  }

  const title = filename

  let fileHash: string | null = null
  if (isTauri()) {
    try {
      fileHash = await hashBytes(originalBytes)
    } catch (e) {
      console.error('Failed to compute file hash:', e)
      statusEl.textContent = `${title} opened, but calibration is unavailable: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (fileHash && tabs.has(fileHash)) {
    await switchToTab(fileHash)
    return
  }

  await stopAudioForTabSwitch()

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
  }

  calibrationOverlay.onSelect((range) => {
    tabState.selectedRange = range
    if (activeHash !== tabState.fileHash) return
    selectionStatusEl.textContent = range
      ? `Selected calibration points ${range.startIndex}-${range.endIndex} — press L to loop`
      : ''
  })

  calibrationOverlay.onChange((points) => {
    tabState.points = points
    if (!tabState.fileHash.startsWith('untracked-')) {
      void saveCalibrationPoints(tabState.fileHash, points).catch((e) =>
        console.error('Failed to save calibration points:', e),
      )
    }
    if (activeHash !== tabState.fileHash) return
    calibrationStatusEl.textContent = markingModeStatusText(tabState)
    const hasAudio = points.length >= 2
    const isPlaying = !stopBtn.disabled
    playBtn.disabled = !hasAudio || isPlaying
    for (const btn of Object.values(speedButtons)) btn.disabled = !hasAudio
    metronomeCheckbox.disabled = !hasAudio
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
      await recordAndRefreshRecentFile(path, fileHash, title)
    }
  }

  await showPdfPage(tabState, 0)

  tabs.set(tabState.fileHash, tabState)
  await activateTab(tabState)

  // Auto-scan only an uncalibrated PDF (fresh open, zero existing points) —
  // never re-scan one the user has already calibrated/corrected, which
  // would silently fight their edits. Runs after activateTab so the page is
  // already visible and the user isn't staring at a blank/unresponsive UI
  // while it works; renders each page to its own offscreen canvas (not
  // tab.canvasContainer) so it doesn't interfere with the user navigating
  // pages while the scan is still running in the background.
  if (needsAutoScan) {
    void autoScanBarlines(tabState)
  }
}

async function autoScanBarlines(tab: PdfTabState): Promise<void> {
  const pageResults: { page: number; systems: StaffSystem[] }[] = []
  for (let pageNumber = 0; pageNumber < tab.pageCount; pageNumber++) {
    if (!tabs.has(tab.fileHash)) return // tab closed mid-scan
    if (activeHash === tab.fileHash) {
      calibrationStatusEl.textContent = `Scanning for barlines: page ${pageNumber + 1} / ${tab.pageCount}...`
    }
    try {
      const canvas = await renderPdfPage(tab.doc, pageNumber + 1, PDF_BASE_WIDTH * tab.zoom)
      const pngBytes = await canvasToPngBytes(canvas)
      const systems = await detectBarlines(pngBytes)
      pageResults.push({ page: pageNumber, systems })
    } catch (e) {
      console.error(`Failed to scan page ${pageNumber + 1} for barlines:`, e)
    }
  }

  if (!tabs.has(tab.fileHash)) return
  tab.calibrationOverlay.addPointsFromBarlinesAcrossPages(pageResults)
  if (activeHash === tab.fileHash) {
    const count = pageResults.reduce((n, r) => n + r.systems.reduce((m, s) => m + s.barline_xs.length, 0), 0)
    calibrationStatusEl.textContent = `Auto-detected ${count} calibration point(s) across ${tab.pageCount} page(s) — double-check them, the detector isn't always right.`
  }
}

async function showPdfPage(tab: PdfTabState, pageNumber: number): Promise<void> {
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

  if (activeHash === tab.fileHash) {
    pageIndicatorEl.textContent = `Page ${pageNumber + 1} / ${tab.pageCount}`
    prevBtn.disabled = pageNumber <= 0
    nextBtn.disabled = pageNumber >= tab.pageCount - 1
  }
}

async function playActive(): Promise<void> {
  const active = activeTab()
  if (!active || playBtn.disabled) return
  if (active.kind === 'pdf') {
    await loadPdfTabTempoMap(active)
    pdfCursor.setItems(active.calibrationOverlay.getPoints())
  }
  await playMidi(false)
  await setPlaybackSpeed(active.speed)
  await setLoopRegion(active.loopRegion)
  if (active.kind === 'mscz') msczCursor.start()
  else pdfCursor.start()
  playBtn.disabled = true
  stopBtn.disabled = false
}

async function stopActive(): Promise<void> {
  if (stopBtn.disabled) return
  await stopMidi()
  msczCursor.stop()
  pdfCursor.stop()
  const active = activeTab()
  if (active?.kind === 'pdf') active.calibrationOverlay.setPlayingIndex(null)
  playBtn.disabled = false
  stopBtn.disabled = true
}

playBtn.addEventListener('click', () => void playActive())
stopBtn.addEventListener('click', () => void stopActive())

/** Spacebar toggles play/pause for the active tab, like a standard media player — mirrored by the play/stop buttons' own disabled state so both stay in sync. */
window.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.code !== 'Space') return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'SELECT')) return
  e.preventDefault()
  if (stopBtn.disabled) void playActive()
  else void stopActive()
})

if (isTauri()) {
  // Desktop: use the native file dialog instead of the plain HTML file
  // input. `<input type="file">` never exposes the real filesystem path
  // (a deliberate browser security restriction), so files opened that way
  // couldn't be recorded in the recent-files list (no `path` to record) —
  // confirmed as the cause of PDFs (and .mscz files) never showing up there
  // when opened via this picker rather than drag-drop. The dialog plugin's
  // `open()` returns the real path, same as a dropped file's path.
  fileInput.style.display = 'none'
  const openFileBtn = document.querySelector<HTMLButtonElement>('#open-file-btn')!
  openFileBtn.style.display = 'inline-block'
  openFileBtn.addEventListener('click', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const path = await open({
      multiple: false,
      filters: [{ name: 'Scores', extensions: ['mscz', 'mscx', 'pdf'] }],
    })
    if (!path || Array.isArray(path)) return
    const bytes = await readFile(path)
    const filename = path.split(/[/\\]/).pop() ?? path
    await openBytes(bytes, filename, path)
  })
} else {
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    await openBytes(bytes, file.name, null)
  })
}

prevBtn.addEventListener('click', () => {
  const active = activeTab()
  if (!active) return
  if (active.kind === 'mscz') void active.pageView.prev()
  else void showPdfPage(active, active.currentPage - 1)
})
nextBtn.addEventListener('click', () => {
  const active = activeTab()
  if (!active) return
  if (active.kind === 'mscz') void active.pageView.next()
  else void showPdfPage(active, active.currentPage + 1)
})

function isOpenableFile(name: string): boolean {
  return /\.(mscz|mscx|pdf)$/i.test(name)
}

async function reopenRecentFile(path: string): Promise<void> {
  if (!isTauri()) return
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const bytes = await readFile(path)
  const filename = path.split(/[/\\]/).pop() ?? path
  await openBytes(bytes, filename, path)
}

if (isTauri()) {
  // Desktop: dropped paths come from the OS, read as bytes via tauri-plugin-fs.
  // (dynamic imports keep these Tauri-only packages out of the web/server bundle)
  Promise.all([
    import('@tauri-apps/api/webview'),
    import('@tauri-apps/plugin-fs'),
  ]).then(([{ getCurrentWebview }, { readFile }]) => {
    getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        dropOverlay.style.display = 'flex'
        return
      }
      dropOverlay.style.display = 'none'
      if (event.payload.type !== 'drop') return

      const path = event.payload.paths.find(isOpenableFile) ?? event.payload.paths[0]
      if (!path) return
      const bytes = await readFile(path)
      const filename = path.split(/[/\\]/).pop() ?? path
      await openBytes(bytes, filename, path)
    })
  })
} else {
  // Web/server: read dropped bytes client-side via the browser's DataTransfer API.
  window.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropOverlay.style.display = 'flex'
  })
  window.addEventListener('dragleave', (e) => {
    if (e.target === document.documentElement || e.relatedTarget === null) {
      dropOverlay.style.display = 'none'
    }
  })
  window.addEventListener('drop', async (e) => {
    e.preventDefault()
    dropOverlay.style.display = 'none'
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    await openBytes(bytes, file.name, null)
  })
}

// Manual test hooks retained for Playwright/manual verification during development.
;(window as unknown as { __musepracticeOpenBytes: typeof openBytes }).__musepracticeOpenBytes = (
  bytes: Uint8Array,
  filename: string,
) => openBytes(bytes, filename, null)
;(window as unknown as { __musepracticePageView: () => PageView | null }).__musepracticePageView = () => {
  const active = activeTab()
  return active?.kind === 'mscz' ? active.pageView : null
}
;(window as unknown as { __musepracticeGetTimeline: () => Timeline | null }).__musepracticeGetTimeline = () => {
  const active = activeTab()
  return active?.kind === 'mscz' ? active.timeline : null
}
