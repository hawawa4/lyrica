import type { TagNode } from '../library-tags'
import { icon } from '../icons'

/**
 * Vertical list of folder-tag pills beside the library (see
 * `library-tags.ts`). Clicking a pill toggles it; several selected tags
 * combine with OR. Sub-folder tags sit indented under their parent and stay
 * folded until the parent's chevron is opened, or one of them is selected —
 * a library with dozens of sub-folders under one parent (Touhou) would
 * otherwise drown out the rest.
 */
export class TagRail {
  readonly el: HTMLElement
  private readonly listEl: HTMLDivElement
  private readonly clearBtn: HTMLButtonElement
  private tags: TagNode[] = []
  private selected = new Set<string>()
  private readonly unfolded = new Set<string>()
  private onChangeCallback: ((selected: Set<string>) => void) | null = null

  constructor(container: HTMLElement) {
    this.el = document.createElement('aside')
    this.el.className = 'tag-rail'
    this.el.setAttribute('aria-label', 'Filter by tag')
    this.el.innerHTML = `
      <div class="tag-rail-header">
        <span class="section-icon">${icon('label', 18)}</span>
        <span class="sidebar-section-title">Tags</span>
        <button type="button" class="tag-rail-clear" hidden>Clear</button>
      </div>
      <div class="tag-rail-list"></div>
    `
    container.appendChild(this.el)
    this.listEl = this.el.querySelector('.tag-rail-list')!
    this.clearBtn = this.el.querySelector('.tag-rail-clear')!
    this.clearBtn.addEventListener('click', () => this.setSelected(new Set()))
    this.render()
  }

  onChange(callback: (selected: Set<string>) => void): void {
    this.onChangeCallback = callback
  }

  /** New scan results. Selected tags whose folder no longer exists are dropped (and reported via `onChange`). */
  setTags(tags: TagNode[]): void {
    this.tags = tags
    const known = new Set<string>()
    const walk = (nodes: TagNode[]): void => {
      for (const n of nodes) {
        known.add(n.key)
        walk(n.children)
      }
    }
    walk(tags)
    const kept = new Set([...this.selected].filter((k) => known.has(k)))
    if (kept.size !== this.selected.size) this.setSelected(kept)
    else this.render()
  }

  /** Replaces the selection, e.g. from a tag chip on a result row. */
  setSelected(selected: Set<string>): void {
    this.selected = new Set(selected)
    // A sub-tag selected from outside the rail (a row's chip) shows up unfolded.
    for (const key of selected) {
      const slash = key.indexOf('/')
      if (slash > 0) this.unfolded.add(key.slice(0, slash))
    }
    this.render()
    this.onChangeCallback?.(new Set(this.selected))
  }

  private toggle(key: string): void {
    const next = new Set(this.selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    this.setSelected(next)
  }

  private render(): void {
    this.el.hidden = this.tags.length === 0
    this.clearBtn.hidden = this.selected.size === 0
    this.listEl.innerHTML = ''
    for (const tag of this.tags) {
      const open = this.unfolded.has(tag.key)
      this.listEl.appendChild(this.renderPill(tag, false, tag.children.length > 0 ? open : null))
      if (open) for (const child of tag.children) this.listEl.appendChild(this.renderPill(child, true, null))
    }
  }

  /** `open` is `null` for a tag without sub-tags (no chevron). */
  private renderPill(tag: TagNode, isChild: boolean, open: boolean | null): HTMLElement {
    const row = document.createElement('div')
    row.className = `tag-row${isChild ? ' child' : ''}`

    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'tag-pill'
    const active = this.selected.has(tag.key)
    pill.classList.toggle('active', active)
    pill.setAttribute('aria-pressed', String(active))
    const name = document.createElement('span')
    name.className = 'tag-name'
    name.textContent = tag.name
    const count = document.createElement('span')
    count.className = 'tag-count'
    count.textContent = String(tag.count)
    pill.append(name, count)
    pill.addEventListener('click', () => this.toggle(tag.key))
    row.appendChild(pill)

    if (open !== null) {
      const fold = document.createElement('button')
      fold.type = 'button'
      fold.className = `tag-fold${open ? ' open' : ''}`
      fold.setAttribute('aria-expanded', String(open))
      fold.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${tag.name} sub-folders`)
      fold.innerHTML = icon('chevron_right', 18)
      fold.addEventListener('click', () => {
        if (this.unfolded.has(tag.key)) this.unfolded.delete(tag.key)
        else this.unfolded.add(tag.key)
        this.render()
      })
      row.appendChild(fold)
    } else if (!isChild) {
      // Keeps every top-level pill the same width, chevron or not.
      const spacer = document.createElement('span')
      spacer.className = 'tag-fold'
      row.appendChild(spacer)
    }
    return row
  }
}
