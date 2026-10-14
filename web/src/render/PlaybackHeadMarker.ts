/**
 * Small downward-pointing triangle marking where the playback head
 * currently sits — unlike the highlight box driven by `Cursor` (which only
 * exists while audio is actively polling/playing), this is always visible
 * once a score/PDF is open, including while stopped or paused. One instance
 * is created once in main.ts and re-mounted onto whichever tab's page-stage
 * is currently active, same lifecycle as `cursorBoxEl`.
 */
export class PlaybackHeadMarker {
  readonly el: HTMLDivElement

  constructor() {
    this.el = document.createElement('div')
    this.el.style.position = 'absolute'
    this.el.style.width = '0'
    this.el.style.height = '0'
    this.el.style.borderLeft = '7px solid transparent'
    this.el.style.borderRight = '7px solid transparent'
    this.el.style.borderTop = '10px solid var(--cursor-box)'
    this.el.style.transform = 'translate(-50%, -100%)'
    this.el.style.pointerEvents = 'none'
    this.el.style.filter = 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4))'
    this.el.style.display = 'none'
  }

  /** `xPercent`/`yPercent` are 0-100, relative to the containing page-stage — the marker's point sits exactly at that position. */
  setPosition(xPercent: number, yPercent: number): void {
    this.el.style.left = `${xPercent}%`
    this.el.style.top = `${yPercent}%`
    this.el.style.display = 'block'
  }

  hide(): void {
    this.el.style.display = 'none'
  }
}
