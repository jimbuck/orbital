// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The output path of TerminalManager: chunks are coalesced into one 'data'
 * event per tab per flush, a headless mirror keeps the terminal's state for
 * remounts, and a snapshot flushes what is pending first so a batch can never
 * straddle the snapshot's seq cut-point (the renderer replays queued batches
 * strictly past that point).
 *
 * node-pty is native and Electron-ABI; a fake IPty stands in and lets the
 * tests push output and observe resize calls.
 */

interface FakePty {
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number }) => void) => void
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emit: (data: string) => void
}

const hoisted = vi.hoisted(() => ({ ptys: [] as unknown[] }))

vi.mock('node-pty', () => ({
  spawn: (): unknown => {
    let dataCb: ((data: string) => void) | null = null
    const pty: FakePty = {
      onData: (cb) => {
        dataCb = cb
      },
      onExit: () => {},
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emit: (data) => dataCb?.(data)
    }
    hoisted.ptys.push(pty)
    return pty
  }
}))

import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { TerminalManager } from './terminals'

const lastPty = (): FakePty => hoisted.ptys[hoisted.ptys.length - 1] as FakePty

let tm: TerminalManager
let events: { tabId: string; data: string; seq: number }[]

beforeEach(() => {
  vi.useFakeTimers()
  hoisted.ptys.length = 0
  tm = new TerminalManager()
  events = []
  tm.on('data', (e) => events.push(e))
  tm.spawn({ tabId: 't1', cwd: '.', env: {}, cols: 100, rows: 30 })
})

afterEach(() => {
  tm.killAll()
  vi.useRealTimers()
})

/** A snapshot of the tab, once the mirror has parsed what it was sent (it parses on a timer). */
async function snapshotOf(tabId: string): Promise<Awaited<ReturnType<TerminalManager['buffer']>>> {
  const pending = tm.buffer(tabId)
  await vi.runAllTimersAsync()
  return pending
}

/** What a fresh terminal of the snapshot's size shows after being written the snapshot. */
async function restore(snapshot: { data: string; cols: number; rows: number }): Promise<HeadlessTerminal> {
  const term = new HeadlessTerminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true })
  const written = new Promise<void>((resolve) => term.write(snapshot.data, resolve))
  await vi.runAllTimersAsync()
  await written
  return term
}

const rowText = (term: HeadlessTerminal, row: number): string =>
  term.buffer.active.getLine(term.buffer.active.baseY + row - 1)?.translateToString(true) ?? ''

describe('TerminalManager output batching', () => {
  it('coalesces the chunks of one flush window into a single event carrying the last seq', () => {
    lastPty().emit('ab')
    lastPty().emit('cd')
    lastPty().emit('e')
    expect(events).toEqual([])
    vi.runOnlyPendingTimers()
    expect(events).toEqual([{ tabId: 't1', data: 'abcde', seq: 5 }])
  })

  it('flushes pending output before a replay snapshot so seqs line up with the cut-point', async () => {
    lastPty().emit('abc')
    const pending = tm.buffer('t1')
    // The pending batch went out first, with the seq the snapshot reports.
    expect(events).toEqual([{ tabId: 't1', data: 'abc', seq: 3 }])
    await vi.runAllTimersAsync()
    expect(await pending).toEqual({ data: 'abc', seq: 3, cols: 100, rows: 30 })
    // Output after the snapshot forms a fresh batch past the cut-point.
    lastPty().emit('de')
    vi.runOnlyPendingTimers()
    expect(events[1]).toEqual({ tabId: 't1', data: 'de', seq: 5 })
  })

  it('drops output still queued for a tab that is killed, so a respawn never inherits it', () => {
    lastPty().emit('stale')
    tm.kill('t1')
    vi.runOnlyPendingTimers()
    expect(events).toEqual([])
  })

})

describe('TerminalManager remount snapshot', () => {
  it('gives back what was drawn once and never touched again, however much output followed', async () => {
    // An agent CLI at work: its input box and status line are drawn once, then
    // only the spinner row is rewritten, in place, for a long time.
    lastPty().emit('\x1b[28;1H> type here\x1b[29;1H[status] model | branch')
    let ticks = 0
    for (let sent = 0; sent < 450_000; ticks++) {
      const frame = `\x1b[5;1H* Working... (${ticks} ticks)\x1b[K`
      lastPty().emit(frame)
      sent += frame.length
    }
    const snapshot = await snapshotOf('t1')
    expect(snapshot.seq).toBeGreaterThan(450_000)
    // The state, not the log: a screen's worth, not half a megabyte.
    expect(snapshot.data.length).toBeLessThan(5_000)

    const term = await restore(snapshot)
    expect(rowText(term, 5)).toBe(`* Working... (${ticks - 1} ticks)`)
    expect(rowText(term, 28)).toBe('> type here')
    expect(rowText(term, 29)).toBe('[status] model | branch')
    term.dispose()
  })

  it('puts the cursor back where the program left it', async () => {
    lastPty().emit('one\x1b[12;7H')
    const term = await restore(await snapshotOf('t1'))
    expect([term.buffer.active.cursorY + 1, term.buffer.active.cursorX + 1]).toEqual([12, 7])
    term.dispose()
  })

  it('keeps the scrollback above the screen', async () => {
    for (let i = 1; i <= 80; i++) lastPty().emit(`line ${i}\r\n`)
    const term = await restore(await snapshotOf('t1'))
    expect(term.buffer.active.baseY).toBeGreaterThan(0)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('line 1')
    term.dispose()
  })

  it('carries the modes a program set at startup, which a trimmed log would have lost', async () => {
    lastPty().emit('\x1b[?2004h\x1b[?1004h\x1b[?25l')
    const hidden = await snapshotOf('t1')
    const term = await restore(hidden)
    expect(term.modes.bracketedPasteMode).toBe(true)
    expect(term.modes.sendFocusMode).toBe(true)
    term.dispose()
    // The serializer has no word for a hidden cursor, so the manager adds it.
    expect(hidden.data.endsWith('\x1b[?25l')).toBe(true)

    lastPty().emit('\x1b[?25h')
    expect((await snapshotOf('t1')).data).not.toContain('\x1b[?25l')
  })

  it('restores a full-screen program on the alternate screen', async () => {
    lastPty().emit('shell prompt\x1b[?1049h\x1b[Heditor\x1b[10;1Hbody')
    const term = await restore(await snapshotOf('t1'))
    expect(term.buffer.active.type).toBe('alternate')
    expect(rowText(term, 1)).toBe('editor')
    expect(rowText(term, 10)).toBe('body')
    term.dispose()
  })

  it('does not hand back side effects to run a second time', async () => {
    // A clipboard write and a device query: replayed, the first would overwrite
    // the clipboard on every remount and the second would type an answer at the shell.
    lastPty().emit('before\x1b]52;c;aGVsbG8=\x07\x1b[c\x1b[6nafter')
    const { data } = await snapshotOf('t1')
    expect(data).toContain('beforeafter')
    expect(data).not.toContain('\x1b]52')
    expect(data).not.toContain('\x1b[c')
    expect(data).not.toContain('\x1b[6n')
  })

  it('reports the size the screen was drawn at, following a resize', async () => {
    expect(await snapshotOf('t1')).toMatchObject({ cols: 100, rows: 30 })
    tm.resize('t1', 140, 50)
    expect(await snapshotOf('t1')).toMatchObject({ cols: 140, rows: 50 })
  })

  it('returns a static notice as it is, with no screen size', async () => {
    tm.notify('t2', 'agent not found')
    expect(await tm.buffer('t2')).toEqual({ data: 'agent not found', seq: 15, cols: 0, rows: 0 })
  })

  it('answers empty for a tab it does not know', async () => {
    expect(await tm.buffer('nope')).toEqual({ data: '', seq: 0, cols: 0, rows: 0 })
  })

  it('settles a snapshot still waiting when the terminal is killed', async () => {
    lastPty().emit('abc')
    const pending = tm.buffer('t1')
    tm.kill('t1')
    expect(await pending).toEqual({ data: '', seq: 3, cols: 0, rows: 0 })
  })
})

describe('TerminalManager resize', () => {
  it('forwards only a changed size to the PTY', () => {
    tm.resize('t1', 100, 30)
    tm.resize('t1', 100, 30)
    expect(lastPty().resize).not.toHaveBeenCalled()
    tm.resize('t1', 120, 30)
    tm.resize('t1', 120, 30)
    expect(lastPty().resize).toHaveBeenCalledTimes(1)
    expect(lastPty().resize).toHaveBeenCalledWith(120, 30)
  })
})
