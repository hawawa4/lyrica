import { listRecentFiles, isTauri } from '../api-client'
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
  private readonly contextMenuEl: HTMLDivElement
  private onOpenCallback: ((entry: RecentFile) => void) | null = null

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'sidebar-section'
    this.root.style.display = 'none'
    this.root.innerHTML = `
      <span class="sidebar-section-title">Recent files</span>
      <ul class="panel-list"></ul>
    `
    container.appendChild(this.root)
    this.listEl = this.root.querySelector('ul')!

    this.contextMenuEl = document.createElement('div')
    this.contextMenuEl.className = 'context-menu'
    this.contextMenuEl.style.display = 'none'
    document.body.appendChild(this.contextMenuEl)
    window.addEventListener('click', () => this.hideContextMenu())
    window.addEventListener('blur', () => this.hideContextMenu())
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
      li.className = 'panel-list-item'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = entry.title || entry.path
      li.appendChild(label)
      li.addEventListener('click', () => this.onOpenCallback?.(entry))
      if (isTauri()) {
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          this.showContextMenu(e.clientX, e.clientY, entry)
        })
      }
      this.listEl.appendChild(li)
    }
  }

  private showContextMenu(x: number, y: number, entry: RecentFile): void {
    this.contextMenuEl.innerHTML = ''
    const item = document.createElement('button')
    item.className = 'context-menu-item'
    item.textContent = 'Open in file manager'
    item.addEventListener('click', () => {
      this.hideContextMenu()
      void this.revealInFileManager(entry.path)
    })
    this.contextMenuEl.appendChild(item)
    this.contextMenuEl.style.left = `${x}px`
    this.contextMenuEl.style.top = `${y}px`
    this.contextMenuEl.style.display = 'block'
  }

  private hideContextMenu(): void {
    this.contextMenuEl.style.display = 'none'
  }

  private async revealInFileManager(path: string): Promise<void> {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
      await revealItemInDir(path)
    } catch (e) {
      console.error('Failed to reveal file in file manager:', e)
    }
  }
}
