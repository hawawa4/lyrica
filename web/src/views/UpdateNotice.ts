import { checkForUpdate, installUpdate, isTauri, restartApp } from '../api-client'
import type { UpdateInfo, UpdateProgress } from '../types'

type State = 'hidden' | 'available' | 'installing' | 'installed' | 'error'

/**
 * A small, non-modal "new version available" chip pinned to the library
 * view's bottom-right corner. No dialogs and no toasts: it only appears once
 * a check finds a newer GitHub release, can be dismissed for the session, and
 * the update itself only starts when its button is clicked. Checking is
 * silent — offline or rate-limited just means no chip.
 *
 * Install is whatever the Rust side decides fits this copy (replace the
 * AppImage, or apt via the system password prompt for a `.deb`); when the app
 * can't update itself (`can_install` false) the button opens the release page.
 */
export class UpdateNotice {
  private readonly root: HTMLDivElement
  private readonly textEl: HTMLSpanElement
  private readonly notesBtn: HTMLButtonElement
  private readonly actionBtn: HTMLButtonElement
  private readonly dismissBtn: HTMLButtonElement
  private readonly bar: HTMLDivElement
  private readonly barFill: HTMLDivElement
  private state: State = 'hidden'
  private info: UpdateInfo | null = null
  private progress: UpdateProgress | null = null
  private errorMessage = ''
  private checked = false

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'update-notice'
    this.root.setAttribute('role', 'status')
    this.root.setAttribute('aria-live', 'polite')
    this.root.hidden = true
    this.root.innerHTML = `
      <div class="update-notice-row">
        <span class="update-notice-text"></span>
        <button class="update-notice-link" type="button">What&rsquo;s new</button>
        <button class="primary update-notice-action" type="button"></button>
        <button class="update-notice-dismiss" type="button" aria-label="Dismiss" title="Dismiss until next launch">&times;</button>
      </div>
      <div class="update-notice-bar"><div class="update-notice-bar-fill"></div></div>
    `
    container.appendChild(this.root)

    this.textEl = this.root.querySelector('.update-notice-text')!
    this.notesBtn = this.root.querySelector('.update-notice-link')!
    this.actionBtn = this.root.querySelector('.update-notice-action')!
    this.dismissBtn = this.root.querySelector('.update-notice-dismiss')!
    this.bar = this.root.querySelector('.update-notice-bar')!
    this.barFill = this.root.querySelector('.update-notice-bar-fill')!

    this.notesBtn.addEventListener('click', () => void this.openReleasePage())
    this.actionBtn.addEventListener('click', () => void this.onAction())
    this.dismissBtn.addEventListener('click', () => this.setState('hidden'))
  }

  /** Looks for a newer release, once per launch. Failures are logged, never shown — an update check isn't worth interrupting anyone over. */
  async checkOnce(): Promise<void> {
    if (this.checked || !isTauri()) return
    this.checked = true
    try {
      const info = await checkForUpdate()
      if (!info.available) return
      this.info = info
      this.setState('available')
    } catch (e) {
      console.warn('Update check failed:', e)
    }
  }

  private async onAction(): Promise<void> {
    if (!this.info) return
    switch (this.state) {
      case 'available':
      case 'error':
        if (this.info.can_install) await this.install()
        else await this.openReleasePage()
        return
      case 'installed':
        try {
          await restartApp()
        } catch (e) {
          this.fail(e)
        }
        return
      default:
        return
    }
  }

  private async install(): Promise<void> {
    this.progress = null
    this.setState('installing')
    try {
      await installUpdate((p) => {
        this.progress = p
        this.render()
      })
      this.setState('installed')
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown): void {
    console.error('Update failed:', e)
    this.errorMessage = String(e)
    this.setState('error')
  }

  private async openReleasePage(): Promise<void> {
    if (!this.info) return
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(this.info.page_url)
    } catch (e) {
      console.error('Failed to open the release page:', e)
    }
  }

  private setState(state: State): void {
    this.state = state
    this.render()
  }

  private render(): void {
    const info = this.info
    this.root.hidden = this.state === 'hidden' || !info
    if (!info) return
    this.root.dataset.state = this.state

    const busy = this.state === 'installing'
    this.notesBtn.hidden = this.state !== 'available'
    this.dismissBtn.hidden = busy
    this.actionBtn.hidden = busy
    this.bar.hidden = !busy
    this.actionBtn.title = ''

    switch (this.state) {
      case 'available':
        this.textEl.textContent = `Lyrica ${info.latest} is available`
        this.actionBtn.textContent = info.can_install ? 'Update' : 'Get it'
        if (!info.can_install && info.reason) this.actionBtn.title = `${info.reason} Opens the release page.`
        else if (info.kind === 'deb') this.actionBtn.title = 'Your system will ask for your password to install the update.'
        break
      case 'installing':
        this.textEl.textContent = this.progressText(info)
        this.renderBar()
        break
      case 'installed':
        this.textEl.textContent = `Lyrica ${info.latest} is installed`
        this.actionBtn.textContent = 'Restart'
        break
      case 'error':
        this.textEl.textContent = `Update failed: ${this.errorMessage}`
        this.actionBtn.textContent = info.can_install ? 'Retry' : 'Get it'
        break
    }
  }

  private progressText(info: UpdateInfo): string {
    const p = this.progress
    if (p?.phase === 'installing') return info.kind === 'deb' ? 'Waiting for the package installer…' : 'Installing…'
    if (p?.phase === 'downloading') {
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1)
      return p.total > 0 ? `Downloading… ${mb(p.done)} / ${mb(p.total)} MB` : `Downloading… ${mb(p.done)} MB`
    }
    return 'Starting…'
  }

  private renderBar(): void {
    const p = this.progress
    const known = p?.phase === 'downloading' && p.total > 0
    this.bar.classList.toggle('indeterminate', !known)
    this.barFill.style.width = known ? `${Math.min(100, (p.done / p.total) * 100)}%` : ''
  }
}
