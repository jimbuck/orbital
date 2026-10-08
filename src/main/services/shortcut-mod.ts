import type { Input } from 'electron'

/**
 * Whether the platform's primary shortcut modifier — and only that one of the
 * Ctrl/Cmd pair — is held: Cmd on macOS, Ctrl everywhere else.
 *
 * On macOS Ctrl stays with the terminal (Ctrl+C interrupts, Ctrl+P is shell
 * history), so the app's own chords move to Cmd, the way every Mac app does it.
 * The other of the pair must be up, so Ctrl+Cmd chords stay free for the OS.
 */
export function primaryModHeld(input: Pick<Input, 'control' | 'meta'>, platform = process.platform): boolean {
  return platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
}
