/**
 * The host OS, as the renderer sees it. Read from `navigator.platform` rather
 * than over IPC: it is synchronous, available before the first render, and in
 * Electron it reports the real OS ('MacIntel', 'Win32', 'Linux x86_64').
 */
const platform = typeof navigator !== 'undefined' ? navigator.platform : ''
export const isMac = /^Mac/i.test(platform)
export const isLinux = /Linux/i.test(platform)
/** Windows is the default, so an unknown platform (a test DOM) reads as it. */
export const isWindows = !isMac && !isLinux

/** What this OS calls its file manager, for "Open in …" labels. */
export const fileManagerName = isMac ? 'Finder' : isLinux ? 'File Manager' : 'File Explorer'

/**
 * Whether the platform's primary shortcut modifier — and only that one of the
 * Ctrl/Cmd pair — is held: Cmd on macOS, Ctrl elsewhere. The renderer twin of
 * main's `primaryModHeld`.
 */
export function primaryMod(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>, mac = isMac): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/**
 * A shortcut hint for display, written with Windows/Linux names. On macOS
 * `Ctrl` becomes `⌘`, `Shift` `⇧` and `Alt` `⌥`, and the separators go, the
 * way Mac menus print them: 'Ctrl Shift P' → '⌘⇧P', 'Ctrl+Alt+Enter' → '⌘⌥Enter'.
 */
export function shortcutLabel(hint: string, mac = isMac): string {
  if (!mac) return hint
  return hint
    .replace(/\bCtrl\b[+ ]?/g, '⌘')
    .replace(/\bShift\b[+ ]?/g, '⇧')
    .replace(/\bAlt\b[+ ]?/g, '⌥')
}
