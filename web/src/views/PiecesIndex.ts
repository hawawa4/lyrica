import { detectPieces } from '../api-client'
import type { Piece } from '../types'

/**
 * Lists auto-detected piece boundaries for the currently open score (see
 * `detectPieces`/`crates/core/src/pieces.rs`) and lets the user click one to
 * jump to it. Read-only — pieces are detected from the file's own title
 * frames, not user-created, unlike `MarkerPanel`. Hidden entirely when a
 * file has 0 or 1 detected boundaries (i.e. isn't actually a multi-piece
 * combined file).
 */
export class PiecesIndex {
  private readonly root: HTMLDivElement
  private readonly listEl: HTMLUListElement
  private onJump: ((elid: number) => void) | null = null

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.style.display = 'none'
    this.root.innerHTML = `
      <div style="margin-top: 16px; border-top: 1px solid #ddd; padding-top: 8px;">
        <strong>Pieces</strong>
        <ul style="list-style: none; padding: 0; margin-top: 8px;"></ul>
      </div>
    `
    container.appendChild(this.root)
    this.listEl = this.root.querySelector('ul')!
  }

  /**
   * `callback` receives `Piece.start_measure_index`, which despite the
   * name is in the *printed/non-unrolled* `elid` index space (webmscore's
   * `measurePositions().elements[]`, document order) — NOT the same space as
   * `TimelineEvent.measure_index` (the repeats-unrolled `events[]` space).
   * Callers must look this up via `TimelineEvent.source_elid`, not
   * `measure_index`, or jumps land on the wrong page for any piece after the
   * first repeat anywhere earlier in the file.
   */
  onJumpToElid(callback: (elid: number) => void): void {
    this.onJump = callback
  }

  /** Call once per opened score (pass the original, pre-upgrade bytes). `null` clears it. */
  async setScoreBytes(bytes: Uint8Array | null): Promise<void> {
    if (!bytes) {
      this.root.style.display = 'none'
      this.listEl.innerHTML = ''
      return
    }
    let pieces: Piece[]
    try {
      pieces = await detectPieces(bytes)
    } catch (e) {
      console.error('Failed to detect pieces:', e)
      pieces = []
    }
    this.render(pieces)
  }

  private render(pieces: Piece[]): void {
    this.listEl.innerHTML = ''
    if (pieces.length <= 1) {
      this.root.style.display = 'none'
      return
    }
    this.root.style.display = 'block'
    for (const piece of pieces) {
      const li = document.createElement('li')
      li.style.cursor = 'pointer'
      li.style.padding = '2px 0'
      li.textContent = piece.title
      li.addEventListener('click', () => this.onJump?.(piece.start_measure_index))
      this.listEl.appendChild(li)
    }
  }
}
