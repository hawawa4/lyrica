export interface TabInfo {
  fileHash: string
  title: string
}

/**
 * Excel-style bottom tab bar, one tab per open file (keyed by file hash).
 * Purely presentational — owns no score/timeline state itself; `main.ts`
 * keeps per-tab state and swaps it in when `onSwitch` fires. Styling lives
 * in app.css (`.tab-bar`, `.tab-bar-item`); this class only toggles classes.
 */
export class TabBar {
  private readonly root: HTMLDivElement
  private tabs: TabInfo[] = []
  private activeHash: string | null = null
  private onSwitchCallback: ((fileHash: string) => void) | null = null
  private onCloseCallback: ((fileHash: string) => void) | null = null

  constructor(container: HTMLElement) {
    this.root = container as HTMLDivElement
  }

  onSwitch(callback: (fileHash: string) => void): void {
    this.onSwitchCallback = callback
  }

  onClose(callback: (fileHash: string) => void): void {
    this.onCloseCallback = callback
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
      const tabEl = document.createElement('div')
      tabEl.className = 'tab-bar-item' + (tab.fileHash === this.activeHash ? ' active' : '')

      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = tab.title
      label.addEventListener('click', () => this.onSwitchCallback?.(tab.fileHash))

      const closeBtn = document.createElement('button')
      closeBtn.className = 'close-btn'
      closeBtn.textContent = '✕'
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onCloseCallback?.(tab.fileHash)
      })

      tabEl.append(label, closeBtn)
      this.root.appendChild(tabEl)
    }
  }
}
