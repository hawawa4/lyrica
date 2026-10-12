import type { Timeline, TimelineEvent } from '../types'
import { getPlaybackPosition } from '../api-client'

/**
 * Playback cursor overlay. Polls the Rust-side synth's current position and
 * highlights whichever TimelineEvent's bbox contains that time, calling back
 * so the caller can scroll/switch pages and draw the highlight (actual DOM
 * drawing is deliberately left to the caller — PageView/SelectionOverlay own
 * the page container's layers; Cursor only owns the polling + lookup logic).
 */
export class Cursor {
  private timeline: Timeline | null = null
  private pollHandle: number | null = null
  private lastEventIndex = -1

  constructor(private readonly onCursorMove: (event: TimelineEvent, eventIndex: number) => void) {}

  setTimeline(timeline: Timeline | null): void {
    this.timeline = timeline
    this.lastEventIndex = -1
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
    if (!this.timeline || this.timeline.events.length === 0) return
    const positionSecs = await getPlaybackPosition()
    // rustysynth's MidiFileSequencer.get_position() already reports time in
    // the original (1.0x) MIDI timeline regardless of playback speed — its
    // internal clock advances by `speed * block_size / sample_rate` per
    // audio block, which is exactly the original-timeline rate scaled by
    // how much wall-clock time has passed, not a sped-up clock. So no
    // speed conversion is needed here: this lines up directly with
    // TimelineEvent.time_ms (also derived from the unsped original timeline).
    const timeMs = positionSecs * 1000

    const eventIndex = findEventIndexForTime(this.timeline.events, timeMs)
    if (eventIndex !== this.lastEventIndex && eventIndex !== -1) {
      this.lastEventIndex = eventIndex
      this.onCursorMove(this.timeline.events[eventIndex], eventIndex)
    }
  }
}

/** Finds the last event whose time_ms is <= timeMs (binary search, events are time-sorted). */
function findEventIndexForTime(events: TimelineEvent[], timeMs: number): number {
  let lo = 0
  let hi = events.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].time_ms <= timeMs) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}
