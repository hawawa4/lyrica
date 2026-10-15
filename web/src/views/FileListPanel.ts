import { isTauri } from '../api-client'
import type { KnowledgeLevel } from '../types'
import { CollapsibleSection } from './CollapsibleSection'
import { RatingStars } from './RatingStars'

/**
 * Minimal shape every list entry needs — satisfied by `RecentFile` and
 * `PinnedFile` alike. `file_hash` is optional rather than required because
 * library-scan results have no stable identity until they're actually opened
 * (hashing is deferred to open time — scanning every file's full bytes up
 * front would turn a cheap filename listing into an O(total library bytes)
 * operation); pinning is only meaningful once `file_hash` is present, which
 * `FileListPanel` uses directly to decide whether to offer it.
 */
export interface FileListEntry {
  path: string
  file_hash?: string
  title: string
}

/**
 * A titled, clickable list of files (recent files or pinned files) with an
 * always-visible pin/unpin star per row and a desktop-only right-click menu
 * for "Open in file manager". Shared by `LibraryView`'s pinned/recent
 * sections so this behaves identically in both places rather than
 * duplicating the DOM/list logic twice over.
 */
export class FileListPanel<T extends FileListEntry> {
  private readonly section: CollapsibleSection
  private readonly listEl: HTMLUListElement
  private readonly contextMenuEl: HTMLDivElement
  private onOpenCallback: ((entry: T) => void) | null = null
  private onTogglePinCallback: ((entry: T, pin: boolean) => void) | null = null
  private onRatingChangeCallback: ((entry: T, level: KnowledgeLevel | null) => void) | null = null
  private isPinnedFn: (entry: T) => boolean = () => false
  private ratingFn: (entry: T) => KnowledgeLevel | null = () => null

  constructor(container: HTMLElement, title: string) {
    this.section = new CollapsibleSection(container, title)
    this.section.setVisible(false)
    this.listEl = document.createElement('ul')
    this.listEl.className = 'panel-list'
    this.section.bodyEl.appendChild(this.listEl)

    this.contextMenuEl = document.createElement('div')
    this.contextMenuEl.className = 'context-menu'
    this.contextMenuEl.style.display = 'none'
    document.body.appendChild(this.contextMenuEl)
    window.addEventListener('click', () => this.hideContextMenu())
    window.addEventListener('blur', () => this.hideContextMenu())
  }

  onOpen(callback: (entry: T) => void): void {
    this.onOpenCallback = callback
  }

  /** `pin` is the action to perform: true = pin this entry, false = unpin it. */
  onTogglePin(callback: (entry: T, pin: boolean) => void): void {
    this.onTogglePinCallback = callback
  }

  /** Lets the caller mark entries that are currently pinned, so the context menu offers "Unpin" instead of "Pin". */
  setIsPinned(fn: (entry: T) => boolean): void {
    this.isPinnedFn = fn
  }

  /** `level` fires whenever the user changes a row's rating via its `RatingStars` control. */
  onRatingChange(callback: (entry: T, level: KnowledgeLevel | null) => void): void {
    this.onRatingChangeCallback = callback
  }

  /** Lets the caller supply each entry's current rating, so rows render the right stars filled in. */
  setRating(fn: (entry: T) => KnowledgeLevel | null): void {
    this.ratingFn = fn
  }

  render(entries: T[]): void {
    this.listEl.innerHTML = ''
    this.section.setVisible(entries.length > 0)
    for (const entry of entries) {
      const li = document.createElement('li')
      li.className = 'panel-list-item'

      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = entry.title || entry.path
      li.appendChild(label)

      // Rating/pin both need a stable file_hash, absent for an unopened
      // library-scan result (see FileListEntry's docs) — both controls are
      // simply omitted for those rows rather than shown disabled.
      if (entry.file_hash) {
        const stars = new RatingStars()
        stars.setLevel(this.ratingFn(entry))
        stars.onChange((level) => this.onRatingChangeCallback?.(entry, level))
        li.appendChild(stars.el)

        const pinned = this.isPinnedFn(entry)
        const pinBtn = document.createElement('button')
        pinBtn.className = 'pin-btn'
        pinBtn.classList.toggle('pinned', pinned)
        pinBtn.title = pinned ? 'Unpin' : 'Pin to top'
        pinBtn.innerHTML = '&#128204;' // pushpin — distinct from the rating stars sitting right next to it
        pinBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          this.onTogglePinCallback?.(entry, !pinned)
        })
        li.appendChild(pinBtn)
      }

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

  private showContextMenu(x: number, y: number, entry: T): void {
    this.contextMenuEl.innerHTML = ''

    const revealItem = document.createElement('button')
    revealItem.className = 'context-menu-item'
    revealItem.textContent = 'Open in file manager'
    revealItem.addEventListener('click', () => {
      this.hideContextMenu()
      void this.revealInFileManager(entry.path)
    })
    this.contextMenuEl.appendChild(revealItem)

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
