import './theme.css'
import './app.css'
import './components.css'
import { isTauri } from './api-client'
import { LibraryView } from './views/LibraryView'
import { PracticeView } from './views/PracticeView'
import { loadSession } from './session'

/**
 * Two-screen app: a hash router (`#/library` / `#/practice`) toggling which
 * top-level view is mounted into `#app`'s parent. No route params — "which
 * file is open" lives entirely in `PracticeView`'s own in-memory tab state,
 * not the URL, so navigating back and forth never re-derives it.
 */
type Route = 'library' | 'practice'

const container = document.querySelector<HTMLDivElement>('#app-container') ?? document.body

const libraryView = new LibraryView(container)
const practiceView = new PracticeView(container)

// Narrower than a full `refresh()`: opening a file can only ever change the
// recent-files list (bump an entry's recency), never the scan results or
// pinned list, so there's no reason to pay for another uncached recursive
// library rescan on top of the one `render()` already does on route change.
practiceView.onFileOpened(() => void libraryView.refreshRecentOnly())

libraryView.onOpen((path) => {
  void openFromLibrary(path)
})

async function openFromLibrary(path: string): Promise<void> {
  if (!isTauri()) return // LibraryView only ever offers rows to open when running under Tauri; this mirrors that guard rather than assuming it
  // Switch first, so the practice view's loading overlay is what the user
  // sees while a big score loads, not a library view that looks like it
  // ignored the click.
  location.hash = '#/practice'
  await practiceView.openPath(path)
}

libraryView.onBackToSheets(() => {
  location.hash = '#/practice'
})

function currentRoute(): Route {
  return location.hash === '#/practice' ? 'practice' : 'library'
}

function render(): void {
  const route = currentRoute()
  libraryView.root.style.display = route === 'library' ? '' : 'none'
  practiceView.setVisible(route === 'practice')
  if (route === 'library') {
    libraryView.setBackToSheetsVisible(practiceView.hasTabs())
    void libraryView.refresh()
  }
}

window.addEventListener('hashchange', render)
// A fresh launch goes back to the sheets that were open last time (desktop
// only — they're re-read from disk by path), else to the library.
const previousSession = !location.hash && isTauri() ? loadSession() : null
if (!location.hash) location.hash = previousSession ? '#/practice' : '#/library'
render()
if (previousSession) {
  void practiceView.restoreSession(previousSession).then((restored) => {
    if (restored === 0) location.hash = '#/library'
  })
}


