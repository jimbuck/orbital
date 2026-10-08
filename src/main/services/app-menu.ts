import { Menu } from 'electron'

/**
 * The native application menu, or null for none.
 *
 * Windows and Linux get none: the window is frameless and TitleBar draws the
 * File / Edit / View menus itself. macOS always has a menu bar, and it is where
 * the standard key equivalents live — without an Edit menu Cmd+C/V/X/A/Z do
 * nothing in inputs, and without the app menu there is no Cmd+Q or Cmd+H. So
 * macOS gets the stock roles and nothing more; Orbital's own commands stay in
 * TitleBar and the palette, the same on every platform.
 *
 * There is deliberately no View menu: its zoom and reload roles would shadow
 * the persisted zoom and the reload shortcut handled in `before-input-event`.
 */
export function applicationMenu(platform = process.platform): Menu | null {
  if (platform !== 'darwin') return null
  return Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
}
