import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { Tab } from '@shared/types'

/**
 * Every xterm Terminal built during a test, in construction order — which is the
 * order TerminalTab components mounted, so tests can say "the first pane's
 * terminal" without threading ids through the mock. Hoisted alongside the
 * vi.mock factory below, which runs before this module body.
 */
const { terminals, FakeTerminal } = vi.hoisted(() => {
  const built: FakeTerminal[] = []
  class FakeTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    /** What the user has selected here — drives has/getSelection like the real thing. */
    selection = ''
    focus = vi.fn()
    open = vi.fn()
    loadAddon = vi.fn()
    write = vi.fn()
    paste = vi.fn()
    selectAll = vi.fn()
    clearSelection = vi.fn(() => {
      this.selection = ''
    })
    getSelection = (): string => this.selection
    hasSelection = (): boolean => this.selection !== ''
    /** The handler TerminalTab installed, so tests can feed it key events. */
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    attachCustomKeyEventHandler = vi.fn((handler: (e: KeyboardEvent) => boolean) => {
      this.keyHandler = handler
    })
    /** Registered OSC handlers by ident, so tests can play a sequence at them. */
    oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>()
    parser = {
      registerOscHandler: vi.fn((ident: number, cb: (data: string) => boolean | Promise<boolean>) => {
        this.oscHandlers.set(ident, cb)
        return {
          dispose: (): void => {
            this.oscHandlers.delete(ident)
          }
        }
      })
    }
    onData = (): { dispose: () => void } => ({ dispose: () => {} })
    dispose = vi.fn()
    constructor() {
      built.push(this)
    }
  }
  return { terminals: built, FakeTerminal }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = (): void => {}
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    dispose = (): void => {}
  }
}))

import TerminalTab from './TerminalTab'

function makeTab(id: string): Tab {
  return { id, worktreeId: 'w1', paneId: 'pane1', type: 'terminal', status: 'idle', config: {} } as Tab
}

/** Let the post-commit microtask that releases the one-focus-per-flush claim run. */
async function nextFlush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

const writeClipboard = vi.fn()
/** The system clipboard's text half — empty by default, so paste falls to the image path. */
const readClipboard = vi.fn((): string => '')
/** The image half: resolves to a scratch PNG path, or null when there is no image either. */
const pasteClipboardImage = vi.fn((): Promise<string | null> => Promise.resolve(null))

/** Mount one terminal and hand back the fake xterm behind it. */
function mountTerminal(): (typeof terminals)[number] {
  render(<TerminalTab tab={makeTab('T1')} active />)
  return terminals[0]
}

/** Feed a key event to the handler TerminalTab attached; returns xterm's verdict. */
function press(
  term: (typeof terminals)[number],
  init: KeyboardEventInit
): { handled: boolean; event: KeyboardEvent } {
  // cancelable, like a real keydown — otherwise preventDefault() is a no-op
  // and `defaultPrevented` could never tell us whether we suppressed the key.
  const event = new KeyboardEvent('keydown', { code: 'KeyC', cancelable: true, ...init })
  const handled = term.keyHandler!(event)
  return { handled, event }
}

beforeEach(() => {
  terminals.length = 0
  writeClipboard.mockClear()
  // mockReset (not mockClear) so a test's mockReturnValue does not leak into the
  // next one — vi.fn(impl) restores that impl on reset.
  readClipboard.mockReset()
  pasteClipboardImage.mockReset()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = (): void => {}
      disconnect = (): void => {}
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  vi.stubGlobal('orbital', {
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
    terminalBuffer: () => Promise.resolve({ data: '', seq: 0 }),
    terminalInput: () => {},
    terminalResize: () => {},
    openExternal: () => {},
    createTab: () => {},
    writeClipboard,
    readClipboard,
    pasteClipboardImage
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TerminalTab auto-focus', () => {
  it('focuses a terminal that mounts active — a freshly opened tab is typeable', () => {
    render(<TerminalTab tab={makeTab('T1')} active />)
    expect(terminals[0].focus).toHaveBeenCalled()
  })

  it('does not focus a terminal that mounts hidden behind another tab', () => {
    render(<TerminalTab tab={makeTab('T1')} active={false} />)
    expect(terminals[0].focus).not.toHaveBeenCalled()
  })

  it('focuses when the tab becomes the active one', async () => {
    const { rerender } = render(<TerminalTab tab={makeTab('T1')} active={false} />)
    await nextFlush()
    rerender(<TerminalTab tab={makeTab('T1')} active />)
    expect(terminals[0].focus).toHaveBeenCalled()
  })

  it('gives focus to the first pane only when several mount active at once', () => {
    // App boot / worktree switch: every visible pane mounts in the same commit.
    render(
      <>
        <TerminalTab tab={makeTab('T1')} active />
        <TerminalTab tab={makeTab('T2')} active />
      </>
    )
    expect(terminals[0].focus).toHaveBeenCalled()
    expect(terminals[1].focus).not.toHaveBeenCalled()
  })

  it('leaves focus alone while the user is typing outside a terminal', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    render(<TerminalTab tab={makeTab('T1')} active />)

    expect(terminals[0].focus).not.toHaveBeenCalled()
    input.remove()
  })
})

describe('TerminalTab copy', () => {
  it('copies the selection on Ctrl+C and keeps the key from reaching the PTY', () => {
    const term = mountTerminal()
    term.selection = 'selected output'

    const { handled, event } = press(term, { ctrlKey: true })

    expect(writeClipboard).toHaveBeenCalledWith('selected output')
    expect(handled).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    // Consistent with right-click copy: the selection is dropped, so the very
    // next Ctrl+C interrupts instead of copying the same text again.
    expect(term.clearSelection).toHaveBeenCalled()
  })

  it('lets Ctrl+C through when nothing is selected, so it still interrupts', () => {
    const term = mountTerminal()

    const { handled, event } = press(term, { ctrlKey: true })

    expect(writeClipboard).not.toHaveBeenCalled()
    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  it('passes Ctrl+Shift+C through even with a selection — Ctrl+C is the only copy', () => {
    // A deliberate narrowing: one copy shortcut instead of three. Nothing is
    // lost, because xterm maps Ctrl+Shift+C to 0x03 too, so it stays an interrupt.
    const term = mountTerminal()
    term.selection = 'selected output'

    const { handled, event } = press(term, { ctrlKey: true, shiftKey: true })

    expect(writeClipboard).not.toHaveBeenCalled()
    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  it('passes Meta+C through even with a selection, so Cmd+C does not copy', () => {
    // Also deliberate: Orbital is a Windows cockpit, so the macOS accelerator is
    // not worth a second binding on the one key that also has to mean SIGINT.
    const term = mountTerminal()
    term.selection = 'selected output'

    const { handled, event } = press(term, { metaKey: true })

    expect(writeClipboard).not.toHaveBeenCalled()
    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  it('interrupts on the second Ctrl+C, because the copy cleared the selection', () => {
    // The whole point of the feature: copy, then immediately kill the process
    // with the same key, without having to reach for the mouse in between.
    const term = mountTerminal()
    term.selection = 'selected output'

    expect(press(term, { ctrlKey: true }).handled).toBe(false)
    expect(writeClipboard).toHaveBeenCalledWith('selected output')

    const second = press(term, { ctrlKey: true })

    expect(second.handled).toBe(true)
    expect(second.event.defaultPrevented).toBe(false)
    expect(writeClipboard).toHaveBeenCalledTimes(1)
  })

  it('leaves ordinary keys alone so they reach the PTY', () => {
    const term = mountTerminal()
    term.selection = 'selected output'

    // Ctrl+D (EOF) and a bare arrow key: neither is ours, both must pass.
    expect(press(term, { ctrlKey: true, code: 'KeyD' }).handled).toBe(true)
    expect(press(term, { code: 'ArrowUp' }).handled).toBe(true)
    expect(term.paste).not.toHaveBeenCalled()
    expect(writeClipboard).not.toHaveBeenCalled()
  })
})

describe('TerminalTab paste', () => {
  it('pastes clipboard text on Ctrl+V and keeps the key from reaching the PTY', () => {
    const term = mountTerminal()
    readClipboard.mockReturnValue('pasted text')

    const { handled, event } = press(term, { ctrlKey: true, code: 'KeyV' })

    // Via term.paste so bracketed-paste mode is honoured; suppressed so xterm
    // does not also send a literal 'v' after us.
    expect(term.paste).toHaveBeenCalledWith('pasted text')
    expect(handled).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('pastes on Ctrl+Shift+V, the terminal-standard binding', () => {
    const term = mountTerminal()
    readClipboard.mockReturnValue('pasted text')

    expect(press(term, { ctrlKey: true, shiftKey: true, code: 'KeyV' }).handled).toBe(false)
    expect(term.paste).toHaveBeenCalledWith('pasted text')
  })

  it('pastes a saved image path when the clipboard holds a screenshot and no text', async () => {
    const term = mountTerminal()
    pasteClipboardImage.mockResolvedValue('C:/scratch/shot.png')

    press(term, { ctrlKey: true, code: 'KeyV' })
    await nextFlush()

    expect(term.paste).toHaveBeenCalledWith('C:/scratch/shot.png')
  })

  it('quotes an image path with spaces, so an agent CLI reads it as one argument', async () => {
    const term = mountTerminal()
    pasteClipboardImage.mockResolvedValue('C:/my scratch/shot.png')

    press(term, { ctrlKey: true, code: 'KeyV' })
    await nextFlush()

    expect(term.paste).toHaveBeenCalledWith('"C:/my scratch/shot.png"')
  })

  it('pastes nothing when the clipboard holds neither text nor an image', async () => {
    const term = mountTerminal()

    press(term, { ctrlKey: true, code: 'KeyV' })
    await nextFlush()

    expect(term.paste).not.toHaveBeenCalled()
  })
})

describe('TerminalTab right-click', () => {
  /** Mount with the given selection live, then right-click the terminal surface. */
  function rightClick(selection: string): {
    term: (typeof terminals)[number]
    event: MouseEvent
  } {
    const { container } = render(<TerminalTab tab={makeTab('T1')} active />)
    const term = terminals[0]
    term.selection = selection
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    container.firstElementChild!.dispatchEvent(event)
    return { term, event }
  }

  it('pastes even when a selection is live, rather than silently copying it', () => {
    // The regression this simplification exists to prevent: right-click used to
    // copy whenever anything was selected, so a paste the user asked for would
    // vanish — and overwrite their clipboard on the way out.
    readClipboard.mockReturnValue('pasted text')

    const { term } = rightClick('a stray selection')

    expect(term.paste).toHaveBeenCalledWith('pasted text')
    expect(writeClipboard).not.toHaveBeenCalled()
    expect(term.clearSelection).not.toHaveBeenCalled()
  })

  it('pastes with nothing selected', () => {
    readClipboard.mockReturnValue('pasted text')

    const { term } = rightClick('')

    expect(term.paste).toHaveBeenCalledWith('pasted text')
  })

  it('suppresses the browser context menu', () => {
    const { event } = rightClick('')

    expect(event.defaultPrevented).toBe(true)
  })
})

describe('TerminalTab OSC 52', () => {
  /** Mount, then play an OSC 52 body (everything after `52;`) at the parser. */
  function emit(body: string): boolean | Promise<boolean> {
    render(<TerminalTab tab={makeTab('T1')} active />)
    const handler = terminals[0].oscHandlers.get(52)
    expect(handler).toBeDefined()
    return handler!(body)
  }

  it('writes the decoded payload to the system clipboard', () => {
    // What a TUI emits for `ESC ] 52 ; c ; <base64> BEL`.
    expect(emit(`c;${btoa('copied by the agent')}`)).toBe(true)
    expect(writeClipboard).toHaveBeenCalledWith('copied by the agent')
  })

  it('ignores a clipboard read request without throwing', () => {
    expect(() => emit('c;?')).not.toThrow()
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it('ignores malformed base64 without throwing', () => {
    expect(() => emit('c;$$ not base64 $$')).not.toThrow()
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it('unregisters the handler on unmount', () => {
    const { unmount } = render(<TerminalTab tab={makeTab('T1')} active />)
    expect(terminals[0].oscHandlers.has(52)).toBe(true)
    unmount()
    expect(terminals[0].oscHandlers.has(52)).toBe(false)
  })
})
