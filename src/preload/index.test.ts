import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, contract, type OrbitalApi } from '@shared/contract'

/**
 * The preload bridge through what it exposes: `window.orbital`. Electron's
 * side of the bridge is stood in for, so each call can be followed to the
 * channel it lands on.
 */
const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: unknown, payload: unknown) => void>>()
  return {
    listeners,
    exposed: {} as Record<string, unknown>,
    invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => 'reply'),
    send: vi.fn(),
    readText: vi.fn(() => 'clip'),
    writeText: vi.fn()
  }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      electron.exposed[key] = value
    }
  },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    on: (channel: string, fn: (e: unknown, payload: unknown) => void) => {
      if (!electron.listeners.has(channel)) electron.listeners.set(channel, new Set())
      electron.listeners.get(channel)!.add(fn)
    },
    removeListener: (channel: string, fn: (e: unknown, payload: unknown) => void) => {
      electron.listeners.get(channel)?.delete(fn)
    }
  },
  clipboard: { readText: electron.readText, writeText: electron.writeText }
}))

await import('./index')
const api = electron.exposed.orbital as OrbitalApi

beforeEach(() => {
  electron.invoke.mockClear()
  electron.send.mockClear()
})

describe('window.orbital', () => {
  it('has a function for every operation in the contract, and nothing else', () => {
    expect(Object.keys(api).sort()).toEqual(Object.keys(contract).sort())
    for (const fn of Object.values(api)) expect(typeof fn).toBe('function')
  })

  it('sends a request on its own channel with its arguments, and resolves with main\'s reply', async () => {
    await expect(api.gitDiff('wt-1', 'src/a.ts', true)).resolves.toBe('reply')
    expect(electron.invoke).toHaveBeenCalledWith(IPC.gitDiff, 'wt-1', 'src/a.ts', true)
    expect(electron.send).not.toHaveBeenCalled()
  })

  it('fires a one-way message without waiting for anything', () => {
    expect(api.terminalInput('tab-1', 'ls\r')).toBeUndefined()
    expect(electron.send).toHaveBeenCalledWith(IPC.terminalInput, 'tab-1', 'ls\r')
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('delivers a pushed event to its subscribers until they unsubscribe', () => {
    const seen: number[] = []
    const off = api.onZoomChanged((factor) => seen.push(factor))
    const push = (payload: number): void => {
      for (const fn of electron.listeners.get(IPC.evtZoomChanged) ?? []) fn({}, payload)
    }
    push(1.1)
    off()
    push(1.2)
    expect(seen).toEqual([1.1])
  })

  it('answers the clipboard operations itself, without a round trip to main', () => {
    expect(api.readClipboard()).toBe('clip')
    api.writeClipboard('copied')
    expect(electron.writeText).toHaveBeenCalledWith('copied')
    expect(electron.invoke).not.toHaveBeenCalled()
    expect(electron.send).not.toHaveBeenCalled()
  })
})
