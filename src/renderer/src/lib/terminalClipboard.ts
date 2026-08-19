/**
 * OSC 52 (`ESC ] 52 ; <targets> ; <base64> BEL`) is how a program running in the
 * terminal asks the terminal to put text on the SYSTEM clipboard. xterm.js
 * parses the sequence but ships no handler for it, so without one the copy is
 * silently dropped and the user sees nothing land on their clipboard.
 *
 * The decoding lives here, apart from the component, so it can be reasoned about
 * (and tested) without an xterm instance or a live PTY — it is the part with all
 * the judgement calls in it about what a terminal should refuse to write.
 */

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
