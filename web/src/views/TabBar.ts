import { icon } from '../icons'

export interface TabInfo {
  fileHash: string
  title: string
  kind: 'mscz' | 'pdf'
}

/**
 * Bottom tab bar, one tab per open file (keyed by file hash).
 * Purely presentational — owns no score/timeline state itself; `main.ts`
 * keeps per-tab state and swaps it in when `onSwitch` fires. Styling lives
 * in components.css (`.tab-bar`, `.tab-bar-item`); this class only toggles classes.
 */
export class TabBar {
  private readonly root: HTMLDivElement
  private tabs: TabInfo[] = []
  private activeHash: string | null = null
  private onSwitchCallback: ((fileHash: string) => void) | null = null
  private onCloseCallback: ((fileHash: string) => void) | null = null
  private onAddCallback: (() => void) | null = null

  constructor(container: HTMLElement) {
    this.root = container as HTMLDivElement
    this.root.setAttribute('role', 'tablist')
  }

  onSwitch(callback: (fileHash: string) => void): void {
    this.onSwitchCallback = callback
  }

  onClose(callback: (fileHash: string) => void): void {
    this.onCloseCallback = callback
  }

  /** The "+" at the end of the strip: open another file. */
  onAdd(callback: () => void): void {
    this.onAddCallback = callback
  }

  /** Full re-render of the tab list and which one is active. */
  setTabs(tabs: TabInfo[], activeHash: string | null): void {
    this.tabs = tabs
    this.activeHash = activeHash
    this.render()
  }

  private render(): void {
    this.root.innerHTML = ''
    this.root.style.display = this.tabs.length > 0 ? 'flex' : 'none'

    for (const tab of this.tabs) {
      const active = tab.fileHash === this.activeHash
      const tabEl = document.createElement('div')
      tabEl.className = 'tab-bar-item' + (active ? ' active' : '')
      tabEl.setAttribute('role', 'tab')
      tabEl.setAttribute('aria-selected', String(active))
      tabEl.title = tab.title
      tabEl.addEventListener('click', () => this.onSwitchCallback?.(tab.fileHash))
      // Middle-click closes, like a browser tab.
      tabEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) this.onCloseCallback?.(tab.fileHash)
      })

      const tabIcon = document.createElement('span')
      tabIcon.className = 'tab-icon'
      tabIcon.innerHTML = icon(tab.kind === 'pdf' ? 'description' : 'music_note', 16)

      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = tab.title

      const closeBtn = document.createElement('button')
      closeBtn.className = 'close-btn'
      closeBtn.type = 'button'
      closeBtn.title = 'Close'
      closeBtn.setAttribute('aria-label', `Close ${tab.title}`)
      closeBtn.innerHTML = icon('close', 14)
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onCloseCallback?.(tab.fileHash)
      })

      tabEl.append(tabIcon, label, closeBtn)
      this.root.appendChild(tabEl)
    }

    const addBtn = document.createElement('button')
    addBtn.className = 'icon-btn sm tab-bar-add'
    addBtn.type = 'button'
    addBtn.title = 'Open another file'
    addBtn.setAttribute('aria-label', 'Open another file')
    addBtn.innerHTML = icon('add', 18)
    addBtn.addEventListener('click', () => this.onAddCallback?.())
    this.root.appendChild(addBtn)
  }
}
