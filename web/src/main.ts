import { openScore, upgradeScore, type OpenScoreResult } from './score-engine'
import { PageView } from './render/PageView'
import { isTauri } from './api-client'

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
    </div>
    <div id="page" style="margin-top: 16px; max-width: 700px;"></div>
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
const pageContainerEl = document.querySelector<HTMLDivElement>('#page')!
const dropOverlay = document.querySelector<HTMLDivElement>('#drop-overlay')!
const upgradeModal = document.querySelector<HTMLDivElement>('#upgrade-modal')!
const upgradeConfirmBtn = document.querySelector<HTMLButtonElement>('#upgrade-confirm')!
const upgradeCancelBtn = document.querySelector<HTMLButtonElement>('#upgrade-cancel')!

const pageView = new PageView(pageContainerEl, (page, pages) => {
  pageIndicatorEl.textContent = `Page ${page + 1} / ${pages}`
  prevBtn.disabled = page <= 0
  nextBtn.disabled = page >= pages - 1
})

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

  pageView.setScore(score, metadata.pages)
  navEl.style.display = metadata.pages > 1 ? 'block' : 'none'
  await pageView.showPage(0)
}

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
