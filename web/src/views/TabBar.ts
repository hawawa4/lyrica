export interface TabInfo {
  fileHash: string
  title: string
}

/**
 * Excel-style bottom tab bar, one tab per open file (keyed by file hash).
 * Purely presentational — owns no score/timeline state itself; `main.ts`
 * keeps per-tab state and swaps it in when `onSwitch` fires.
 */
export class TabBar {
  private readonly root: HTMLDivElement
  private tabs: TabInfo[] = []
  private activeHash: string | null = null
  private onSwitchCallback: ((fileHash: string) => void) | null = null
  private onCloseCallback: ((fileHash: string) => void) | null = null

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.style.display = 'flex'
    this.root.style.gap = '2px'
    this.root.style.borderTop = '1px solid #ddd'
    this.root.style.marginTop = '8px'
    this.root.style.paddingTop = '4px'
    this.root.style.flexWrap = 'wrap'
    container.appendChild(this.root)
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
      tabEl.style.display = 'flex'
      tabEl.style.alignItems = 'center'
      tabEl.style.gap = '6px'
      tabEl.style.padding = '4px 8px'
      tabEl.style.cursor = 'pointer'
      tabEl.style.border = '1px solid #ddd'
      tabEl.style.borderBottom = 'none'
      tabEl.style.borderRadius = '4px 4px 0 0'
      tabEl.style.background = tab.fileHash === this.activeHash ? '#fff' : '#f0f0f0'
      tabEl.style.fontWeight = tab.fileHash === this.activeHash ? 'bold' : 'normal'

      const label = document.createElement('span')
      label.textContent = tab.title
      label.style.maxWidth = '160px'
      label.style.overflow = 'hidden'
      label.style.textOverflow = 'ellipsis'
      label.style.whiteSpace = 'nowrap'
      label.addEventListener('click', () => this.onSwitchCallback?.(tab.fileHash))

      const closeBtn = document.createElement('button')
      closeBtn.textContent = '✕'
      closeBtn.style.border = 'none'
      closeBtn.style.background = 'transparent'
      closeBtn.style.cursor = 'pointer'
      closeBtn.style.fontSize = '12px'
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onCloseCallback?.(tab.fileHash)
      })

      tabEl.append(label, closeBtn)
      this.root.appendChild(tabEl)
    }
  }
}
