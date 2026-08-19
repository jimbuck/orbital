import { describe, expect, it } from 'vitest'
import { decodeOsc52 } from './terminalClipboard'

/** base64 of a UTF-8 string, the way a TUI would encode an OSC 52 payload. */
function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

describe('decodeOsc52', () => {
  it('decodes a clipboard write', () => {
    expect(decodeOsc52(`c;${b64('hello from the TUI')}`)).toBe('hello from the TUI')
  })

  it('decodes multi-byte UTF-8 rather than mangling it into latin-1', () => {
    expect(decodeOsc52(`c;${b64('naïve — 🛰')}`)).toBe('naïve — 🛰')
  })

  it('accepts the primary selection and an empty (default) target list', () => {
    expect(decodeOsc52(`p;${b64('primary')}`)).toBe('primary')
    expect(decodeOsc52(`;${b64('default')}`)).toBe('default')
  })

  it('ignores cut buffers, which are not the system clipboard', () => {
    expect(decodeOsc52(`0;${b64('cut buffer')}`)).toBeNull()
  })

  it('ignores a read request instead of leaking the clipboard back to the program', () => {
    expect(decodeOsc52('c;?')).toBeNull()
  })

  it('ignores malformed base64 rather than throwing inside the parser', () => {
    expect(decodeOsc52('c;not base64!!')).toBeNull()
  })

  it('ignores a sequence with no payload separator, and an empty payload', () => {
    expect(decodeOsc52('c')).toBeNull()
    expect(decodeOsc52('c;')).toBeNull()
  })

  it('ignores an implausibly large payload', () => {
    expect(decodeOsc52(`c;${'A'.repeat(1_000_004)}`)).toBeNull()
  })
})
