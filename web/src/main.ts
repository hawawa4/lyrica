import { openScore, upgradeScore, getMeasurePositions, getMidi, type OpenScoreResult } from './score-engine'
import { PageView } from './render/PageView'
import { SelectionOverlay } from './render/SelectionOverlay'
import { Cursor } from './render/Cursor'
import { isTauri, importTimeline, loadMidi, playMidi, stopMidi } from './api-client'
import type { Timeline } from './types'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
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
      <label style="margin-left: 8px;"><input id="loop-checkbox" type="checkbox" /> Loop</label>
    </div>
    <div id="page" style="margin-top: 16px; max-width: 700px; position: relative;"></div>
    <div id="selection-status" style="margin-top: 4px; color: #888; font-size: 13px;"></div>
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
const loopCheckbox = document.querySelector<HTMLInputElement>('#loop-checkbox')!
const pageContainerEl = document.querySelector<HTMLDivElement>('#page')!
const selectionStatusEl = document.querySelector<HTMLDivElement>('#selection-status')!
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

selectionOverlay.onSelect((range) => {
  selectionStatusEl.textContent = range
    ? `Selected measures (elid ${range.startElid}-${range.endElid})`
    : ''
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
  cursor.setTimeline(null)
  playBtn.disabled = true
  stopBtn.disabled = true
  cursorBoxEl.style.display = 'none'

  if (isTauri()) {
    const positions = await getMeasurePositions(score)
    const midiBytes = await getMidi(score)
    const { timeline } = await importTimeline(positions, midiBytes)
    currentTimeline = timeline
    cursor.setTimeline(timeline)
    await loadMidi(midiBytes)
    playBtn.disabled = false
  }
}

playBtn.addEventListener('click', async () => {
  await playMidi(loopCheckbox.checked)
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
