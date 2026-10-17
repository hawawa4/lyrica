import {
  getKnowledgeLevels,
  getLibrarySettings,
  hashBytes,
  isTauri,
  listPinnedFiles,
  listRecentFiles,
  pinFile,
  scanLibrary,
  setKnowledgeLevel,
  setRootFolder,
  unpinFile,
} from '../api-client'
import type { KnowledgeLevel, PinnedFile, RecentFile } from '../types'
import { FileListPanel } from './FileListPanel'
import { FolderTree } from './FolderTree'
import { LevelFilterBar } from './LevelFilterBar'

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
  private readonly loadingEl: HTMLDivElement
  private readonly loadingTextEl: HTMLSpanElement
  private readonly pinnedPanel: FileListPanel<PinnedFile>
  private readonly recentPanel: FileListPanel<RecentFile>
  private readonly folderTree: FolderTree
  private readonly levelFilterBar: LevelFilterBar
  private onOpenCallback: ((path: string) => void) | null = null
  private pinnedFiles: PinnedFile[] = []
  private recentFiles: RecentFile[] = []
  private rootFolder: string | null = null
  /** The root folder the tree was last scanned for — `null` means "never scanned yet." Lets `refresh()` skip the (potentially expensive, uncached on the Rust side) recursive walk when nothing has changed since the last visit, rather than re-walking the whole folder on every navigation back to this view. */
  private scannedRootFolder: string | null = null
  /** Guards against two overlapping `refresh()` calls (e.g. one triggered by `onFileOpened` right before navigating back to `#/library`, racing with the route-change's own `refresh()`) clobbering each other's results — only the call that's still current when it resolves is allowed to render. */
  private refreshToken = 0
  /** Every content hash this view currently knows a rating for, by hash — bulk-loaded for pinned/recent (both already carry a hash) and filled in on demand for tree rows as they're rated/pinned (see `resolveHashForPath`). */
  private ratings = new Map<string, KnowledgeLevel>()
  /** `path -> file_hash`, built from pinned/recent entries and anything resolved on demand — lets the folder tree (which only has paths) look up a rating without re-hashing a file it's already seen. */
  private pathToHash = new Map<string, string>()

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'library-view'
    this.root.innerHTML = `
      <div class="library-header">
        <span class="app-title">MusePractice</span>
        <div class="library-folder-row">
          <button id="choose-folder-btn" class="primary">Choose folder&hellip;</button>
          <span class="library-folder-path" id="root-folder-label">Loading&hellip;</span>
        </div>
        <div class="library-search-row">
          <input id="library-search" type="search" placeholder="Search your library&hellip;" />
        </div>
      </div>
      <div class="library-lists">
        <div id="library-loading" class="library-loading" style="display:none;" role="status" aria-live="polite">
          <div class="spinner spinner-sm"></div>
          <span class="library-loading-text"></span>
        </div>
        <div id="level-filter-bar"></div>
        <div id="pinned-list"></div>
        <div id="recent-list"></div>
        <div id="tree-list"></div>
      </div>
    `
    container.appendChild(this.root)

    this.rootFolderLabel = this.root.querySelector('#root-folder-label')!
    this.chooseFolderBtn = this.root.querySelector('#choose-folder-btn')!
    this.searchInput = this.root.querySelector('#library-search')!
    this.loadingEl = this.root.querySelector('#library-loading')!
    this.loadingTextEl = this.root.querySelector('.library-loading-text')!

    this.pinnedPanel = new FileListPanel<PinnedFile>(this.root.querySelector('#pinned-list')!, 'Pinned')
    this.recentPanel = new FileListPanel<RecentFile>(this.root.querySelector('#recent-list')!, 'Recent files')
    this.folderTree = new FolderTree(this.root.querySelector('#tree-list')!)
    this.levelFilterBar = new LevelFilterBar(this.root.querySelector('#level-filter-bar')!)

    this.pinnedPanel.setIsPinned(() => true)
    this.recentPanel.setIsPinned((e) => this.isPinned(e.file_hash))
    this.folderTree.setIsPinned((path) => this.isPinnedByPath(path))

    this.pinnedPanel.setRating((e) => this.ratings.get(e.file_hash) ?? null)
    this.recentPanel.setRating((e) => this.ratings.get(e.file_hash) ?? null)
    this.folderTree.setRating((path) => this.ratingForPath(path))

    this.pinnedPanel.onOpen((entry) => this.onOpenCallback?.(entry.path))
    this.recentPanel.onOpen((entry) => this.onOpenCallback?.(entry.path))
    this.folderTree.onOpen((path) => this.onOpenCallback?.(path))

    this.pinnedPanel.onTogglePin((entry, pin) => void this.togglePin(entry.path, entry.title, entry.file_hash, pin))
    this.recentPanel.onTogglePin((entry, pin) => void this.togglePin(entry.path, entry.title, entry.file_hash, pin))
    this.folderTree.onTogglePin((path, title, pin) => void this.togglePinByPath(path, title, pin))
    this.folderTree.setRequestHash((path) => this.resolveHashForPath(path))

    this.pinnedPanel.onRatingChange((entry, level) => void this.setRating(entry.file_hash, level))
    this.recentPanel.onRatingChange((entry, level) => void this.setRating(entry.file_hash, level))
    this.folderTree.onRatingChange((path, _title, level) => void this.setRatingByPath(path, level))

    this.levelFilterBar.onChange((levels) => this.folderTree.setLevelFilter(levels))

    this.searchInput.addEventListener('input', () => {
      this.folderTree.setSearchQuery(this.searchInput.value)
    })

    if (isTauri()) {
      // Up from the very first frame: the remembered folder isn't known until
      // settings load, and scanning it can take a while after that.
      this.setLoading('Loading your library…')
      this.chooseFolderBtn.addEventListener('click', () => void this.chooseFolder())
    } else {
      this.rootFolderLabel.textContent = 'No folder selected'
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

  private ratingForPath(path: string): KnowledgeLevel | null {
    const hash = this.pathToHash.get(path)
    return hash ? this.ratings.get(hash) ?? null : null
  }

  /**
   * Resolves `path`'s content hash: an already-known one from `pathToHash`
   * (built from pinned/recent entries, or a prior call to this same method)
   * if available, otherwise reads and hashes the file on demand — used when
   * the folder tree's pin star or rating stars are clicked on a file that's
   * never been opened. Caches the result so a second pin/rate on the same
   * tree row doesn't re-read the file from disk.
   */
  private async resolveHashForPath(path: string): Promise<string | null> {
    const known = this.pathToHash.get(path)
    if (known) return known
    if (!isTauri()) return null
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(path)
      const hash = await hashBytes(bytes)
      this.pathToHash.set(path, hash)
      return hash
    } catch (e) {
      console.error(`Failed to hash ${path}:`, e)
      return null
    }
  }

  private async togglePinByPath(path: string, title: string, pin: boolean): Promise<void> {
    const fileHash = pin ? await this.resolveHashForPath(path) : this.pathToHash.get(path)
    if (!fileHash) return
    await this.togglePin(path, title, fileHash, pin)
  }

  private async setRatingByPath(path: string, level: KnowledgeLevel | null): Promise<void> {
    const fileHash = await this.resolveHashForPath(path)
    if (!fileHash) return
    await this.setRating(fileHash, level)
  }

  private async setRating(fileHash: string | undefined, level: KnowledgeLevel | null): Promise<void> {
    if (!fileHash) return
    try {
      const applied = await setKnowledgeLevel(fileHash, level)
      if (applied === null) this.ratings.delete(fileHash)
      else this.ratings.set(fileHash, applied)
    } catch (e) {
      console.error('Failed to set knowledge level:', e)
      return
    }
    this.renderPinned()
    this.recentPanel.render(this.recentFiles)
    this.folderTree.refreshRowState()
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
    this.pathToHash.set(path, fileHash)
    this.renderPinned()
    // Re-render the already-held recent-files list and the tree client-side
    // (no refetch) so their pin stars immediately reflect the new state.
    this.recentPanel.render(this.recentFiles)
    this.folderTree.refreshRowState()
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
    for (const f of this.recentFiles) this.pathToHash.set(f.path, f.file_hash)
    await this.refreshRatingsFor(this.recentFiles.map((f) => f.file_hash))
    this.recentPanel.render(this.recentFiles)
  }

  /** Bulk-loads ratings for `fileHashes` into `this.ratings` — one IPC round-trip for every pinned/recent row rather than one per row (see `getKnowledgeLevels`'s docs). */
  private async refreshRatingsFor(fileHashes: string[]): Promise<void> {
    if (!isTauri() || fileHashes.length === 0) return
    try {
      const levels = await getKnowledgeLevels(fileHashes)
      for (const [hash, level] of Object.entries(levels)) this.ratings.set(hash, level)
    } catch (e) {
      console.error('Failed to load knowledge levels:', e)
    }
  }

  /** Re-walks `this.rootFolder` and updates the folder tree, unless `force` is false and the folder hasn't changed since the last scan. */
  private async refreshScan(force: boolean): Promise<void> {
    if (!isTauri() || !this.rootFolder) {
      this.scannedRootFolder = null
      this.folderTree.setData([], '')
      this.setLoading(null)
      return
    }
    if (!force && this.scannedRootFolder === this.rootFolder) {
      this.setLoading(null)
      return
    }
    // A big folder takes a while to walk — say so, naming the remembered
    // folder, so on launch it's clear the app already knows where the
    // library is and nothing needs choosing again.
    const scanning = this.rootFolder
    this.setLoading(`Loading your library from ${scanning}…`)
    try {
      const entries = await scanLibrary(scanning)
      if (scanning !== this.rootFolder) return // folder changed mid-scan; that scan owns the UI now
      this.scannedRootFolder = scanning
      this.folderTree.setData(entries, scanning)
    } catch (e) {
      console.error('Failed to scan library folder:', e)
      if (scanning !== this.rootFolder) return
      this.scannedRootFolder = null
      this.folderTree.setData([], scanning)
    }
    this.setLoading(null)
  }

  /** Shows the spinner banner with `message`, or hides it for `null`. */
  private setLoading(message: string | null): void {
    this.loadingEl.style.display = message ? 'flex' : 'none'
    this.loadingTextEl.textContent = message ?? ''
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
    for (const f of this.pinnedFiles) this.pathToHash.set(f.path, f.file_hash)
    await this.refreshRatingsFor(this.pinnedFiles.map((f) => f.file_hash))
    if (isStale()) return
    this.renderPinned()
    this.applyRootFolder(settings?.root_folder ?? null)

    await Promise.all([this.refreshRecent(), this.refreshScan(false)])
  }
}
