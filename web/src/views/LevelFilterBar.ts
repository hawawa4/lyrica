import type { KnowledgeLevel } from '../types'

/**
 * Multi-select filter chips for "knowledge level" — click a level (or
 * "Unrated") to toggle it in/out of the active filter set; the folder tree
 * then shows only files matching one of the active levels (or everything, if
 * none are active). Multiple levels can be active at once (e.g. "1 and 2" to
 * see everything still being learned).
 */
export class LevelFilterBar {
  private readonly el: HTMLDivElement
  private readonly active = new Set<KnowledgeLevel | null>()
  private onChangeCallback: ((levels: Set<KnowledgeLevel | null>) => void) | null = null

  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'level-filter-bar'
    container.appendChild(this.el)
    this.render()
  }

  onChange(callback: (levels: Set<KnowledgeLevel | null>) => void): void {
    this.onChangeCallback = callback
  }

  private toggle(level: KnowledgeLevel | null): void {
    if (this.active.has(level)) this.active.delete(level)
    else this.active.add(level)
    this.render()
    this.onChangeCallback?.(new Set(this.active))
  }

  private render(): void {
    this.el.innerHTML = ''

    for (let level = 1; level <= 5; level++) {
      this.el.appendChild(this.renderChip(level as KnowledgeLevel, `${level}`, `Knowledge level ${level}`))
    }
    this.el.appendChild(this.renderChip(null, 'Unrated', 'Not yet rated'))

    if (this.active.size > 0) {
      const clearBtn = document.createElement('button')
      clearBtn.type = 'button'
      clearBtn.className = 'level-filter-clear'
      clearBtn.textContent = 'Clear'
      clearBtn.addEventListener('click', () => {
        this.active.clear()
        this.render()
        this.onChangeCallback?.(new Set())
      })
      this.el.appendChild(clearBtn)
    }
  }

  private renderChip(level: KnowledgeLevel | null, label: string, title: string): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'level-filter-chip'
    chip.classList.toggle('active', this.active.has(level))
    chip.textContent = label
    chip.title = title
    chip.addEventListener('click', () => this.toggle(level))
    return chip
  }
}
