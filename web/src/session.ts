/**
 * What was open when the app last ran, so the next launch can bring it back:
 * the files (by path — they're re-read from disk) and where each one's
 * playback head sat. Browser storage is enough: it's a per-machine
 * convenience, and every access is allowed to fail.
 */
export interface SessionTab {
  path: string
  /** `.mscz`: the timeline measure (`TimelineEvent.measure_index`) the head is on. PDF: the index of the calibrated measure it's on. */
  position: number
}

export interface Session {
  tabs: SessionTab[]
  /** Path of the tab that was showing, if any. */
  activePath: string | null
}

const SESSION_KEY = 'lyrica.session'

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Session>
    const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs : []).filter(
      (t): t is SessionTab => !!t && typeof t.path === 'string' && Number.isFinite(t.position),
    )
    if (tabs.length === 0) return null
    return { tabs, activePath: typeof parsed.activePath === 'string' ? parsed.activePath : null }
  } catch {
    return null
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // storage unavailable — the session just won't be restored
  }
}

const WIDE_LAYOUT_KEY = 'lyrica.wideLayout'

/** Whether scores open on the wide page layout — the last choice made with the layout toggle. */
export function loadWideLayoutPref(): boolean {
  try {
    return localStorage.getItem(WIDE_LAYOUT_KEY) === '1'
  } catch {
    return false
  }
}

export function saveWideLayoutPref(wide: boolean): void {
  try {
    localStorage.setItem(WIDE_LAYOUT_KEY, wide ? '1' : '0')
  } catch {
    // storage unavailable — the choice just won't carry over to the next score
  }
}
