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
  const built: { focus: ReturnType<typeof vi.fn> }[] = []
  class FakeTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    focus = vi.fn()
    open = vi.fn()
    loadAddon = vi.fn()
    write = vi.fn()
    paste = vi.fn()
    selectAll = vi.fn()
    clearSelection = vi.fn()
    getSelection = (): string => ''
    hasSelection = (): boolean => false
    attachCustomKeyEventHandler = vi.fn()
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

beforeEach(() => {
  terminals.length = 0
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
    writeClipboard: () => {},
    readClipboard: () => '',
    pasteClipboardImage: () => Promise.resolve(null)
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
