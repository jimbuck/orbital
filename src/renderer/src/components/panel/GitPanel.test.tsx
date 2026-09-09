import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { GitStatus, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import GitPanel from './GitPanel'

/**
 * The status request race. A slow `git status` for the Worktree the user just
 * left must never overwrite the list of the one they switched to — every
 * stage / discard action pairs the ACTIVE worktree id with paths from the
 * displayed list, so a stale list is a wrong-checkout mutation waiting to
 * happen.
 */

function worktree(id: string): Worktree {
  return {
    id,
    projectId: 'p1',
    kind: 'root',
    name: id,
    path: `C:/repo/${id}`,
    branch: 'main',
    status: 'idle',
    taskId: null,
    layout: { type: 'pane', paneId: `${id}-pane` },
    createdAt: 0,
    panes: [{ id: `${id}-pane`, worktreeId: id, activeTabId: null, tabs: [] }]
  }
}

function statusWith(file: string): GitStatus {
  return {
    branch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: false,
    staged: [],
    unstaged: [{ path: file, state: 'modified', staged: false }]
  }
}

type Deferred = { resolve: (s: GitStatus) => void; reject: (e: Error) => void }
let pending: Map<string, Deferred>
let gitChanged: Set<(evt: { worktreeIds: string[] }) => void>

beforeEach(() => {
  pending = new Map()
  gitChanged = new Set()
  vi.stubGlobal('orbital', {
    gitStatus: vi.fn(
      (id: string) =>
        new Promise<GitStatus>((resolve, reject) => {
          pending.set(id, { resolve, reject })
        })
    ),
    onGitChanged: (cb: (evt: { worktreeIds: string[] }) => void) => {
      gitChanged.add(cb)
      return () => gitChanged.delete(cb)
    }
  })
  useStore.setState({
    projects: [{ id: 'p1', name: 'repo', repoPath: 'C:/repo' }],
    worktrees: [worktree('A'), worktree('B')],
    tasks: [],
    activeProjectId: 'p1',
    activeWorktreeId: 'A',
    settings: null
  } as unknown as Parameters<typeof useStore.setState>[0])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function settle(id: string, status: GitStatus): Promise<void> {
  await act(async () => {
    pending.get(id)!.resolve(status)
    await Promise.resolve()
  })
}

describe('GitPanel status requests', () => {
  it('drops a stale reply for the Worktree the user has since left', async () => {
    render(<GitPanel />)
    expect(pending.has('A')).toBe(true)

    act(() => useStore.getState().setActiveWorktree('B'))
    await settle('B', statusWith('only-in-b.ts'))
    expect(await screen.findByText('only-in-b.ts')).toBeTruthy()

    // A's status arrives late — it must not replace B's list.
    await settle('A', statusWith('only-in-a.ts'))
    expect(screen.queryByText('only-in-a.ts')).toBeNull()
    expect(screen.getByText('only-in-b.ts')).toBeTruthy()
  })

  it('keeps the last good list and shows the failure when a refresh errors', async () => {
    render(<GitPanel />)
    await settle('A', statusWith('kept.ts'))
    expect(await screen.findByText('kept.ts')).toBeTruthy()

    pending.delete('A')
    act(() => {
      for (const cb of gitChanged) cb({ worktreeIds: ['A'] })
    })
    await act(async () => {
      pending.get('A')!.reject(new Error("Error invoking remote method 'x': Error: fatal: index.lock exists"))
      await Promise.resolve()
    })
    expect(screen.getByText('kept.ts')).toBeTruthy()
    expect(screen.getByText('fatal: index.lock exists')).toBeTruthy()
    expect(screen.queryByText('Working tree clean')).toBeNull()
  })
})
