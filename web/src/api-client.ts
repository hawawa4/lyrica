import type { Positions } from './score-engine'
import type { ImportTimelineResponse } from './types'

/** True when running inside the Tauri desktop webview, false in a plain browser tab. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Hands webmscore's measurePositions() output + raw saveMidi() bytes to the
 * Rust core, which builds and returns the flattened Timeline (see
 * crates/core/src/timeline.rs — Rust never parses .mscz/MIDI itself, it
 * receives already-exported data from this JS layer).
 *
 * Desktop-only for now (the axum server shell isn't built yet — Phase 2b).
 */
export async function importTimeline(
  positions: Positions,
  midiBytes: Uint8Array,
): Promise<ImportTimelineResponse> {
  if (!isTauri()) {
    throw new Error('importTimeline: no transport available outside the Tauri desktop shell yet')
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<ImportTimelineResponse>('import_timeline', {
    positions,
    midiBytes: Array.from(midiBytes),
  })
}

/**
 * Playback control. Desktop-only for now (see importTimeline's note — the
 * same transport gap applies here; web/server will stream synthesized PCM
 * to the Web Audio API instead, per IMPLEMENTATION_PLAN.md Phase 4, not yet
 * built).
 */
export async function loadMidi(midiBytes: Uint8Array): Promise<void> {
  if (!isTauri()) throw new Error('loadMidi: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('load_midi', { midiBytes: Array.from(midiBytes) })
}

export async function playMidi(playLoop: boolean): Promise<void> {
  if (!isTauri()) throw new Error('playMidi: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('play', { playLoop })
}

export async function stopMidi(): Promise<void> {
  if (!isTauri()) throw new Error('stopMidi: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('stop')
}

export async function setPlaybackSpeed(speed: number): Promise<void> {
  if (!isTauri()) throw new Error('setPlaybackSpeed: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_speed', { speed })
}

/** `region` is `[loop_start_ms, loop_end_ms]`; `null` clears the loop. */
export async function setLoopRegion(region: [number, number] | null): Promise<void> {
  if (!isTauri()) throw new Error('setLoopRegion: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_loop_region', { region })
}

export async function setMetronomeEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) throw new Error('setMetronomeEnabled: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_metronome_enabled', { enabled })
}

/** Current playback position in seconds, within the MIDI file's own 1.0x timeline. */
export async function getPlaybackPosition(): Promise<number> {
  if (!isTauri()) throw new Error('getPlaybackPosition: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<number>('playback_position')
}
