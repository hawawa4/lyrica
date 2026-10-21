export type Theme = 'light' | 'dark' | 'paper'

const THEMES: Theme[] = ['light', 'dark', 'paper']
const STORAGE_KEY = 'lyrica-theme'

function isTheme(value: string | null): value is Theme {
  return THEMES.includes(value as Theme)
}

/** Reads the persisted theme (if any), falling back to 'light'. Call once at startup before first paint. */
export function initTheme(): Theme {
  let theme: Theme = 'light'
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isTheme(stored)) theme = stored
  } catch {
    // localStorage unavailable (private browsing etc.) — default stands.
  }
  applyTheme(theme)
  return theme
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Best-effort persistence only.
  }
}

export function getTheme(): Theme {
  const current = document.documentElement.getAttribute('data-theme')
  return isTheme(current) ? current : 'light'
}

export const THEME_LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  paper: 'Paper',
}

const SVG_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'

export const THEME_ICONS: Record<Theme, string> = {
  light: `${SVG_OPEN}<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  dark: `${SVG_OPEN}<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
  paper: `${SVG_OPEN}<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>`,
}
