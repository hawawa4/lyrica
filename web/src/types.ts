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
