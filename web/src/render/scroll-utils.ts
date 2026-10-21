/**
 * Helpers shared by scroll mode's two implementations (`ScrollPageView` for
 * .mscz, PracticeView's PDF panes): which stage is "current", and which
 * stages are close enough to the viewport to be worth rendering.
 *
 * Both use IntersectionObserver with the implicit (top-level viewport) root —
 * intersection already accounts for the clipping of the `.page-area` scroll
 * container, and works before the stages are attached to the document.
 */

const NEAR_MARGIN = '1200px'

/** Calls `onNear(index)` whenever stage `index` comes within ~a screen of the viewport (and again if it leaves and re-enters — callers dedupe). */
export class NearViewportObserver {
  private readonly observer: IntersectionObserver
  private readonly indexOf = new Map<Element, number>()

  constructor(onNear: (index: number) => void) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = this.indexOf.get(entry.target)
          if (entry.isIntersecting && index !== undefined) onNear(index)
        }
      },
      { rootMargin: NEAR_MARGIN },
    )
  }

  observe(el: Element, index: number): void {
    this.indexOf.set(el, index)
    this.observer.observe(el)
  }

  disconnect(): void {
    this.observer.disconnect()
    this.indexOf.clear()
  }
}

/** Tracks which stage is most visible and calls `onCurrent(index)` when that changes (ties go to the earliest page). */
export class CurrentPageTracker {
  private readonly observer: IntersectionObserver
  private readonly indexOf = new Map<Element, number>()
  private readonly ratios = new Map<number, number>()
  private current = -1

  constructor(onCurrent: (index: number) => void) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = this.indexOf.get(entry.target)
          if (index !== undefined) this.ratios.set(index, entry.intersectionRatio)
        }
        let best = -1
        let bestRatio = 0
        for (const [index, ratio] of this.ratios) {
          if (ratio > bestRatio || (ratio === bestRatio && ratio > 0 && index < best)) {
            best = index
            bestRatio = ratio
          }
        }
        if (best !== -1 && best !== this.current) {
          this.current = best
          onCurrent(best)
        }
      },
      { threshold: [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1] },
    )
  }

  observe(el: Element, index: number): void {
    this.indexOf.set(el, index)
    this.observer.observe(el)
  }

  /** Records `index` as current without notifying — for a programmatic jump the caller already reported. */
  setCurrent(index: number): void {
    this.current = index
  }

  disconnect(): void {
    this.observer.disconnect()
    this.indexOf.clear()
    this.ratios.clear()
  }
}

/** Runs `change` (which resizes content) while keeping the same relative reading position in `scroller`, so zooming doesn't throw the user elsewhere in the strip. */
export function preserveScrollRatio(scroller: HTMLElement, change: () => void): void {
  const ratioY = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0
  const ratioX = scroller.scrollWidth > 0 ? scroller.scrollLeft / scroller.scrollWidth : 0
  change()
  scroller.scrollTop = ratioY * scroller.scrollHeight
  scroller.scrollLeft = ratioX * scroller.scrollWidth
}
