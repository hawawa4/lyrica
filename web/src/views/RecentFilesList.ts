import { listRecentFiles } from '../api-client'
import type { RecentFile } from '../types'

/**
 * Shown on the empty/no-tabs-open state so the user can reopen a past file
 * after restarting the app, without re-browsing for it. Desktop-only (see
 * `listRecentFiles`'s docs) — reopening reads the file fresh from its
 * recorded path via tauri-plugin-fs, the same as a drag-drop open.
 */
export class RecentFilesList {
  private readonly root: HTMLDivElement
  private readonly listEl: HTMLUListElement
  private onOpenCallback: ((entry: RecentFile) => void) | null = null

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.style.display = 'none'
    this.root.innerHTML = `
      <div style="margin-top: 16px;">
        <strong>Recent files</strong>
        <ul style="list-style: none; padding: 0; margin-top: 8px;"></ul>
      </div>
    `
    container.appendChild(this.root)
    this.listEl = this.root.querySelector('ul')!
  }

  onOpen(callback: (entry: RecentFile) => void): void {
    this.onOpenCallback = callback
  }

  async refresh(): Promise<void> {
    let entries: RecentFile[]
    try {
      entries = await listRecentFiles()
    } catch (e) {
      console.error('Failed to load recent files:', e)
      entries = []
    }
    this.render(entries)
  }

  private render(entries: RecentFile[]): void {
    this.listEl.innerHTML = ''
    this.root.style.display = entries.length > 0 ? 'block' : 'none'
    for (const entry of entries) {
      const li = document.createElement('li')
      li.style.cursor = 'pointer'
      li.style.padding = '2px 0'
      li.textContent = entry.title || entry.path
      li.addEventListener('click', () => this.onOpenCallback?.(entry))
      this.listEl.appendChild(li)
    }
  }
}
