// TS mirrors of crates/core::api structs (serde field names, i.e. snake_case
// as Rust sends them — no camelCase conversion is configured on the Rust side).

export interface Rect {
  x: number
  y: number
  sx: number
  sy: number
}

export interface TimelineEvent {
  measure_index: number
  source_elid: number
  time_ms: number
  page: number
  bbox: Rect
}

export interface Timeline {
  events: TimelineEvent[]
  duration_ms: number
  tempo_map: [number, number][]
}

export interface ImportTimelineResponse {
  timeline: Timeline
}

export type MarkerKind = 'text' | 'fingering'

/** A spot on a page: 0-based page index plus x/y as a 0-1 fraction of that page's width/height. */
export interface MarkerPosition {
  page: number
  x: number
  y: number
}

export interface Marker {
  id: string
  kind: MarkerKind
  /** Legacy anchor, only on markers created before `position` existed. */
  measure_index?: number
  position?: MarkerPosition
  /** For `fingering`, only the digits 1-5, drawn stacked top to bottom in this order. */
  text: string
  created_at: number
}

export interface Piece {
  start_measure_index: number
  title: string
}

export interface RecentFile {
  path: string
  file_hash: string
  last_opened: number
  title: string
}

export interface LibrarySettings {
  root_folder: string | null
}

export interface PinnedFile {
  path: string
  file_hash: string
  title: string
}

export interface LibraryEntry {
  path: string
  title: string
  is_dir: boolean
}

/** 1 = never seen it before, 5 = mastered, can play it at any time. `null`/absent means unrated. */
export type KnowledgeLevel = 1 | 2 | 3 | 4 | 5

export interface CalibrationPoint {
  page: number
  x: number
  y: number
  time_ms: number
  measure: number
}

/** One detected staff and its candidate barline x-positions — suggestions only, see crates/cv-barline. */
export interface StaffSystem {
  top: number
  bottom: number
  barline_xs: number[]
}

/** Mirrors `mp_core::updater::UpdateInfo`. */
export interface UpdateInfo {
  current: string
  latest: string
  available: boolean
  page_url: string
  /** How this copy was installed, which decides how an update is applied. */
  kind: 'appimage' | 'deb' | 'binary' | 'unsupported'
  /** Whether the app can apply the update itself; `reason` says why not otherwise (the release page is then the way to update). */
  can_install: boolean
  reason: string | null
}

/** Mirrors `mp_core::updater::Progress`. `done`/`total` are bytes while downloading (`total` is 0 when unknown). */
export interface UpdateProgress {
  phase: 'downloading' | 'installing' | 'done'
  done: number
  total: number
}
