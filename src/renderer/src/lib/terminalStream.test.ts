import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalDataEvent } from '@shared/types'
import { onTerminalData } from './terminalStream'

/**
 * One bridge subscription fanned out by tab id, opened for the first listener
 * and closed after the last — so N mounted terminals cost one ipcRenderer
 * listener, and a test that stubs the bridge per case gets a fresh one.
 */

let bridgeCbs: Set<(evt: TerminalDataEvent) => void>
let subscribeCalls: number

beforeEach(() => {
  bridgeCbs = new Set()
  subscribeCalls = 0
  vi.stubGlobal('orbital', {
    onTerminalData: (cb: (evt: TerminalDataEvent) => void) => {
      subscribeCalls++
      bridgeCbs.add(cb)
      return () => bridgeCbs.delete(cb)
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

const emit = (tabId: string, data: string): void => {
  for (const cb of [...bridgeCbs]) cb({ tabId, data, seq: data.length })
}

describe('terminalStream', () => {
  it('routes each event to the listeners of its tab only, over one bridge subscription', () => {
    const a: string[] = []
    const b: string[] = []
    const offA = onTerminalData('A', (e) => a.push(e.data))
    const offB = onTerminalData('B', (e) => b.push(e.data))
    expect(subscribeCalls).toBe(1)

    emit('A', 'hello')
    emit('B', 'world')
    emit('C', 'nobody')
    expect(a).toEqual(['hello'])
    expect(b).toEqual(['world'])

    offA()
    emit('A', 'after')
    expect(a).toEqual(['hello'])
    expect(bridgeCbs.size).toBe(1)

    offB()
    expect(bridgeCbs.size).toBe(0)
  })

  it('re-opens the bridge subscription for a listener added after the last one left', () => {
    const off1 = onTerminalData('A', () => {})
    off1()
    expect(bridgeCbs.size).toBe(0)
    const seen: string[] = []
    const off2 = onTerminalData('A', (e) => seen.push(e.data))
    expect(subscribeCalls).toBe(2)
    emit('A', 'again')
    expect(seen).toEqual(['again'])
    off2()
  })
})
