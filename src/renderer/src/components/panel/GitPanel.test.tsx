import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GitStatus, Tab, Worktree } from '@shared/types'
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

/* ---- Opening a change ------------------------------------------------------
 *
 * A click on a changed file shows it in the editor the user is already
 * looking at. Editors hold many files, so the old "one editor tab per file"
 * behaviour — and its blind spot, where a click on the file an editor was
 * opened with did nothing — is gone.
 * -------------------------------------------------------------------------- */

describe('GitPanel opening a change', () => {
  const tabIn = (paneId: string, id: string, type: 'editor' | 'terminal'): Tab => ({
    id,
    worktreeId: 'A',
    paneId,
    type,
    status: null,
    position: 0,
    config: {}
  })

  /** Worktree A with two panes, each holding the given tabs (first tab active). */
  function twoPanes(left: Tab[], right: Tab[]): void {
    const w = worktree('A')
    w.panes = [
      { id: 'A-left', worktreeId: 'A', activeTabId: left[0]?.id ?? null, tabs: left },
      { id: 'A-right', worktreeId: 'A', activeTabId: right[0]?.id ?? null, tabs: right }
    ]
    useStore.setState({ worktrees: [w], editorOpen: null } as unknown as Parameters<typeof useStore.setState>[0])
  }

  let setActiveTab: ReturnType<typeof vi.fn>
  let createTab: ReturnType<typeof vi.fn>
  beforeEach(() => {
    setActiveTab = vi.fn(async () => undefined)
    createTab = vi.fn(async () => undefined)
    Object.assign(window.orbital, { setActiveTab, createTab })
  })

  async function clickChange(): Promise<void> {
    render(<GitPanel />)
    await settle('A', statusWith('src/a.ts'))
    fireEvent.click(screen.getByTitle('Open diff — src/a.ts'))
  }

  it('hands the file to the active editor of the pane the user last worked in', async () => {
    twoPanes([tabIn('A-left', 'E-left', 'editor')], [tabIn('A-right', 'E-right', 'editor')])
    useStore.getState().setActivePane('A', 'A-right')
    await clickChange()

    expect(setActiveTab).toHaveBeenCalledWith('A-right', 'E-right')
    expect(useStore.getState().editorOpen).toMatchObject({
      tabId: 'E-right',
      path: 'src/a.ts',
      staged: false,
      gitState: 'modified'
    })
    expect(createTab).not.toHaveBeenCalled()
  })

  it('reaches for an editor behind the active terminal before opening a new one', async () => {
    twoPanes([tabIn('A-left', 'T1', 'terminal'), tabIn('A-left', 'E1', 'editor')], [])
    await clickChange()

    expect(setActiveTab).toHaveBeenCalledWith('A-left', 'E1')
    expect(useStore.getState().editorOpen?.tabId).toBe('E1')
    expect(createTab).not.toHaveBeenCalled()
  })

  it('uses an editor in another pane when the active pane has none', async () => {
    twoPanes([tabIn('A-left', 'T1', 'terminal')], [tabIn('A-right', 'E2', 'editor')])
    useStore.getState().setActivePane('A', 'A-left')
    await clickChange()

    expect(setActiveTab).toHaveBeenCalledWith('A-right', 'E2')
    expect(createTab).not.toHaveBeenCalled()
  })

  it('opens a new editor, on the file, only when the worktree has none', async () => {
    twoPanes([tabIn('A-left', 'T1', 'terminal')], [])
    useStore.getState().setActivePane('A', 'A-left')
    await clickChange()

    expect(createTab).toHaveBeenCalledWith('A', 'A-left', 'editor', { filePath: 'src/a.ts', diffStaged: false })
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(useStore.getState().editorOpen).toBeNull()
  })
})
