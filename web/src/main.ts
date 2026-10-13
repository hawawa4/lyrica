import { openScore, upgradeScore, getMeasurePositions, getMidi, type OpenScoreResult, type WebMscore } from './score-engine'
import { PageView } from './render/PageView'
import { SelectionOverlay, type MeasureRange } from './render/SelectionOverlay'
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
} from './api-client'
import { MarkerPanel } from './views/MarkerPanel'
import { PiecesIndex } from './views/PiecesIndex'
import { TabBar, type TabInfo } from './views/TabBar'
import { RecentFilesList } from './views/RecentFilesList'
import type { Timeline } from './types'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <style>
    .speed-btn.active { background: #0078ff; color: white; }
  </style>
  <div style="padding: 16px; font-family: sans-serif;">
    <input id="file-input" type="file" accept=".mscz,.mscx" />
    <span style="color:#888; margin-left: 8px;">or drag a .mscz file anywhere onto the window</span>
    <div id="status" style="margin-top: 8px; color: #555;"></div>
    <div id="nav" style="margin-top: 8px; display:none;">
      <button id="prev-page">&larr; Prev</button>
      <span id="page-indicator" style="margin: 0 8px;"></span>
      <button id="next-page">Next &rarr;</button>
      <button id="play-btn" style="margin-left: 16px;" disabled>&#9654; Play</button>
      <button id="stop-btn" disabled>&#9632; Stop</button>
      <span style="margin-left: 16px;">
        <button id="speed-05" class="speed-btn" disabled>0.5x</button>
        <button id="speed-075" class="speed-btn" disabled>0.75x</button>
        <button id="speed-10" class="speed-btn" disabled>1.0x</button>
      </span>
      <label style="margin-left: 16px;"><input id="metronome-checkbox" type="checkbox" disabled /> Metronome</label>
    </div>
    <div id="loop-status" style="margin-top: 4px; color: #0a0; font-size: 13px;"></div>
    <div id="page" style="margin-top: 16px; max-width: 700px; position: relative;"></div>
    <div id="selection-status" style="margin-top: 4px; color: #888; font-size: 13px;"></div>
    <div id="pieces-index" style="max-width: 700px;"></div>
    <div id="marker-panel" style="max-width: 700px;"></div>
    <div id="recent-files" style="max-width: 700px;"></div>
    <div id="tab-bar" style="max-width: 700px;"></div>
  </div>
  <div id="drop-overlay" style="display:none; position:fixed; inset:0; background:rgba(0,120,255,0.15); border: 4px dashed rgba(0,120,255,0.6); pointer-events:none; align-items:center; justify-content:center; font-family: sans-serif; font-size: 20px; color: #0078ff;">
    Drop to open
  </div>
  <div id="upgrade-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); align-items:center; justify-content:center;">
    <div style="background:white; padding:24px; max-width:420px; border-radius:8px;">
      <p>This file was made in an older MuseScore version and will be upgraded to MuseScore 4 format for this app. Continue?</p>
      <button id="upgrade-confirm">Continue</button>
      <button id="upgrade-cancel">Cancel</button>
    </div>
  </div>
`

const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const statusEl = document.querySelector<HTMLDivElement>('#status')!
const navEl = document.querySelector<HTMLDivElement>('#nav')!
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
const selectionStatusEl = document.querySelector<HTMLDivElement>('#selection-status')!
const loopStatusEl = document.querySelector<HTMLDivElement>('#loop-status')!
const dropOverlay = document.querySelector<HTMLDivElement>('#drop-overlay')!
const upgradeModal = document.querySelector<HTMLDivElement>('#upgrade-modal')!
const upgradeConfirmBtn = document.querySelector<HTMLButtonElement>('#upgrade-confirm')!
const upgradeCancelBtn = document.querySelector<HTMLButtonElement>('#upgrade-cancel')!

/**
 * Everything that used to be a single set of global variables/objects,
 * bundled per open file (keyed by file hash) so switching tabs swaps state
 * wholesale instead of mutating shared globals. `pageView`/`selectionOverlay`
 * each own DOM-cached state (rendered SVG pages, measure selection boxes)
 * tied to a specific container element — one dedicated, hidden/shown
 * `pageContainerEl` per tab, rather than one shared instance repointed at a
 * new score, so switching back to an already-open tab never re-fetches
 * already-rendered pages (the "no re-fetch lag" requirement).
 */
interface TabState {
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

const tabs = new Map<string, TabState>()
let activeHash: string | null = null

const tabBarEl = document.querySelector<HTMLDivElement>('#tab-bar')!
const tabBar = new TabBar(tabBarEl)
tabBar.onSwitch((hash) => void switchToTab(hash))
tabBar.onClose((hash) => closeTab(hash))

const recentFilesEl = document.querySelector<HTMLDivElement>('#recent-files')!
const recentFilesList = new RecentFilesList(recentFilesEl)
recentFilesList.onOpen((entry) => void reopenRecentFile(entry.path))
void recentFilesList.refresh()

const cursor = new Cursor((event) => {
  const active = activeTab()
  if (!active) return
  if (event.page !== active.pageView.page) {
    active.pageView.showPage(event.page)
  }
  cursorBoxEl.style.display = 'block'
  cursorBoxEl.style.left = `${(event.bbox.x / currentPageWidth()) * 100}%`
  cursorBoxEl.style.top = `${(event.bbox.y / currentPageHeight()) * 100}%`
  cursorBoxEl.style.width = `${(event.bbox.sx / currentPageWidth()) * 100}%`
  cursorBoxEl.style.height = `${(event.bbox.sy / currentPageHeight()) * 100}%`
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
  if (!active?.timeline || !active.selection) return null
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
  if (!active?.timeline) return
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
  if (!active?.timeline) return
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
  if (!active) return
  active.loopRegion = (active.timeline && range && loopRegionForSelection(active.timeline, range)) || null
  loopStatusEl.textContent = active.loopRegion
    ? `Looping measures (elid ${range!.startElid}-${range!.endElid})`
    : ''
  await setLoopRegion(active.loopRegion)
}

window.addEventListener('keydown', (e) => {
  const active = activeTab()
  if (e.key.toLowerCase() !== 'l' || !isTauri() || !active?.timeline) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  void setLoop(active.selection)
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
cursorBoxEl.style.border = '2px solid rgba(0, 180, 0, 0.9)'
cursorBoxEl.style.background = 'rgba(0, 180, 0, 0.12)'
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

function askUpgradeConfirmation(): Promise<boolean> {
  return new Promise((resolve) => {
    upgradeModal.style.display = 'flex'
    const onConfirm = () => {
      cleanup()
      resolve(true)
    }
    const onCancel = () => {
      cleanup()
      resolve(false)
    }
    function cleanup() {
      upgradeModal.style.display = 'none'
      upgradeConfirmBtn.removeEventListener('click', onConfirm)
      upgradeCancelBtn.removeEventListener('click', onCancel)
    }
    upgradeConfirmBtn.addEventListener('click', onConfirm)
    upgradeCancelBtn.addEventListener('click', onCancel)
  })
}

function renderTabBar(): void {
  const tabInfos: TabInfo[] = Array.from(tabs.values()).map((t) => ({ fileHash: t.fileHash, title: t.title }))
  tabBar.setTabs(tabInfos, activeHash)
}

/** Stops shared audio playback — the backend owns one synth/stream for the whole app, not one per tab. */
async function stopAudioForTabSwitch(): Promise<void> {
  await stopMidi()
  cursor.stop()
  playBtn.disabled = true
  stopBtn.disabled = true
}

/** Mounts `tab.pageContainer` as the visible page, restores its UI state (speed/loop/selection), and re-points the shared panels. */
async function activateTab(tab: TabState): Promise<void> {
  activeHash = tab.fileHash
  pageContainerEl.innerHTML = ''
  pageContainerEl.appendChild(tab.pageContainer)
  pageContainerEl.appendChild(cursorBoxEl)
  cursorBoxEl.style.display = 'none'

  navEl.style.display = tab.pageView.pages > 1 ? 'block' : 'none'
  pageIndicatorEl.textContent = `Page ${tab.pageView.page + 1} / ${tab.pageView.pages}`
  prevBtn.disabled = tab.pageView.page <= 0
  nextBtn.disabled = tab.pageView.page >= tab.pageView.pages - 1
  selectionStatusEl.textContent = tab.selection
    ? `Selected measures (elid ${tab.selection.startElid}-${tab.selection.endElid}) — press L to loop`
    : ''
  loopStatusEl.textContent = tab.loopRegion
    ? 'Looping selected measures'
    : ''

  statusEl.textContent = tab.title

  cursor.setTimeline(tab.timeline)
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

  renderTabBar()
}

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
  tab.selectionOverlay.destroy()
  tab.score.destroy()
  tabs.delete(fileHash)

  if (activeHash === fileHash) {
    activeHash = null
    const next = tabs.values().next().value as TabState | undefined
    if (next) {
      void stopAudioForTabSwitch().then(() => activateTab(next))
    } else {
      void stopAudioForTabSwitch()
      pageContainerEl.innerHTML = ''
      pageContainerEl.appendChild(cursorBoxEl)
      navEl.style.display = 'none'
      statusEl.textContent = ''
      selectionStatusEl.textContent = ''
      loopStatusEl.textContent = ''
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

async function openBytes(bytes: Uint8Array, filename: string, path: string | null): Promise<void> {
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

  if (needsUpgrade) {
    const confirmed = await askUpgradeConfirmation()
    if (!confirmed) {
      statusEl.textContent = `Cancelled: ${filename} was not opened (needs upgrade to MuseScore 4 format).`
      score.destroy()
      return
    }
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
  pageContainer.style.position = 'relative'

  const pageView = new PageView(pageContainer, (page, pages, positions) => {
    if (activeHash !== tabState.fileHash) return
    pageIndicatorEl.textContent = `Page ${page + 1} / ${pages}`
    prevBtn.disabled = page <= 0
    nextBtn.disabled = page >= pages - 1
    selectionStatusEl.textContent = ''
    if (positions) {
      selectionOverlay.setPage(positions.elements, page)
    }
  })
  const selectionOverlay = new SelectionOverlay(pageContainer)

  const tabState: TabState = {
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
      try {
        await recordRecentFile(path, fileHash, title)
      } catch (e) {
        console.error('Failed to record recent file:', e)
      }
    }
  }

  tabs.set(tabState.fileHash, tabState)
  await activateTab(tabState)
}

playBtn.addEventListener('click', async () => {
  const active = activeTab()
  if (!active) return
  await playMidi(false)
  await setPlaybackSpeed(active.speed)
  await setLoopRegion(active.loopRegion)
  cursor.start()
  playBtn.disabled = true
  stopBtn.disabled = false
})

stopBtn.addEventListener('click', async () => {
  await stopMidi()
  cursor.stop()
  playBtn.disabled = false
  stopBtn.disabled = true
})

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  const bytes = new Uint8Array(await file.arrayBuffer())
  await openBytes(bytes, file.name, null)
})

prevBtn.addEventListener('click', () => activeTab()?.pageView.prev())
nextBtn.addEventListener('click', () => activeTab()?.pageView.next())

function isMsczFile(name: string): boolean {
  return /\.(mscz|mscx)$/i.test(name)
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

      const path = event.payload.paths.find(isMsczFile) ?? event.payload.paths[0]
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
;(window as unknown as { __musepracticePageView: () => PageView | null }).__musepracticePageView = () =>
  activeTab()?.pageView ?? null
;(window as unknown as { __musepracticeGetTimeline: () => Timeline | null }).__musepracticeGetTimeline = () =>
  activeTab()?.timeline ?? null
