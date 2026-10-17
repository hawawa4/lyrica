import { getPlaybackPosition } from '../api-client'

/** Anything with a `time_ms` field in a time-sorted array can drive a Cursor — `TimelineEvent[]` for `.mscz` tabs, `CalibrationPoint[]` for PDF tabs. */
interface TimedItem {
  time_ms: number
}

/**
 * Playback cursor overlay. Polls the Rust-side synth's current position and
 * highlights whichever item's time window contains it, calling back so the
 * caller can scroll/switch pages and draw the highlight (actual DOM drawing
 * is deliberately left to the caller — PageView/SelectionOverlay own the
 * page container's layers; Cursor only owns the polling + lookup logic).
 *
 * Generic over the item type so both `.mscz` tabs (`TimelineEvent[]`, with
 * bboxes to draw a highlight box from) and PDF tabs (`CalibrationPoint[]`,
 * with no bbox — only a page position to point at) can share the same
 * poll-and-binary-search mechanism instead of duplicating it.
 */
export class Cursor<T extends TimedItem = TimedItem> {
  private items: T[] = []
  private pollHandle: number | null = null
  private lastItemIndex = -1

  constructor(private readonly onCursorMove: (item: T, itemIndex: number) => void) {}

  setItems(items: T[] | null): void {
    this.items = items ?? []
    this.lastItemIndex = -1
  }

  start(): void {
    this.stop()
    this.pollHandle = window.setInterval(() => this.poll(), 50)
  }

  stop(): void {
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle)
      this.pollHandle = null
    }
  }

  private async poll(): Promise<void> {
    if (this.items.length === 0) return
    const positionSecs = await getPlaybackPosition()
    // The Rust `Player`'s playback position already reports time in
    // the original (1.0x) MIDI timeline regardless of playback speed — its
    // internal clock advances by `speed * block_size / sample_rate` per
    // audio block, which is exactly the original-timeline rate scaled by
    // how much wall-clock time has passed, not a sped-up clock. So no
    // speed conversion is needed here: this lines up directly with
    // TimedItem.time_ms (also derived from the unsped original timeline, or
    // for PDF mode, from the same clock via Player::load_tempo_map).
    const timeMs = positionSecs * 1000

    const itemIndex = findItemIndexForTime(this.items, timeMs)
    if (itemIndex !== this.lastItemIndex && itemIndex !== -1) {
      this.lastItemIndex = itemIndex
      this.onCursorMove(this.items[itemIndex], itemIndex)
    }
  }
}

/** Finds the last item whose time_ms is <= timeMs (binary search, items are time-sorted). */
function findItemIndexForTime<T extends TimedItem>(items: T[], timeMs: number): number {
  let lo = 0
  let hi = items.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].time_ms <= timeMs) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}
