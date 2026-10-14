export type Theme = 'light' | 'dark' | 'paper'

const THEMES: Theme[] = ['light', 'dark', 'paper']
const STORAGE_KEY = 'musepractice-theme'

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
