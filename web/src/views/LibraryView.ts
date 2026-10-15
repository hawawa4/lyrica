import {
  getLibrarySettings,
  hashBytes,
  isTauri,
  listPinnedFiles,
  listRecentFiles,
  pinFile,
  scanLibrary,
  setRootFolder,
  unpinFile,
} from '../api-client'
import type { PinnedFile, RecentFile } from '../types'
import { FileListPanel } from './FileListPanel'
import { FolderTree } from './FolderTree'

/**
 * Landing screen: pick a root folder to browse for scores, see what's
 * pinned (always shown, independent of recency — like pinned browser tabs),
 * recent files, and a collapsible folder-tree view of the root folder's
 * contents with a search box to filter it. Desktop-only, like the
 * recent-files/markers/etc. APIs it calls. Opening any entry hands its path
 * up via `onOpen` — `main.ts` reads the bytes and switches to the practice
 * view, exactly like today's dialog/drag-drop open flow.
 */
export class LibraryView {
  readonly root: HTMLDivElement
  private readonly rootFolderLabel: HTMLSpanElement
  private readonly chooseFolderBtn: HTMLButtonElement
  private readonly searchInput: HTMLInputElement
  private readonly pinnedPanel: FileListPanel<PinnedFile>
  private readonly recentPanel: FileListPanel<RecentFile>
  private readonly folderTree: FolderTree
  private onOpenCallback: ((path: string) => void) | null = null
  private pinnedFiles: PinnedFile[] = []
  private recentFiles: RecentFile[] = []
  private rootFolder: string | null = null
  /** The root folder the tree was last scanned for — `null` means "never scanned yet." Lets `refresh()` skip the (potentially expensive, uncached on the Rust side) recursive walk when nothing has changed since the last visit, rather than re-walking the whole folder on every navigation back to this view. */
  private scannedRootFolder: string | null = null
  /** Guards against two overlapping `refresh()` calls (e.g. one triggered by `onFileOpened` right before navigating back to `#/library`, racing with the route-change's own `refresh()`) clobbering each other's results — only the call that's still current when it resolves is allowed to render. */
  private refreshToken = 0

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'library-view'
    this.root.innerHTML = `
      <div class="library-header">
        <span class="app-title">MusePractice</span>
        <div class="library-folder-row">
          <button id="choose-folder-btn" class="primary">Choose folder&hellip;</button>
          <span class="library-folder-path" id="root-folder-label">No folder selected</span>
        </div>
        <div class="library-search-row">
          <input id="library-search" type="search" placeholder="Search your library&hellip;" />
        </div>
      </div>
      <div class="library-lists">
        <div id="pinned-list"></div>
        <div id="recent-list"></div>
        <div id="tree-list"></div>
      </div>
    `
    container.appendChild(this.root)

    this.rootFolderLabel = this.root.querySelector('#root-folder-label')!
    this.chooseFolderBtn = this.root.querySelector('#choose-folder-btn')!
    this.searchInput = this.root.querySelector('#library-search')!

    this.pinnedPanel = new FileListPanel<PinnedFile>(this.root.querySelector('#pinned-list')!, 'Pinned')
    this.recentPanel = new FileListPanel<RecentFile>(this.root.querySelector('#recent-list')!, 'Recent files')
    this.folderTree = new FolderTree(this.root.querySelector('#tree-list')!)

    this.pinnedPanel.setIsPinned(() => true)
    this.recentPanel.setIsPinned((e) => this.isPinned(e.file_hash))
    this.folderTree.setIsPinned((path) => this.isPinnedByPath(path))

    this.pinnedPanel.onOpen((entry) => this.onOpenCallback?.(entry.path))
    this.recentPanel.onOpen((entry) => this.onOpenCallback?.(entry.path))
    this.folderTree.onOpen((path) => this.onOpenCallback?.(path))

    this.pinnedPanel.onTogglePin((entry, pin) => void this.togglePin(entry.path, entry.title, entry.file_hash, pin))
    this.recentPanel.onTogglePin((entry, pin) => void this.togglePin(entry.path, entry.title, entry.file_hash, pin))
    this.folderTree.onTogglePin((path, title, pin) => void this.togglePinByPath(path, title, pin))
    this.folderTree.setRequestHash((path) => this.hashForPath(path))

    this.searchInput.addEventListener('input', () => {
      this.folderTree.setSearchQuery(this.searchInput.value)
    })

    if (isTauri()) {
      this.chooseFolderBtn.addEventListener('click', () => void this.chooseFolder())
    } else {
      this.chooseFolderBtn.disabled = true
      this.chooseFolderBtn.title = 'Library browsing is desktop-only for now'
    }
  }

  onOpen(callback: (path: string) => void): void {
    this.onOpenCallback = callback
  }

  /** Narrower than `refresh()` — call after a file finishes opening, so the recent-files list picks up the new entry without also paying for a full (uncached) library rescan that opening one file couldn't possibly have changed. */
  async refreshRecentOnly(): Promise<void> {
    await this.refreshRecent()
  }

  private isPinned(fileHash: string | undefined): boolean {
    return !!fileHash && this.pinnedFiles.some((p) => p.file_hash === fileHash)
  }

  private isPinnedByPath(path: string): boolean {
    return this.pinnedFiles.some((p) => p.path === path)
  }

  /** Reads and hashes the file at `path` on demand — used only when the folder tree's pin star is clicked on a file that's never been opened (and so has no known content hash yet). Not needed for recent/pinned rows, which already carry a hash. */
  private async hashForPath(path: string): Promise<string | null> {
    if (!isTauri()) return null
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(path)
      return await hashBytes(bytes)
    } catch (e) {
      console.error(`Failed to hash ${path} for pinning:`, e)
      return null
    }
  }

  private async togglePinByPath(path: string, title: string, pin: boolean): Promise<void> {
    const existing = this.pinnedFiles.find((p) => p.path === path)
    const fileHash = existing?.file_hash ?? (pin ? await this.hashForPath(path) : null)
    if (!fileHash) return
    await this.togglePin(path, title, fileHash, pin)
  }

  private async togglePin(path: string, title: string, fileHash: string | undefined, pin: boolean): Promise<void> {
    if (!fileHash) return // pinning needs a stable id; see FileListEntry's docs
    try {
      if (pin) {
        this.pinnedFiles = await pinFile(path, fileHash, title)
      } else {
        this.pinnedFiles = await unpinFile(fileHash)
      }
    } catch (e) {
      console.error('Failed to toggle pin:', e)
      return
    }
    this.renderPinned()
    // Re-render the already-held recent-files list and the tree client-side
    // (no refetch) so their pin stars immediately reflect the new state.
    this.recentPanel.render(this.recentFiles)
    this.folderTree.refreshPinState()
  }

  private renderPinned(): void {
    this.pinnedPanel.render(this.pinnedFiles)
  }

  private async refreshRecent(): Promise<void> {
    if (!isTauri()) return
    try {
      this.recentFiles = await listRecentFiles()
    } catch (e) {
      console.error('Failed to load recent files:', e)
      this.recentFiles = []
    }
    this.recentPanel.render(this.recentFiles)
  }

  /** Re-walks `this.rootFolder` and updates the folder tree, unless `force` is false and the folder hasn't changed since the last scan. */
  private async refreshScan(force: boolean): Promise<void> {
    if (!isTauri() || !this.rootFolder) {
      this.scannedRootFolder = null
      this.folderTree.setData([], '')
      return
    }
    if (!force && this.scannedRootFolder === this.rootFolder) {
      return
    }
    try {
      const entries = await scanLibrary(this.rootFolder)
      this.scannedRootFolder = this.rootFolder
      this.folderTree.setData(entries, this.rootFolder)
    } catch (e) {
      console.error('Failed to scan library folder:', e)
      this.scannedRootFolder = null
      this.folderTree.setData([], this.rootFolder)
    }
  }

  /** Applies a newly-loaded `LibrarySettings` to this view's state and label — shared by `chooseFolder` and `refresh` so the two don't duplicate the same assignment. */
  private applyRootFolder(rootFolder: string | null): void {
    this.rootFolder = rootFolder
    this.rootFolderLabel.textContent = rootFolder ?? 'No folder selected'
  }

  private async chooseFolder(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory: true, multiple: false })
    if (!selected || Array.isArray(selected)) return
    try {
      const settings = await setRootFolder(selected)
      this.applyRootFolder(settings.root_folder)
    } catch (e) {
      // Not persisted (e.g. a read-only app-data dir) — still reflect the
      // choice for this session rather than silently ignoring the click, but
      // surface it loudly since it'll otherwise revert without explanation
      // on next launch.
      console.error('Failed to save root folder — this choice will not survive an app restart:', e)
      this.applyRootFolder(selected)
    }
    await this.refreshScan(true)
  }

  /** Reloads everything — call whenever the library view becomes visible, so a file opened/pinned elsewhere shows up correctly. Rescans the root folder only if it's changed since the last scan (see `scannedRootFolder`), not on every call — scanning is an uncached recursive filesystem walk. */
  async refresh(): Promise<void> {
    if (!isTauri()) return
    const token = ++this.refreshToken
    const isStale = () => token !== this.refreshToken

    const [pinned, settings] = await Promise.all([
      listPinnedFiles().catch((e) => {
        console.error('Failed to load pinned files:', e)
        return [] as PinnedFile[]
      }),
      getLibrarySettings().catch((e) => {
        console.error('Failed to load library settings:', e)
        return null
      }),
    ])
    if (isStale()) return

    this.pinnedFiles = pinned
    this.renderPinned()
    this.applyRootFolder(settings?.root_folder ?? null)

    await Promise.all([this.refreshRecent(), this.refreshScan(false)])
  }
}
