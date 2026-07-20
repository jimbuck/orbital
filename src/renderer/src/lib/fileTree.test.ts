import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, useEffect, useState } from 'react'
import type { FileNode } from '@shared/types'
import {
  acquireFileTree,
  useFileTree,
  __setFileTreeBridge,
  __setFileTreeDebounce,
  __resetFileTreeRegistry
} from './fileTree'

/** A fake IPC bridge that records fileTree calls and lets tests fire state changes. */
function makeBridge() {
  const listeners = new Set<() => void>()
  const calls: string[] = []
  let tree: FileNode[] = []
  return {
    bridge: {
      fileTree: async (id: string): Promise<FileNode[]> => {
        calls.push(id)
        return tree
      },
      onStateChanged: (cb: () => void): (() => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    calls,
    listeners,
    emit: (): void => {
      for (const l of [...listeners]) l()
    },
    setTree: (t: FileNode[]): void => {
      tree = t
    }
  }
}

/** A fake bridge whose fileTree calls stay pending until `resolveAll` is called. */
function makeDeferredBridge() {
  const listeners = new Set<() => void>()
  const calls: string[] = []
  let pending: Array<() => void> = []
  let tree: FileNode[] = []
  return {
    bridge: {
      fileTree: (id: string): Promise<FileNode[]> => {
        calls.push(id)
        return new Promise<FileNode[]>((resolve) => pending.push(() => resolve(tree)))
      },
      onStateChanged: (cb: () => void): (() => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    calls,
    emit: (): void => {
      for (const l of [...listeners]) l()
    },
    resolveAll: (): void => {
      const p = pending
      pending = []
      for (const r of p) r()
    }
  }
}

/** Flush pending microtasks + a zero-delay debounce timer. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('fileTree registry', () => {
  beforeEach(() => {
    __resetFileTreeRegistry()
    __setFileTreeDebounce(0)
  })
  afterEach(() => {
    __setFileTreeBridge(null)
    __resetFileTreeRegistry()
  })

  it('dedupes the subscription and refetch across editors of one worktree (#2)', async () => {
    const b = makeBridge()
    __setFileTreeBridge(b.bridge)

    const h1 = acquireFileTree('w1', () => {})
    h1.setActive(true)
    const h2 = acquireFileTree('w1', () => {})
    h2.setActive(true)
    await tick()

    // One shared onStateChanged listener and a single initial fetch, not one per tab.
    expect(b.listeners.size).toBe(1)
    expect(b.calls.length).toBe(1)

    b.emit()
    await tick()
    await tick()

    // A state change triggers exactly one refetch for the shared entry.
    expect(b.calls).toEqual(['w1', 'w1'])

    h1.release()
    h2.release()
    expect(b.listeners.size).toBe(0)
    expect(b.calls.length).toBe(2)
  })

  it('does not refetch on state changes while every consumer is hidden (#1)', async () => {
    const b = makeBridge()
    __setFileTreeBridge(b.bridge)

    const h = acquireFileTree('w2', () => {}) // never activated → hidden
    await tick()
    expect(b.calls.length).toBe(0) // no background fetch while hidden and never shown

    b.emit()
    await tick()
    await tick()
    expect(b.calls.length).toBe(0) // state change is ignored while hidden

    h.release()
  })

  it('refetches once when a stale hidden editor is revealed (#1)', async () => {
    const b = makeBridge()
    __setFileTreeBridge(b.bridge)

    const h = acquireFileTree('w3', () => {})
    b.emit() // change arrives while hidden → marked dirty, no fetch
    await tick()
    expect(b.calls.length).toBe(0)

    h.setActive(true) // reveal
    await tick()
    expect(b.calls.length).toBe(1)

    h.release()
  })

  it('forces an immediate refetch on manual refresh', async () => {
    const b = makeBridge()
    __setFileTreeBridge(b.bridge)

    const h = acquireFileTree('w4', () => {})
    h.setActive(true)
    await tick()
    expect(b.calls.length).toBe(1)

    h.refresh()
    await tick()
    expect(b.calls.length).toBe(2)

    h.release()
  })

  it('chases a state change that arrives during an in-flight fetch', async () => {
    const b = makeDeferredBridge()
    __setFileTreeBridge(b.bridge)

    const h = acquireFileTree('w6', () => {})
    h.setActive(true) // first fetch starts and stays in flight
    await tick()
    expect(b.calls.length).toBe(1)

    b.emit() // state change while the fetch is in flight → entry re-dirtied
    await tick() // debounce timer fires but bails (fetch still in flight)
    expect(b.calls.length).toBe(1)

    b.resolveAll() // fetch completes → dirty is still set, so it chases
    await tick()
    await tick()
    expect(b.calls.length).toBe(2)

    b.resolveAll()
    h.release()
  })

  it('loads the tree when worktreeId resolves after mount while active stays true', async () => {
    const b = makeBridge()
    __setFileTreeBridge(b.bridge)

    // A visible editor whose worktree id is not known until after first render.
    function Harness(): null {
      const [id, setId] = useState<string | undefined>(undefined)
      useFileTree(id, true) // active is true the whole time and never changes
      useEffect(() => {
        setId('w7')
      }, [])
      return null
    }

    await act(async () => {
      render(createElement(Harness))
    })
    await act(async () => {
      await tick()
    })

    // The reacquired handle must be synced active, so the initial fetch happens.
    expect(b.calls).toEqual(['w7'])
    cleanup()
  })

  it('hands a late-joining consumer the cached tree without a new fetch', async () => {
    const cached: FileNode[] = [{ name: 'a.ts', path: 'a.ts', type: 'file' }]
    const b = makeBridge()
    b.setTree(cached)
    __setFileTreeBridge(b.bridge)

    const h1 = acquireFileTree('w5', () => {})
    h1.setActive(true)
    await tick()
    expect(b.calls.length).toBe(1)

    const seen: FileNode[][] = []
    const h2 = acquireFileTree('w5', (t) => seen.push(t)) // joins after the tree loaded
    expect(seen).toEqual([cached]) // received the cache synchronously
    expect(b.calls.length).toBe(1) // no extra fetch

    h1.release()
    h2.release()
  })
})
