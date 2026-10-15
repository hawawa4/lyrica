import type { KnowledgeLevel, LibraryEntry } from '../types'
import { CollapsibleSection } from './CollapsibleSection'
import { RatingStars } from './RatingStars'

interface TreeNode {
  name: string
  /** Full relative path from the root, e.g. "Bach/Inventions/No1.mscz" — used as this node's identity (expand-state key, search match target). */
  relPath: string
  children: Map<string, TreeNode>
  /** Set only on leaf (file) nodes. */
  entry?: LibraryEntry
}

function buildTree(entries: LibraryEntry[], rootFolder: string): TreeNode {
  const root: TreeNode = { name: '', relPath: '', children: new Map() }
  const sep = rootFolder.includes('\\') && !rootFolder.includes('/') ? '\\' : '/'

  for (const entry of entries) {
    const rel = entry.path.startsWith(rootFolder)
      ? entry.path.slice(rootFolder.length).replace(/^[/\\]+/, '')
      : entry.path
    const parts = rel.split(/[/\\]+/).filter(Boolean)
    if (parts.length === 0) continue

    let node = root
    let pathSoFar = ''
    for (let i = 0; i < parts.length - 1; i++) {
      pathSoFar = pathSoFar ? `${pathSoFar}${sep}${parts[i]}` : parts[i]
      let child = node.children.get(parts[i])
      if (!child) {
        child = { name: parts[i], relPath: pathSoFar, children: new Map() }
        node.children.set(parts[i], child)
      }
      node = child
    }

    const fileName = parts[parts.length - 1]
    pathSoFar = pathSoFar ? `${pathSoFar}${sep}${fileName}` : fileName
    node.children.set(fileName, { name: entry.title, relPath: pathSoFar, children: new Map(), entry })
  }

  return root
}

/** True if `node` or anything beneath it matches `query` (case-insensitive substring on file/folder name). */
function matchesSearch(node: TreeNode, query: string): boolean {
  if (!query) return true
  if (node.name.toLowerCase().includes(query)) return true
  for (const child of node.children.values()) {
    if (matchesSearch(child, query)) return true
  }
  return false
}

/**
 * A collapsible folder-tree view of a scanned library root, built client-side
 * from `scan_library`'s flat file list (the Rust side stays a simple
 * recursive walk — grouping into a tree is cheap, pure DOM/data-shape work
 * better done here than by widening the Tauri command's response shape).
 *
 * Every file row has an always-visible pin toggle and a 1-5 knowledge-level
 * rating control. Both are keyed by content hash, which an unopened scan
 * result doesn't have yet (only computed once a file is opened) — so
 * clicking either on a never-opened file first reads and hashes it on demand
 * via `setRequestHash`'s callback, then pins/rates it.
 */
export class FolderTree {
  private readonly section: CollapsibleSection
  private readonly treeEl: HTMLDivElement
  private readonly emptyEl: HTMLDivElement
  private entries: LibraryEntry[] = []
  private rootFolder = ''
  private searchQuery = ''
  /** Empty set means "no level filter active" (show everything) — otherwise only files whose rating is in this set, or files with no rating at all if `null` is a member, are shown. */
  private levelFilter = new Set<KnowledgeLevel | null>()
  private readonly expanded = new Set<string>()
  private onOpenCallback: ((path: string) => void) | null = null
  private onTogglePinCallback: ((path: string, title: string, pin: boolean) => void) | null = null
  private onRatingChangeCallback: ((path: string, title: string, level: KnowledgeLevel | null) => void) | null = null
  private isPinnedFn: (path: string) => boolean = () => false
  private ratingFn: (path: string) => KnowledgeLevel | null = () => null
  /** Resolves a path to its content hash, computing it (reading + hashing the file) on first use if necessary — pinning/rating needs this, opening doesn't. */
  private requestHashFn: ((path: string) => Promise<string | null>) | null = null
  private pendingHashPaths = new Set<string>()

  constructor(container: HTMLElement) {
    this.section = new CollapsibleSection(container, 'Library')
    this.section.root.classList.add('folder-tree-section')
    this.section.bodyEl.innerHTML = `
      <div class="folder-tree"></div>
      <div class="folder-tree-empty" style="display:none;">No folder selected</div>
    `
    this.treeEl = this.section.bodyEl.querySelector('.folder-tree')!
    this.emptyEl = this.section.bodyEl.querySelector('.folder-tree-empty')!
  }

  onOpen(callback: (path: string) => void): void {
    this.onOpenCallback = callback
  }

  onTogglePin(callback: (path: string, title: string, pin: boolean) => void): void {
    this.onTogglePinCallback = callback
  }

  onRatingChange(callback: (path: string, title: string, level: KnowledgeLevel | null) => void): void {
    this.onRatingChangeCallback = callback
  }

  setIsPinned(fn: (path: string) => boolean): void {
    this.isPinnedFn = fn
  }

  setRating(fn: (path: string) => KnowledgeLevel | null): void {
    this.ratingFn = fn
  }

  setRequestHash(fn: (path: string) => Promise<string | null>): void {
    this.requestHashFn = fn
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query.trim().toLowerCase()
    this.render()
  }

  /** `levels` empty means "no filter" (show everything); otherwise only files whose rating (or `null` for unrated) is in the set are shown. Folders with no matching descendant are hidden too. */
  setLevelFilter(levels: Set<KnowledgeLevel | null>): void {
    this.levelFilter = levels
    this.render()
  }

  setData(entries: LibraryEntry[], rootFolder: string): void {
    this.entries = entries
    this.rootFolder = rootFolder
    this.render()
  }

  /** Re-renders without re-fetching — call after a pin or rating change elsewhere so each row's controls stay in sync. */
  refreshRowState(): void {
    this.render()
  }

  private render(): void {
    this.treeEl.innerHTML = ''
    if (!this.rootFolder) {
      this.emptyEl.style.display = 'block'
      this.emptyEl.textContent = 'No folder selected'
      this.treeEl.style.display = 'none'
      return
    }
    if (this.entries.length === 0) {
      this.emptyEl.style.display = 'block'
      this.emptyEl.textContent = 'No scores found in this folder'
      this.treeEl.style.display = 'none'
      return
    }

    const tree = buildTree(this.entries, this.rootFolder)
    this.emptyEl.style.display = 'none'
    this.treeEl.style.display = 'block'

    const autoExpand = this.searchQuery.length > 0 || this.levelFilter.size > 0
    this.renderChildren(tree, this.treeEl, 0, autoExpand)
  }

  /** True if `node` is a file matching the active level filter, or a folder containing at least one such file (recursively). Mirrors `matchesSearch`'s "any descendant matches" rule. */
  private matchesFilter(node: TreeNode): boolean {
    if (this.levelFilter.size === 0) return true
    if (node.entry) return this.levelFilter.has(this.ratingFn(node.entry.path))
    for (const child of node.children.values()) {
      if (this.matchesFilter(child)) return true
    }
    return false
  }

  private renderChildren(node: TreeNode, container: HTMLElement, depth: number, autoExpand: boolean): void {
    const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
      const aIsDir = a.children.size > 0 || !a.entry
      const bIsDir = b.children.size > 0 || !b.entry
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    })

    for (const child of sortedChildren) {
      if (!matchesSearch(child, this.searchQuery)) continue
      if (!this.matchesFilter(child)) continue

      if (child.entry) {
        container.appendChild(this.renderFileRow(child, depth))
      } else {
        container.appendChild(this.renderFolderRow(child, depth, autoExpand))
      }
    }
  }

  private renderFolderRow(node: TreeNode, depth: number, autoExpand: boolean): HTMLElement {
    const wrapper = document.createElement('div')
    const isOpen = autoExpand || this.expanded.has(node.relPath)

    const row = document.createElement('div')
    row.className = 'tree-row tree-folder-row'
    row.style.paddingLeft = `${depth * 16 + 7}px`
    row.innerHTML = `
      <span class="tree-disclosure">${isOpen ? '&#9660;' : '&#9654;'}</span>
      <span class="tree-folder-icon">&#128193;</span>
      <span class="label">${escapeHtml(node.name)}</span>
    `
    row.addEventListener('click', () => {
      if (this.expanded.has(node.relPath)) this.expanded.delete(node.relPath)
      else this.expanded.add(node.relPath)
      this.render()
    })
    wrapper.appendChild(row)

    if (isOpen) {
      const childrenEl = document.createElement('div')
      this.renderChildren(node, childrenEl, depth + 1, autoExpand)
      wrapper.appendChild(childrenEl)
    }

    return wrapper
  }

  private renderFileRow(node: TreeNode, depth: number): HTMLElement {
    const entry = node.entry!
    const row = document.createElement('div')
    row.className = 'tree-row tree-file-row'
    row.style.paddingLeft = `${depth * 16 + 7}px`

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = entry.title
    row.appendChild(label)

    const stars = new RatingStars()
    stars.setLevel(this.ratingFn(entry.path))
    stars.onChange((level) => void this.handleRatingChange(entry, level))
    row.appendChild(stars.el)

    const pinBtn = document.createElement('button')
    pinBtn.className = 'pin-btn'
    pinBtn.title = this.isPinnedFn(entry.path) ? 'Unpin' : 'Pin to top'
    pinBtn.innerHTML = '&#128204;' // pushpin — distinct from the rating stars sitting right next to it
    pinBtn.classList.toggle('pinned', this.isPinnedFn(entry.path))
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.handlePinClick(entry)
    })
    row.appendChild(pinBtn)

    row.addEventListener('click', () => this.onOpenCallback?.(entry.path))

    if (isTauriAvailable()) {
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        void this.revealInFileManager(entry.path)
      })
    }

    return row
  }

  private async handlePinClick(entry: LibraryEntry): Promise<void> {
    const alreadyPinned = this.isPinnedFn(entry.path)
    if (alreadyPinned) {
      this.onTogglePinCallback?.(entry.path, entry.title, false)
      return
    }
    const hash = await this.resolveHash(entry.path)
    if (hash) this.onTogglePinCallback?.(entry.path, entry.title, true)
  }

  /** Setting a rating on a never-opened file needs the same on-demand hashing pinning does — rating is keyed by content hash, same as pinning. */
  private async handleRatingChange(entry: LibraryEntry, level: KnowledgeLevel | null): Promise<void> {
    const hash = await this.resolveHash(entry.path)
    if (hash) this.onRatingChangeCallback?.(entry.path, entry.title, level)
  }

  /** Resolves `path`'s content hash via `requestHashFn`, de-duplicating concurrent calls for the same path (e.g. a fast double-click on the star/rating row before the first hash resolves). */
  private async resolveHash(path: string): Promise<string | null> {
    if (this.pendingHashPaths.has(path)) return null
    this.pendingHashPaths.add(path)
    try {
      return (await this.requestHashFn?.(path)) ?? null
    } finally {
      this.pendingHashPaths.delete(path)
    }
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

function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
