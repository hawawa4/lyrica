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
  private readonly disclosureEl: HTMLSpanElement
  private collapsed = false

  constructor(container: HTMLElement, title: string) {
    this.root = document.createElement('div')
    this.root.className = 'sidebar-section collapsible-section'
    this.root.innerHTML = `
      <div class="collapsible-section-header">
        <span class="collapsible-disclosure">&#9660;</span>
        <span class="sidebar-section-title">${title}</span>
      </div>
      <div class="collapsible-section-body"></div>
    `
    container.appendChild(this.root)
    this.disclosureEl = this.root.querySelector('.collapsible-disclosure')!
    this.bodyEl = this.root.querySelector('.collapsible-section-body')!

    this.root.querySelector('.collapsible-section-header')!.addEventListener('click', () => this.toggle())
  }

  private toggle(): void {
    this.collapsed = !this.collapsed
    this.disclosureEl.innerHTML = this.collapsed ? '&#9654;' : '&#9660;'
    this.bodyEl.style.display = this.collapsed ? 'none' : 'block'
  }

  /** Shows/hides the whole section (title included) — distinct from collapse, which only hides the body. Used when a list has no entries at all. */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none'
  }
}
