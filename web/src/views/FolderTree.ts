import type { KnowledgeLevel, LibraryEntry } from '../types'
import { CollapsibleSection } from './CollapsibleSection'
import { RatingStars } from './RatingStars'
import { icon, fileTypeIcon } from '../icons'
import { folderParts, matchesSearch, matchesTags, searchTerms, tagsOf } from '../library-tags'

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
  private searchTerms: string[] = []
  /** Selected folder tags (OR); empty means no tag filter. */
  private tagFilter = new Set<string>()
  private onTagClickCallback: ((tag: string) => void) | null = null
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
    this.section = new CollapsibleSection(container, 'Library', 'folder')
    this.section.root.classList.add('folder-tree-section')
    this.section.bodyEl.innerHTML = `
      <div class="folder-tree-toolbar"></div>
      <div class="folder-tree"></div>
      <div class="folder-tree-empty" style="display:none;">No folder selected</div>
    `
    this.toolbarEl = this.section.bodyEl.querySelector('.folder-tree-toolbar')!
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

  /** Slot above the tree for controls that act on it (the level filter), so they sit inside the section they filter. */
  readonly toolbarEl: HTMLDivElement

  setSearchQuery(query: string): void {
    this.searchTerms = searchTerms(query)
    this.render()
  }

  setTagFilter(tags: Set<string>): void {
    this.tagFilter = tags
    this.render()
  }

  /** A tag chip on a result row was clicked. */
  onTagClick(callback: (tag: string) => void): void {
    this.onTagClickCallback = callback
  }

  /** True while a search, tag or level filter narrows the library — results then show as a flat list instead of the tree. */
  get isFiltering(): boolean {
    return this.searchTerms.length > 0 || this.tagFilter.size > 0 || this.levelFilter.size > 0
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
    this.section.setCount(this.entries.filter((e) => !e.is_dir).length || null)
    if (!this.rootFolder) {
      this.emptyEl.style.display = 'block'
      this.emptyEl.textContent = 'No folder selected yet. Use the folder button at the top to choose where your scores live.'
      this.treeEl.style.display = 'none'
      return
    }
    if (this.entries.length === 0) {
      this.emptyEl.style.display = 'block'
      this.emptyEl.textContent = 'No scores found in this folder'
      this.treeEl.style.display = 'none'
      return
    }

    this.emptyEl.style.display = 'none'
    this.treeEl.style.display = 'block'
    this.treeEl.classList.toggle('flat-results', this.isFiltering)
    if (this.isFiltering) {
      this.renderResults()
      return
    }
    this.renderChildren(buildTree(this.entries, this.rootFolder), this.treeEl, 0)
  }

  /** Every sheet passing the search, tag and level filters, as one flat list sorted by title. */
  private renderResults(): void {
    const results = this.entries
      .filter(
        (e) =>
          !e.is_dir &&
          matchesTags(e, this.rootFolder, this.tagFilter) &&
          (this.levelFilter.size === 0 || this.levelFilter.has(this.ratingFn(e.path))) &&
          matchesSearch(e, this.rootFolder, this.searchTerms),
      )
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }))
    this.section.setCount(results.length)
    if (results.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'flat-results-empty'
      empty.textContent = 'No sheets match these filters'
      this.treeEl.appendChild(empty)
      return
    }
    for (const entry of results) this.treeEl.appendChild(this.renderFileRow(entry, 0, true))
  }

  private renderChildren(node: TreeNode, container: HTMLElement, depth: number): void {
    const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
      const aIsDir = a.children.size > 0 || !a.entry
      const bIsDir = b.children.size > 0 || !b.entry
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    })

    for (const child of sortedChildren) {
      if (child.entry) {
        container.appendChild(this.renderFileRow(child.entry, depth, false))
      } else {
        container.appendChild(this.renderFolderRow(child, depth))
      }
    }
  }

  private renderFolderRow(node: TreeNode, depth: number): HTMLElement {
    const wrapper = document.createElement('div')
    const isOpen = this.expanded.has(node.relPath)

    const row = document.createElement('div')
    row.className = 'tree-row tree-folder-row'
    row.style.paddingLeft = `${depth * 16 + 7}px`
    row.innerHTML = `
      <span class="tree-disclosure${isOpen ? ' open' : ''}">${icon('chevron_right', 18)}</span>
      <span class="tree-folder-icon">${icon(isOpen ? 'folder_open' : 'folder', 20)}</span>
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
      this.renderChildren(node, childrenEl, depth + 1)
      wrapper.appendChild(childrenEl)
    }

    return wrapper
  }

  /** `withPath`: a flat-results row, which shows where the sheet lives — its tags as clickable chips, deeper folders as plain text. */
  private renderFileRow(entry: LibraryEntry, depth: number, withPath: boolean): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tree-row tree-file-row'
    row.style.paddingLeft = `${depth * 16 + 7}px`

    row.insertAdjacentHTML('beforeend', fileTypeIcon(entry.path))

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = entry.title
    if (withPath) {
      const main = document.createElement('span')
      main.className = 'result-main'
      main.append(label, this.renderPathChips(entry))
      row.appendChild(main)
    } else {
      row.appendChild(label)
    }

    const stars = new RatingStars()
    stars.setLevel(this.ratingFn(entry.path))
    stars.onChange((level) => void this.handleRatingChange(entry, level))
    row.appendChild(stars.el)

    const pinBtn = document.createElement('button')
    pinBtn.className = 'pin-btn'
    pinBtn.type = 'button'
    pinBtn.title = this.isPinnedFn(entry.path) ? 'Unpin' : 'Pin to top'
    pinBtn.setAttribute('aria-label', pinBtn.title)
    pinBtn.innerHTML = icon('push_pin', 18)
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

  private renderPathChips(entry: LibraryEntry): HTMLElement {
    const el = document.createElement('span')
    el.className = 'result-path'
    const tags = tagsOf(entry, this.rootFolder)
    for (const tag of tags) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'path-chip'
      chip.classList.toggle('active', this.tagFilter.has(tag))
      chip.textContent = tag.slice(tag.lastIndexOf('/') + 1)
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onTagClickCallback?.(tag)
      })
      el.appendChild(chip)
    }
    const deeper = folderParts(entry, this.rootFolder).slice(tags.length)
    if (deeper.length > 0) {
      const rest = document.createElement('span')
      rest.className = 'path-rest'
      rest.textContent = deeper.join(' / ')
      el.appendChild(rest)
    }
    return el
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
