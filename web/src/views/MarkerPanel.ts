import { addMarker, deleteMarker, listMarkers } from '../api-client'
import type { Marker } from '../types'

/**
 * Lists markers for the currently open score, lets the user add one
 * (anchored to whatever measure index the caller supplies at add-time —
 * typically the current selection's start or the cursor's current measure)
 * and click one to jump to it. Owns its own DOM subtree; the caller mounts
 * it into a container and feeds it a new `fileHash` each time a score opens.
 */
export class MarkerPanel {
  private readonly root: HTMLDivElement
  private readonly listEl: HTMLUListElement
  private readonly addBtn: HTMLButtonElement
  private readonly textInput: HTMLInputElement
  private readonly statusEl: HTMLDivElement
  private fileHash: string | null = null
  private markers: Marker[] = []
  private getMeasureIndexForNewMarker: (() => number | null) | null = null
  private onJump: ((measureIndex: number) => void) | null = null

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'sidebar-section'
    this.root.innerHTML = `
      <span class="sidebar-section-title">Markers</span>
      <div class="marker-add-row">
        <input type="text" placeholder="Note for the selected measure..." />
        <button>Add</button>
      </div>
      <div class="marker-status panel-status"></div>
      <ul class="panel-list"></ul>
    `
    container.appendChild(this.root)

    this.textInput = this.root.querySelector('input')!
    this.addBtn = this.root.querySelector('button')!
    this.statusEl = this.root.querySelector('.marker-status')!
    this.listEl = this.root.querySelector('ul')!

    this.addBtn.addEventListener('click', () => void this.handleAdd())
    this.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.handleAdd()
    })
  }

  /** Supplies the measure index a new marker should attach to, computed lazily at add-time. */
  onRequestMeasureIndex(callback: () => number | null): void {
    this.getMeasureIndexForNewMarker = callback
  }

  /** Called when the user clicks a marker in the list, to jump the view/cursor to it. */
  onJumpToMeasure(callback: (measureIndex: number) => void): void {
    this.onJump = callback
  }

  /** Call once per opened score (or `null` to clear when no score is open). */
  async setFileHash(fileHash: string | null): Promise<void> {
    this.fileHash = fileHash
    this.statusEl.textContent = ''
    if (!fileHash) {
      this.markers = []
      this.render()
      return
    }
    try {
      this.markers = await listMarkers(fileHash)
    } catch (e) {
      this.statusEl.textContent = `Failed to load markers: ${describeError(e)}`
      this.markers = []
    }
    this.render()
  }

  private async handleAdd(): Promise<void> {
    const text = this.textInput.value.trim()
    if (!text) {
      this.statusEl.textContent = 'Type a note before adding a marker.'
      return
    }
    if (!this.fileHash) {
      this.statusEl.textContent = 'Open a score before adding a marker.'
      return
    }
    const measureIndex = this.getMeasureIndexForNewMarker?.()
    if (measureIndex === null || measureIndex === undefined) {
      this.statusEl.textContent = 'Drag-select a measure first, then add a marker for it.'
      return
    }

    try {
      this.markers = await addMarker(this.fileHash, measureIndex, text)
      this.textInput.value = ''
      this.statusEl.textContent = ''
      this.render()
    } catch (e) {
      this.statusEl.textContent = `Failed to add marker: ${describeError(e)}`
    }
  }

  private async handleDelete(markerId: string): Promise<void> {
    if (!this.fileHash) return
    try {
      this.markers = await deleteMarker(this.fileHash, markerId)
      this.render()
    } catch (e) {
      this.statusEl.textContent = `Failed to delete marker: ${describeError(e)}`
    }
  }

  private render(): void {
    this.listEl.innerHTML = ''
    for (const marker of this.markers) {
      const li = document.createElement('li')
      li.className = 'panel-list-item'

      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = `Measure ${marker.measure_index + 1}: ${marker.text}`
      label.addEventListener('click', () => this.onJump?.(marker.measure_index))

      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'remove-btn'
      deleteBtn.textContent = '✕'
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.handleDelete(marker.id)
      })

      li.append(label, deleteBtn)
      this.listEl.appendChild(li)
    }
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
