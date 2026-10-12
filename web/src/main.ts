import { openScore, renderPage, upgradeScore, type OpenScoreResult } from './score-engine'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <div style="padding: 16px; font-family: sans-serif;">
    <input id="file-input" type="file" accept=".mscz,.mscx" />
    <div id="status" style="margin-top: 8px; color: #555;"></div>
    <div id="page" style="margin-top: 16px;"></div>
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
const pageEl = document.querySelector<HTMLDivElement>('#page')!
const upgradeModal = document.querySelector<HTMLDivElement>('#upgrade-modal')!
const upgradeConfirmBtn = document.querySelector<HTMLButtonElement>('#upgrade-confirm')!
const upgradeCancelBtn = document.querySelector<HTMLButtonElement>('#upgrade-cancel')!

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

async function handleFile(file: File) {
  statusEl.textContent = `Loading ${file.name}...`
  const bytes = new Uint8Array(await file.arrayBuffer())

  let result: OpenScoreResult
  try {
    result = await openScore(bytes)
  } catch (e) {
    statusEl.textContent = `Failed to open ${file.name}: ${e instanceof Error ? e.message : String(e)}`
    return
  }

  let { score } = result
  const { needsUpgrade, metadata } = result

  if (needsUpgrade) {
    const confirmed = await askUpgradeConfirmation()
    if (!confirmed) {
      statusEl.textContent = `Cancelled: ${file.name} was not opened (needs upgrade to MuseScore 4 format).`
      score.destroy()
      return
    }
    const upgradedBytes = await upgradeScore(score)
    score.destroy()
    result = await openScore(upgradedBytes)
    score = result.score
  }

  statusEl.textContent = `${metadata.title || file.name} — ${metadata.pages} page(s), format version ${metadata.fileVersion}`

  const svg = await renderPage(score, 0)
  pageEl.innerHTML = svg
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) handleFile(file)
})

// Manual test hooks retained for Playwright/manual verification during development.
;(window as unknown as { __musepracticeOpenScore: typeof openScore }).__musepracticeOpenScore = openScore
;(window as unknown as { __musepracticeRenderPage: typeof renderPage }).__musepracticeRenderPage = renderPage
