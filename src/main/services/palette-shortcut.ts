import type { Input } from 'electron'

/**
 * The command-palette keyboard shortcut, recognised in the main process.
 *
 * It lives here rather than in a renderer keydown listener because xterm claims
 * every keystroke while a terminal has focus — and a terminal is where the user
 * usually is. Main sees the input first (`before-input-event`), so the palette
 * opens from anywhere.
 *
 * Returns the prefix the palette should open with, or null when the input is
 * not the shortcut:
 *
 *  - `Ctrl+Shift+P` → `'>'`, the commands view, matching the editor convention.
 *  - `Ctrl+Shift+O` → `''`, the mixed view that leads with file search. It
 *    stands in for the usual `Ctrl+P`, which stays with readline so shell
 *    history keeps working in every terminal tab.
 *
 * Matching is on `code` (physical key) rather than `key`, so a non-US layout
 * still triggers it, and AltGr combinations are excluded along with Alt/Meta.
 */
export function paletteShortcutPrefix(input: Input): string | null {
  if (input.type !== 'keyDown' || !input.control || !input.shift || input.alt || input.meta) return null
  if (input.code === 'KeyP') return '>'
  if (input.code === 'KeyO') return ''
  return null
}
