import type { Positions } from './score-engine'
import type { CalibrationPoint, ImportTimelineResponse, Marker, Piece, RecentFile, StaffSystem } from './types'

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

interface OpenFileResponse {
  file_hash: string
  mscz_version: string
  needs_upgrade: boolean
}

/**
 * Computes a stable per-file identity key (blake3 hash of the original
 * bytes) via Rust's `open_file` command — used to key markers independent
 * of filename/path (so a marker survives the file being renamed/moved) and
 * of any MS4-upgrade round-trip (`main.ts` always passes the *original*,
 * pre-upgrade bytes here, never the upgraded re-save).
 *
 * Deliberately not computed via Web Crypto (`crypto.subtle.digest`)
 * client-side: that API is only available in a "secure context," which
 * isn't guaranteed for every webview scheme Tauri might load from, and a
 * failure there silently aborted the entire post-open setup (including
 * enabling playback) since nothing caught it. Rust's blake3 hashing has no
 * such environment dependency.
 */
export async function contentHash(bytes: Uint8Array, originalFilename: string): Promise<string> {
  if (!isTauri()) throw new Error('contentHash: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  const response = await invoke<OpenFileResponse>('open_file', {
    bytes: Array.from(bytes),
    originalFilename,
  })
  return response.file_hash
}

/**
 * Markers CRUD, keyed by `contentHash`'s digest of the original file bytes.
 * Desktop-only for now, same transport gap as the rest of this file.
 */
export async function listMarkers(fileHash: string): Promise<Marker[]> {
  if (!isTauri()) throw new Error('listMarkers: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<Marker[]>('list_markers', { fileHash })
}

export async function addMarker(fileHash: string, measureIndex: number, text: string): Promise<Marker[]> {
  if (!isTauri()) throw new Error('addMarker: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<Marker[]>('add_marker', { fileHash, measureIndex, text })
}

export async function deleteMarker(fileHash: string, markerId: string): Promise<Marker[]> {
  if (!isTauri()) throw new Error('deleteMarker: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<Marker[]>('delete_marker', { fileHash, markerId })
}

/**
 * Detects piece boundaries within a single .mscz file (see
 * crates/core/src/pieces.rs's module docs for why this needs the raw file
 * bytes rather than anything webmscore's JS API exposes). A result with 0 or
 * 1 entries means "not actually multi-piece" — callers should treat that as
 * no boundaries worth showing.
 */
export async function detectPieces(bytes: Uint8Array): Promise<Piece[]> {
  if (!isTauri()) throw new Error('detectPieces: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<Piece[]>('detect_pieces', { bytes: Array.from(bytes) })
}

/** Current playback position in seconds, within the MIDI file's own 1.0x timeline. */
export async function getPlaybackPosition(): Promise<number> {
  if (!isTauri()) throw new Error('getPlaybackPosition: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<number>('playback_position')
}

/**
 * Recent-files list, for reopening a past file after restarting the app.
 * Desktop-only: "path" is meaningless for a future web/server shell, where
 * files arrive as uploaded bytes with no on-disk location.
 */
export async function listRecentFiles(): Promise<RecentFile[]> {
  if (!isTauri()) throw new Error('listRecentFiles: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<RecentFile[]>('list_recent_files')
}

/** Records a file as just-opened; `path` is the real on-disk path (not just a filename). */
export async function recordRecentFile(path: string, fileHash: string, title: string): Promise<RecentFile[]> {
  if (!isTauri()) throw new Error('recordRecentFile: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<RecentFile[]>('record_recent_file', { path, fileHash, title })
}

/**
 * PDF mode (Phase 9): stable content-hash key for a PDF's bytes, same blake3
 * scheme `contentHash`/`open_file` use for `.mscz` (see Rust's
 * `api::hash_bytes` docs for why PDFs need a separate command rather than
 * reusing `open_file` itself — no MuseScore-version concept to sniff).
 */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (!isTauri()) throw new Error('hashBytes: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('hash_bytes', { bytes: Array.from(bytes) })
}

export async function listCalibrationPoints(fileHash: string): Promise<CalibrationPoint[]> {
  if (!isTauri()) throw new Error('listCalibrationPoints: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<CalibrationPoint[]>('list_calibration_points', { fileHash })
}

/** Replaces the full point list (there's no incremental id-based CRUD — see pdf_calibration.rs's docs). */
export async function saveCalibrationPoints(fileHash: string, points: CalibrationPoint[]): Promise<CalibrationPoint[]> {
  if (!isTauri()) throw new Error('saveCalibrationPoints: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<CalibrationPoint[]>('save_calibration_points', { fileHash, points })
}

/**
 * Loads a calibration-derived tempo map for metronome-only "playback" (no
 * note data — see Rust's `Player::load_tempo_map` docs). Derives the tempo
 * map server-side (`pdf_tempo_map` needs `numerator` for bar-accent
 * tracking, not just the simplified `(time_ms, qpm)` pairs the rest of the
 * app's `Timeline.tempo_map` uses) and loads it in one call.
 */
export async function loadPdfTempoMap(points: CalibrationPoint[], numerator: number, durationMs: number): Promise<void> {
  if (!isTauri()) throw new Error('loadPdfTempoMap: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  const tempoMap = await invoke<{ time_ms: number; qpm: number; numerator: number }[]>('pdf_tempo_map', {
    points,
    numerator,
  })
  await invoke('load_tempo_map', { tempoMap, durationMs })
}

/**
 * Optional CV barline-detection assist (see crates/cv-barline's module
 * docs). Takes a rendered page's PNG bytes (via pdf-engine.ts's
 * `canvasToPngBytes`) and returns candidate barline x-positions per
 * detected staff system — suggestions only; the caller renders them as
 * adjustable/dismissable markers the user must confirm before they become
 * real calibration points.
 */
export async function detectBarlines(pngBytes: Uint8Array): Promise<StaffSystem[]> {
  if (!isTauri()) throw new Error('detectBarlines: desktop-only for now')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<StaffSystem[]>('detect_barlines', { pngBytes: Array.from(pngBytes) })
}
