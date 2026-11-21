import type { LibraryEntry } from './types'

/**
 * Folder-derived tags for the library. A sheet's tags are the first two
 * folders it sits in below the library root: `Touhou/TH06 …/Foo.mscz` is
 * tagged `Touhou` and `Touhou/TH06 …`. Deeper folders only show in the
 * sheet's path, not as tags — two levels keep the tag rail short on deep
 * libraries. Nothing is stored: tags are recomputed from every scan, so
 * moving a file between folders retags it.
 *
 * Tag keys are the folder path joined with `/` (whatever the OS separator),
 * so a sub-tag's key starts with its parent's key.
 */

export const TAG_DEPTH = 2

export interface TagNode {
  key: string
  name: string
  /** Sheets at or below this folder. */
  count: number
  children: TagNode[]
}

/** Folder names between `rootFolder` and the file, excluding the file name itself. */
export function folderParts(entry: LibraryEntry, rootFolder: string): string[] {
  const rel = entry.path.startsWith(rootFolder) ? entry.path.slice(rootFolder.length) : entry.path
  const parts = rel.split(/[/\\]+/).filter(Boolean)
  return parts.slice(0, -1)
}

/** Tag keys of a sheet, outermost first (`['Touhou', 'Touhou/TH06 …']`). */
export function tagsOf(entry: LibraryEntry, rootFolder: string): string[] {
  const parts = folderParts(entry, rootFolder).slice(0, TAG_DEPTH)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** The tag rail's data: top-level folder tags with their sub-folder tags, each sorted by name. */
export function buildTagTree(entries: LibraryEntry[], rootFolder: string): TagNode[] {
  const byKey = new Map<string, TagNode>()
  const roots: TagNode[] = []
  for (const entry of entries) {
    if (entry.is_dir) continue
    let parent: TagNode | null = null
    for (const key of tagsOf(entry, rootFolder)) {
      let node = byKey.get(key)
      if (!node) {
        node = { key, name: key.slice(key.lastIndexOf('/') + 1), count: 0, children: [] }
        byKey.set(key, node)
        ;(parent ? parent.children : roots).push(node)
      }
      node.count++
      parent = node
    }
  }
  const sort = (nodes: TagNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    for (const n of nodes) sort(n.children)
  }
  sort(roots)
  return roots
}

/** True if the sheet carries any of `selected` (OR); an empty selection matches everything. */
export function matchesTags(entry: LibraryEntry, rootFolder: string, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true
  return tagsOf(entry, rootFolder).some((t) => selected.has(t))
}

/** Lowercased, accent-stripped — "Pokémon" matches "pokemon". */
export function normalizeForSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** Whitespace-separated search terms, normalized; empty for a blank query. */
export function searchTerms(query: string): string[] {
  return normalizeForSearch(query).split(/\s+/).filter(Boolean)
}

/** Every term must appear in the sheet's title or in one of its folder names (so "touhou bad apple" finds Bad Apple under Touhou/). */
export function matchesSearch(entry: LibraryEntry, rootFolder: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  const haystack = normalizeForSearch([entry.title, ...folderParts(entry, rootFolder)].join('\n'))
  return terms.every((t) => haystack.includes(t))
}
