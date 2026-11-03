import { icon, type IconName } from '../icons'

/**
 * A `.sidebar-section`-styled container with a clickable disclosure triangle
 * in its title row, collapsing/expanding its body. Shared by `FileListPanel`
 * (pinned/recent lists) and `FolderTree` (the library) so all three library
 * sections collapse identically rather than three separate implementations.
 * Expand/collapse state is in-memory only (not persisted) — reopening the
 * library view mid-session keeps whatever was last set, but a fresh app
 * launch always starts expanded.
 */
export class CollapsibleSection {
  readonly root: HTMLDivElement
  readonly bodyEl: HTMLDivElement
  private readonly countEl: HTMLSpanElement
  private collapsed = false

  constructor(container: HTMLElement, title: string, glyph?: IconName) {
    this.root = document.createElement('div')
    this.root.className = 'sidebar-section collapsible-section'
    this.root.innerHTML = `
      <div class="collapsible-section-header" role="button" tabindex="0" aria-expanded="true">
        <span class="collapsible-disclosure">${icon('expand_more', 18)}</span>
        ${glyph ? `<span class="section-icon">${icon(glyph, 16)}</span>` : ''}
        <span class="sidebar-section-title">${title}</span>
        <span class="section-count"></span>
      </div>
      <div class="collapsible-section-body"></div>
    `
    container.appendChild(this.root)
    this.countEl = this.root.querySelector('.section-count')!
    this.bodyEl = this.root.querySelector('.collapsible-section-body')!

    const header = this.root.querySelector<HTMLElement>('.collapsible-section-header')!
    header.addEventListener('click', () => this.toggle())
    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      this.toggle()
    })
  }

  private toggle(): void {
    this.collapsed = !this.collapsed
    this.root.classList.toggle('collapsed', this.collapsed)
    this.root.querySelector('.collapsible-section-header')!.setAttribute('aria-expanded', String(!this.collapsed))
    this.bodyEl.style.display = this.collapsed ? 'none' : 'block'
  }

  /** The little number badge next to the title; `null` hides it. */
  setCount(count: number | null): void {
    this.countEl.textContent = count === null ? '' : String(count)
  }

  /** Shows/hides the whole section (title included) — distinct from collapse, which only hides the body. Used when a list has no entries at all. */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none'
  }
}
