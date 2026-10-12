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
  private readonly listEl: HTMLUListElement
  private readonly addBtn: HTMLButtonElement
  private readonly textInput: HTMLInputElement
  private readonly statusEl: HTMLDivElement
  private fileHash: string | null = null
  private markers: Marker[] = []
  private getMeasureIndexForNewMarker: (() => number | null) | null = null
  private onJump: ((measureIndex: number) => void) | null = null

  constructor(container: HTMLElement) {
    const root = document.createElement('div')
    root.innerHTML = `
      <div style="margin-top: 16px; border-top: 1px solid #ddd; padding-top: 8px;">
        <strong>Markers</strong>
        <div style="margin-top: 4px;">
          <input type="text" placeholder="Note for the selected measure..." style="width: 220px;" />
          <button>Add marker</button>
        </div>
        <div class="marker-status" style="color: #888; font-size: 13px; margin-top: 4px;"></div>
        <ul style="list-style: none; padding: 0; margin-top: 8px;"></ul>
      </div>
    `
    container.appendChild(root)

    this.textInput = root.querySelector('input')!
    this.addBtn = root.querySelector('button')!
    this.statusEl = root.querySelector('.marker-status')!
    this.listEl = root.querySelector('ul')!

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
      li.style.cursor = 'pointer'
      li.style.padding = '2px 0'

      const label = document.createElement('span')
      label.textContent = `Measure ${marker.measure_index + 1}: ${marker.text}`
      label.addEventListener('click', () => this.onJump?.(marker.measure_index))

      const deleteBtn = document.createElement('button')
      deleteBtn.textContent = '✕'
      deleteBtn.style.marginLeft = '8px'
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
