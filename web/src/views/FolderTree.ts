import type { LibraryEntry } from '../types'

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
function matches(node: TreeNode, query: string): boolean {
  if (!query) return true
  if (node.name.toLowerCase().includes(query)) return true
  for (const child of node.children.values()) {
    if (matches(child, query)) return true
  }
  return false
}

/**
 * A collapsible folder-tree view of a scanned library root, built client-side
 * from `scan_library`'s flat file list (the Rust side stays a simple
 * recursive walk — grouping into a tree is cheap, pure DOM/data-shape work
 * better done here than by widening the Tauri command's response shape).
 *
 * Every file row has an always-visible pin toggle (a star button) — pinning
 * requires a content hash the row doesn't have yet (it's only computed once
 * a file is opened), so clicking the star on an unopened file first reads
 * and hashes it on demand via `onRequestHash`, then pins.
 */
export class FolderTree {
  private readonly root: HTMLDivElement
  private readonly treeEl: HTMLDivElement
  private readonly emptyEl: HTMLDivElement
  private entries: LibraryEntry[] = []
  private rootFolder = ''
  private searchQuery = ''
  private readonly expanded = new Set<string>()
  private onOpenCallback: ((path: string) => void) | null = null
  private onTogglePinCallback: ((path: string, title: string, pin: boolean) => void) | null = null
  private isPinnedFn: (path: string) => boolean = () => false
  /** Resolves a path to its content hash, computing it (reading + hashing the file) on first use if necessary — pinning needs this, opening doesn't. */
  private requestHashFn: ((path: string) => Promise<string | null>) | null = null
  private pendingHashPaths = new Set<string>()

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'sidebar-section folder-tree-section'
    this.root.innerHTML = `
      <span class="sidebar-section-title">Library</span>
      <div class="folder-tree"></div>
      <div class="folder-tree-empty" style="display:none;">No folder selected</div>
    `
    container.appendChild(this.root)
    this.treeEl = this.root.querySelector('.folder-tree')!
    this.emptyEl = this.root.querySelector('.folder-tree-empty')!
  }

  onOpen(callback: (path: string) => void): void {
    this.onOpenCallback = callback
  }

  onTogglePin(callback: (path: string, title: string, pin: boolean) => void): void {
    this.onTogglePinCallback = callback
  }

  setIsPinned(fn: (path: string) => boolean): void {
    this.isPinnedFn = fn
  }

  setRequestHash(fn: (path: string) => Promise<string | null>): void {
    this.requestHashFn = fn
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query.trim().toLowerCase()
    this.render()
  }

  setData(entries: LibraryEntry[], rootFolder: string): void {
    this.entries = entries
    this.rootFolder = rootFolder
    this.render()
  }

  /** Re-renders without re-fetching — call after a pin-state change elsewhere so star icons stay in sync. */
  refreshPinState(): void {
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

    const autoExpand = this.searchQuery.length > 0
    this.renderChildren(tree, this.treeEl, 0, autoExpand)
  }

  private renderChildren(node: TreeNode, container: HTMLElement, depth: number, autoExpand: boolean): void {
    const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
      const aIsDir = a.children.size > 0 || !a.entry
      const bIsDir = b.children.size > 0 || !b.entry
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    })

    for (const child of sortedChildren) {
      if (!matches(child, this.searchQuery)) continue

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

    const pinBtn = document.createElement('button')
    pinBtn.className = 'pin-btn'
    pinBtn.title = this.isPinnedFn(entry.path) ? 'Unpin' : 'Pin to top'
    pinBtn.innerHTML = this.isPinnedFn(entry.path) ? '&#9733;' : '&#9734;'
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
    if (this.pendingHashPaths.has(entry.path)) return // hash already in flight for this row
    this.pendingHashPaths.add(entry.path)
    try {
      const hash = await this.requestHashFn?.(entry.path)
      if (hash) this.onTogglePinCallback?.(entry.path, entry.title, true)
    } finally {
      this.pendingHashPaths.delete(entry.path)
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
