import { openScore, upgradeScore, getMeasurePositions, getMidi, type OpenScoreResult } from './score-engine'
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
} from './api-client'
import { MarkerPanel } from './views/MarkerPanel'
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
    <div id="marker-panel" style="max-width: 700px;"></div>
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

// Construction order matters: PageView must be created first so its SVG
// layer is the first child of #page, with SelectionOverlay's boxes/drag-rect
// layers appended after (and thus stacked visually on top).
const pageView = new PageView(pageContainerEl, (page, pages, positions) => {
  pageIndicatorEl.textContent = `Page ${page + 1} / ${pages}`
  prevBtn.disabled = page <= 0
  nextBtn.disabled = page >= pages - 1
  selectionStatusEl.textContent = ''
  if (positions) {
    selectionOverlay.setPage(positions.elements, page)
  }
})

const selectionOverlay = new SelectionOverlay(pageContainerEl)
let currentTimeline: Timeline | null = null
let currentSelection: MeasureRange | null = null
let currentSpeed = 1.0
let currentLoopRegion: [number, number] | null = null

selectionOverlay.onSelect((range) => {
  currentSelection = range
  selectionStatusEl.textContent = range
    ? `Selected measures (elid ${range.startElid}-${range.endElid}) — press L to loop`
    : ''
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
  if (!currentTimeline || !currentSelection) return null
  const event = currentTimeline.events.find((e) => e.source_elid === currentSelection!.startElid)
  return event?.measure_index ?? null
})

markerPanel.onJumpToMeasure((measureIndex) => {
  if (!currentTimeline) return
  const event = currentTimeline.events.find((e) => e.measure_index === measureIndex)
  if (!event) return
  if (event.page !== pageView.page) {
    void pageView.showPage(event.page)
  }
})

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
  currentLoopRegion = (currentTimeline && range && loopRegionForSelection(currentTimeline, range)) || null
  loopStatusEl.textContent = currentLoopRegion
    ? `Looping measures (elid ${range!.startElid}-${range!.endElid})`
    : ''
  await setLoopRegion(currentLoopRegion)
}

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'l' || !isTauri() || !currentTimeline) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  void setLoop(currentSelection)
})

function setSpeed(speed: number): void {
  currentSpeed = speed
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
pageContainerEl.appendChild(cursorBoxEl)

const cursor = new Cursor((event) => {
  if (event.page !== pageView.page) {
    pageView.showPage(event.page)
  }
  cursorBoxEl.style.display = 'block'
  cursorBoxEl.style.left = `${(event.bbox.x / currentPageWidth()) * 100}%`
  cursorBoxEl.style.top = `${(event.bbox.y / currentPageHeight()) * 100}%`
  cursorBoxEl.style.width = `${(event.bbox.sx / currentPageWidth()) * 100}%`
  cursorBoxEl.style.height = `${(event.bbox.sy / currentPageHeight()) * 100}%`
})

function currentPageWidth(): number {
  const svg = pageContainerEl.querySelector('svg')
  return svg ? parseFloat(svg.getAttribute('viewBox')?.split(' ')[2] ?? '0') : 1
}

function currentPageHeight(): number {
  const svg = pageContainerEl.querySelector('svg')
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

async function openBytes(bytes: Uint8Array, filename: string) {
  statusEl.textContent = `Loading ${filename}...`
  navEl.style.display = 'none'

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

  statusEl.textContent = `${metadata.title || filename} — ${metadata.pages} page(s), format version ${metadata.fileVersion}`

  await pageView.setScore(score, metadata.pages)
  navEl.style.display = metadata.pages > 1 ? 'block' : 'none'
  await pageView.showPage(0)

  currentTimeline = null
  currentSelection = null
  currentLoopRegion = null
  cursor.setTimeline(null)
  playBtn.disabled = true
  stopBtn.disabled = true
  for (const btn of Object.values(speedButtons)) btn.disabled = true
  metronomeCheckbox.disabled = true
  loopStatusEl.textContent = ''
  cursorBoxEl.style.display = 'none'
  await markerPanel.setFileHash(null)

  if (isTauri()) {
    // Hashed from `originalBytes` (captured before openScore() detaches the
    // original buffer), not any upgraded re-save of it — markers should stay
    // anchored to "this piece" across an MS4 upgrade round-trip, not fork
    // onto a new key. Failure here must not abort the rest of this block —
    // markers are optional, playback setup isn't.
    try {
      await markerPanel.setFileHash(await contentHash(originalBytes, filename))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('Failed to compute file hash for markers:', e)
      statusEl.textContent += ` (markers unavailable: ${message})`
      await markerPanel.setFileHash(null)
    }

    const positions = await getMeasurePositions(score)
    const midiBytes = await getMidi(score)
    const { timeline } = await importTimeline(positions, midiBytes)
    currentTimeline = timeline
    cursor.setTimeline(timeline)
    await loadMidi(midiBytes)
    await setLoopRegion(null)
    await setMetronomeEnabled(metronomeCheckbox.checked)
    playBtn.disabled = false
    for (const btn of Object.values(speedButtons)) btn.disabled = false
    metronomeCheckbox.disabled = false
  }
}

playBtn.addEventListener('click', async () => {
  await playMidi(false)
  await setPlaybackSpeed(currentSpeed)
  await setLoopRegion(currentLoopRegion)
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
  await openBytes(bytes, file.name)
})

prevBtn.addEventListener('click', () => pageView.prev())
nextBtn.addEventListener('click', () => pageView.next())

function isMsczFile(name: string): boolean {
  return /\.(mscz|mscx)$/i.test(name)
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
      await openBytes(bytes, filename)
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
    await openBytes(bytes, file.name)
  })
}

// Manual test hooks retained for Playwright/manual verification during development.
;(window as unknown as { __musepracticeOpenBytes: typeof openBytes }).__musepracticeOpenBytes = openBytes
;(window as unknown as { __musepracticePageView: typeof pageView }).__musepracticePageView = pageView
;(window as unknown as { __musepracticeGetTimeline: () => Timeline | null }).__musepracticeGetTimeline = () =>
  currentTimeline
