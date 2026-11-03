import type { Timeline } from './types'

/**
 * The `[loop_start_ms, loop_end_ms]` pair, in the timeline's 1.0x space, for
 * the measures with `startElid <= source_elid <= endElid`.
 *
 * A printed measure can appear several times in the (repeats-unrolled)
 * timeline, so the matching events form one run per pass. Looping takes a
 * single run — the one playing at `headMs`, else the one starting nearest to
 * it — rather than from the first pass's start to the last pass's end, which
 * would drag in everything between the repeats.
 *
 * The loop ends where the next event starts, so the last selected measure
 * plays out in full; for the final measure there is no next event, so it
 * ends at the timeline's `end_ms`.
 */
export function loopRegionForElidRange(
  timeline: Timeline,
  startElid: number,
  endElid: number,
  headMs: number,
): [number, number] | null {
  const { events } = timeline
  const runs: [number, number][] = [] // inclusive event index ranges
  let runStart = -1
  for (let i = 0; i < events.length; i++) {
    const inRange = events[i].source_elid >= startElid && events[i].source_elid <= endElid
    if (inRange && runStart < 0) runStart = i
    if (!inRange && runStart >= 0) {
      runs.push([runStart, i - 1])
      runStart = -1
    }
  }
  if (runStart >= 0) runs.push([runStart, events.length - 1])
  if (runs.length === 0) return null

  const endMsOfRun = ([, last]: [number, number]): number =>
    events[last + 1]?.time_ms ?? Math.max(timeline.end_ms ?? 0, timeline.duration_ms)
  const startMsOfRun = ([first]: [number, number]): number => events[first].time_ms

  let best = runs[0]
  let bestDistance = Infinity
  for (const run of runs) {
    const start = startMsOfRun(run)
    const end = endMsOfRun(run)
    const distance = headMs >= start && headMs < end ? 0 : Math.min(Math.abs(headMs - start), Math.abs(headMs - end))
    if (distance < bestDistance) {
      best = run
      bestDistance = distance
    }
  }

  const startMs = startMsOfRun(best)
  const endMs = endMsOfRun(best)
  return endMs > startMs ? [startMs, endMs] : null
}
