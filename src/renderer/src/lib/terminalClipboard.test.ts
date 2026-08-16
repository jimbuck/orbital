import { describe, expect, it } from 'vitest'
import { decodeOsc52, terminalCopyIntent } from './terminalClipboard'

/** A minimal stand-in for the KeyboardEvent fields the intent check reads. */
function key(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    code: 'KeyC',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over
  } as KeyboardEvent
}

/** base64 of a UTF-8 string, the way a TUI would encode an OSC 52 payload. */
function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

describe('terminalCopyIntent', () => {
  it('copies on Ctrl+C when there is a selection', () => {
    expect(terminalCopyIntent(key({ ctrlKey: true }), true)).toBe('copy')
  })

  it('passes Ctrl+C through with no selection, so it still interrupts', () => {
    expect(terminalCopyIntent(key({ ctrlKey: true }), false)).toBe('passthrough')
  })

  it('copies on Ctrl+Shift+C when there is a selection', () => {
    expect(terminalCopyIntent(key({ ctrlKey: true, shiftKey: true }), true)).toBe('copy')
  })

  it('passes Ctrl+Shift+C through with no selection, rather than swallowing the key', () => {
    // xterm maps it to 0x03 as well, so this stays an interrupt instead of
    // becoming a shortcut that visibly does nothing.
    expect(terminalCopyIntent(key({ ctrlKey: true, shiftKey: true }), false)).toBe('passthrough')
  })

  it('copies on Meta+C with a selection, on every platform (no macOS guard)', () => {
    expect(terminalCopyIntent(key({ metaKey: true }), true)).toBe('copy')
  })

  it('passes Meta+C through with no selection', () => {
    expect(terminalCopyIntent(key({ metaKey: true }), false)).toBe('passthrough')
  })

  it('ignores Alt+Ctrl+C, which TUIs bind themselves', () => {
    expect(terminalCopyIntent(key({ ctrlKey: true, altKey: true }), true)).toBe('passthrough')
  })

  it('ignores an unmodified C, keyup, and other keys', () => {
    expect(terminalCopyIntent(key(), true)).toBe('passthrough')
    expect(terminalCopyIntent(key({ ctrlKey: true, type: 'keyup' }), true)).toBe('passthrough')
    expect(terminalCopyIntent(key({ ctrlKey: true, code: 'KeyV' }), true)).toBe('passthrough')
  })
})

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
