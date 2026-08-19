/**
 * The two ways a terminal can ask for "copy this to the system clipboard", as
 * pure functions so they can be reasoned about (and tested) without an xterm
 * instance or a live PTY:
 *
 *  1. `terminalCopyIntent` — the keyboard shortcut, which is genuinely subtle in
 *     a terminal because Ctrl+C is overloaded: it is both the copy accelerator
 *     everywhere else in the OS and the only way to interrupt a running process.
 *  2. `decodeOsc52` — the escape sequence a TUI emits when IT wants to put text
 *     on the clipboard (`ESC ] 52 ; <targets> ; <base64> BEL`). xterm.js parses
 *     the sequence but has no built-in handler, so without this the copy is
 *     silently dropped and the user sees nothing land on their clipboard.
 */

/** What the custom key handler should do with a keydown. */
export type TerminalCopyIntent =
  /** There is a selection and the user asked for it — copy it and swallow the key. */
  | 'copy'
  /** Nothing for us to do — let xterm handle it (Ctrl+C then means SIGINT). */
  | 'passthrough'

/**
 * Decide whether a key event is asking to copy the terminal selection.
 *
 * The contract is a single rule: a copy shortcut only wins when there is
 * actually something to copy. `Ctrl+C`, `Ctrl+Shift+C` and `Meta+C` all copy
 * with a selection, and all pass through without one — because swallowing a key
 * we have no use for is strictly worse than letting the terminal have it. For
 * bare Ctrl+C that passthrough is load-bearing (it is the interrupt for a
 * runaway process), and for Ctrl+Shift+C it matters nearly as much: xterm's own
 * key mapping turns it into 0x03 too, so keeping it means a user who reaches for
 * the "safe" copy binding with nothing selected still interrupts, rather than
 * pressing a key that visibly does nothing. Meta+C off macOS maps to nothing at
 * all, so passing it through is simply a no-op.
 *
 * Since the copy path clears the selection afterwards, copy-then-interrupt is
 * just pressing the same combination twice.
 *
 * Meta+C is matched on every platform rather than behind a macOS guard, which is
 * deliberate: it mirrors how the neighbouring Ctrl/Cmd+V paste handler matches
 * its key, and the worst it can do off macOS is copy a selection the user
 * already made with Super+C — a combination the OS mostly swallows itself, and
 * which xterm would otherwise turn into nothing at all. A renderer-side platform
 * sniff would be more fragile than the behaviour it protects.
 *
 * `e.code` (not `e.key`) is used so the binding is keyboard-layout independent,
 * matching the Ctrl+V handling. Alt+Ctrl+C is left alone — TUIs bind it.
 */
export function terminalCopyIntent(e: KeyboardEvent, hasSelection: boolean): TerminalCopyIntent {
  if (e.type !== 'keydown' || e.code !== 'KeyC' || e.altKey) return 'passthrough'
  if (!e.ctrlKey && !e.metaKey) return 'passthrough'
  return hasSelection ? 'copy' : 'passthrough'
}

/**
 * Selection targets we are willing to write for. `c` is the clipboard and `p`
 * the primary selection; `s` means "whatever the terminal is configured to
 * use", which for us is the clipboard. Cut buffers (`0`-`7`) and the unknown
 * rest are ignored — they are not the system clipboard, and blindly treating
 * them as one would let a stray sequence stomp it. An empty target list means
 * `s0` per the xterm spec, so it counts as a clipboard write.
 */
const CLIPBOARD_TARGETS = new Set(['c', 'p', 's'])

/**
 * Upper bound on the base64 payload we will decode (~750 KB of text). xterm.js
 * already caps an OSC payload at 10 MB, but a multi-megabyte clipboard write is
 * far more likely to be a runaway program dumping its output than a user
 * copying something, and decoding it would block the renderer.
 */
const MAX_OSC52_PAYLOAD = 1_000_000

/**
 * Decode the body of an OSC 52 sequence (everything after `52;`) into the text
 * that should go on the clipboard, or `null` when nothing should be written.
 *
 * Returns `null` — rather than throwing — for every malformed or unwelcome
 * variant, because this runs inside the terminal's parser: anything that throws
 * there would be triggered by whatever bytes a program happened to emit.
 * Notably, `<targets>;?` is a clipboard *read* request, which we deliberately
 * decline: answering it would let any process running in the terminal exfiltrate
 * whatever the user last copied.
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';')
  if (sep === -1) return null

  const targets = data.slice(0, sep)
  if (targets && ![...targets].some((t) => CLIPBOARD_TARGETS.has(t))) return null

  const payload = data.slice(sep + 1)
  // '?' is a read request, and an empty payload is a clipboard *clear* we would
  // rather not honour — neither should overwrite what the user has copied.
  if (payload === '?' || payload === '') return null
  if (payload.length > MAX_OSC52_PAYLOAD) return null

  try {
    // atob yields one char per byte; the bytes are UTF-8, so re-decode them
    // rather than using the latin-1 string directly (else non-ASCII mojibakes).
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    // Malformed base64 — the sequence was truncated or was never a real copy.
    return null
  }
}
