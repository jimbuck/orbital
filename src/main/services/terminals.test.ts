import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The output path of TerminalManager: chunks are coalesced into one 'data'
 * event per tab per flush, the scrollback ring trims by whole chunks, and a
 * replay snapshot flushes what is pending first so a batch can never straddle
 * the snapshot's seq cut-point (the renderer replays queued batches strictly
 * past that point).
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

describe('TerminalManager output batching', () => {
  it('coalesces the chunks of one flush window into a single event carrying the last seq', () => {
    lastPty().emit('ab')
    lastPty().emit('cd')
    lastPty().emit('e')
    expect(events).toEqual([])
    vi.runOnlyPendingTimers()
    expect(events).toEqual([{ tabId: 't1', data: 'abcde', seq: 5 }])
  })

  it('flushes pending output before a replay snapshot so seqs line up with the cut-point', () => {
    lastPty().emit('abc')
    const snapshot = tm.buffer('t1')
    // The pending batch went out first, with the seq the snapshot reports.
    expect(events).toEqual([{ tabId: 't1', data: 'abc', seq: 3 }])
    expect(snapshot).toEqual({ data: 'abc', seq: 3 })
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

  it('keeps about the cap of scrollback by dropping whole leading chunks', () => {
    const chunk = 'x'.repeat(100_000)
    for (let i = 0; i < 5; i++) lastPty().emit(chunk)
    const { data, seq } = tm.buffer('t1')
    expect(seq).toBe(500_000)
    expect(data.length).toBe(200_000)
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
