import { describe, expect, it } from 'vitest'
import { IPC, channelOf, contract } from './contract'

const entries = Object.entries(contract)
const ofKind = (kind: string): string[] => entries.filter(([, op]) => op.kind === kind).map(([name]) => name)

describe('the window contract', () => {
  it('gives every operation that crosses to main its own channel', () => {
    const crossing = entries.filter(([, op]) => op.kind !== 'local')
    const channels = Object.values(IPC)
    expect(channels).toHaveLength(crossing.length)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) expect(channel).toMatch(/^orbital:/)
  })

  it('names a request channel after the operation', () => {
    expect(IPC.gitStatus).toBe('orbital:gitStatus')
    expect(IPC.terminalInput).toBe('orbital:terminalInput')
    expect(IPC.checkForUpdates).toBe('orbital:checkForUpdates')
    for (const name of [...ofKind('invoke'), ...ofKind('send')]) {
      expect((IPC as Record<string, string>)[name]).toBe(`orbital:${name}`)
    }
  })

  it('names an event channel after what happened, not after its subscribe method', () => {
    expect(IPC.evtStateChanged).toBe('orbital:evt:stateChanged')
    expect(IPC.evtUpdateStatus).toBe('orbital:evt:updateStatus')
    for (const name of ofKind('event')) {
      expect(name).toMatch(/^on[A-Z]/)
      expect((IPC as Record<string, string>)[`evt${name.slice(2)}`]).toBe(channelOf(name, 'event'))
    }
  })

  it('keeps local operations off the wire', () => {
    expect(ofKind('local').sort()).toEqual(['readClipboard', 'writeClipboard'])
    for (const name of ofKind('local')) {
      expect(channelOf(name, 'local')).toBeNull()
      expect(IPC).not.toHaveProperty(name)
    }
  })

  it('can be walked: every entry declares one of the four kinds', () => {
    expect(entries.length).toBeGreaterThan(100)
    for (const [, op] of entries) expect(['invoke', 'send', 'event', 'local']).toContain(op.kind)
  })
})
