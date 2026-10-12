/** True when running inside the Tauri desktop webview, false in a plain browser tab. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
