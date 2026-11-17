import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/types'
import type { AppState, Settings } from '@shared/types'
import { activePaneId, deepEqual, shareById, useStore } from './store'

function worktree(id: string, paneIds: string[]): Worktree {
  return {
    id,
    projectId: 'p1',
    kind: 'root',
    name: id,
    path: `/tmp/${id}`,
    branch: 'main',
    status: 'idle',
    layout: null,
    panes: paneIds.map((paneId) => ({ id: paneId, worktreeId: id, activeTabId: null, tabs: [] }))
  } as unknown as Worktree
}

beforeEach(() => {
  useStore.setState({ worktrees: [worktree('w1', ['a', 'b']), worktree('w2', ['c'])], activePaneIds: {} })
})

describe('activePaneId', () => {
  it('is null before any pane has been touched', () => {
    expect(activePaneId(useStore.getState(), 'w1')).toBeNull()
  })

  it('returns the pane last marked active for that worktree only', () => {
    useStore.getState().setActivePane('w1', 'b')
    useStore.getState().setActivePane('w2', 'c')
    expect(activePaneId(useStore.getState(), 'w1')).toBe('b')
    expect(activePaneId(useStore.getState(), 'w2')).toBe('c')
  })

  it('falls back to null once the recorded pane has been closed', () => {
    useStore.getState().setActivePane('w1', 'b')
    useStore.setState({ worktrees: [worktree('w1', ['a'])] })
    expect(activePaneId(useStore.getState(), 'w1')).toBeNull()
  })

  it('does not replace the record object when the pane is unchanged', () => {
    useStore.getState().setActivePane('w1', 'a')
    const before = useStore.getState().activePaneIds
    useStore.getState().setActivePane('w1', 'a')
    expect(useStore.getState().activePaneIds).toBe(before)
  })
})

describe('deepEqual', () => {
  it('compares nested JSON shapes regardless of key order', () => {
    expect(deepEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual({ a: [] }, { a: {} })).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
  })
})

describe('shareById', () => {
  const a = { id: 'a', n: 1, nested: { x: [1, 2] } }
  const b = { id: 'b', n: 2, nested: { x: [] } }

  it('returns the previous array itself when nothing changed', () => {
    const prev = [a, b]
    const next = [structuredClone(a), structuredClone(b)]
    expect(shareById(prev, next)).toBe(prev)
  })

  it('keeps the identity of unchanged items when one changes', () => {
    const prev = [a, b]
    const next = [structuredClone(a), { ...structuredClone(b), n: 3 }]
    const out = shareById(prev, next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(next[1])
  })

  it('reports a change on reorder, insert and removal', () => {
    expect(shareById([a, b], [structuredClone(b), structuredClone(a)])).not.toBe([a, b])
    const reordered = shareById([a, b], [structuredClone(b), structuredClone(a)])
    expect(reordered.map((i) => i.id)).toEqual(['b', 'a'])
    expect(reordered[0]).toBe(b)
    expect(shareById([a, b], [structuredClone(a)])).toEqual([a])
    expect(shareById([a], [structuredClone(a), structuredClone(b)]).length).toBe(2)
  })
})

describe('applyState structural sharing', () => {
  const settings = { theme: 'dark', alerts: { sound: true } } as unknown as Settings
  function appState(): AppState {
    return {
      projects: [{ id: 'p1', name: 'P', repoPath: '/p' } as AppState['projects'][number]],
      projectFolders: [{ id: 'f1', name: 'Work', collapsed: false, projectIds: ['p1'] }],
      projectRail: [{ kind: 'folder', id: 'f1' }],
      worktrees: [worktree('w1', ['a']), worktree('w2', ['c'])],
      tasks: [],
      settings: structuredClone(settings),
      workspace: { id: 'ws', name: 'Default' } as AppState['workspace'],
      devServers: { w1: ['http://localhost:3000'] },
      settingUpWorktrees: []
    }
  }

  it('keeps every reference when an identical state is pushed again', () => {
    useStore.getState().applyState(appState())
    const before = useStore.getState()
    useStore.getState().applyState(appState())
    const after = useStore.getState()
    expect(after.projects).toBe(before.projects)
    expect(after.projectFolders).toBe(before.projectFolders)
    expect(after.projectRail).toBe(before.projectRail)
    expect(after.worktrees).toBe(before.worktrees)
    expect(after.tasks).toBe(before.tasks)
    expect(after.settings).toBe(before.settings)
    expect(after.workspace).toBe(before.workspace)
    expect(after.devServers).toBe(before.devServers)
    expect(after.settingUpWorktrees).toBe(before.settingUpWorktrees)
    expect(after.expanded).toBe(before.expanded)
  })

  it('replaces only the worktree whose status flipped', () => {
    useStore.getState().applyState(appState())
    const before = useStore.getState()
    const next = appState()
    next.worktrees[1] = { ...next.worktrees[1], status: 'needs_attention' }
    useStore.getState().applyState(next)
    const after = useStore.getState()
    expect(after.worktrees).not.toBe(before.worktrees)
    expect(after.worktrees[0]).toBe(before.worktrees[0])
    expect(after.worktrees[1].status).toBe('needs_attention')
    expect(after.alertCount).toBe(1)
    expect(after.projects).toBe(before.projects)
    expect(after.settings).toBe(before.settings)
  })
})

describe('selecting a project hidden in a collapsed rail folder', () => {
  const setProjectFolderCollapsed = vi.fn(async () => undefined)

  beforeEach(() => {
    setProjectFolderCollapsed.mockClear()
    vi.stubGlobal('orbital', { setProjectFolderCollapsed })
    useStore.setState({
      worktrees: [worktree('w1', ['a'])],
      projectFolders: [
        { id: 'f-shut', name: 'Shut', collapsed: true, projectIds: ['p1'] },
        { id: 'f-open', name: 'Open', collapsed: false, projectIds: ['p2'] }
      ]
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the folder, whether the project or one of its Worktrees was picked', () => {
    useStore.getState().setActiveProject('p1')
    expect(setProjectFolderCollapsed.mock.calls).toEqual([['f-shut', false]])

    // w1 belongs to p1: this is the palette / needs-attention banner path.
    useStore.getState().setActiveWorktree('w1')
    expect(setProjectFolderCollapsed).toHaveBeenCalledTimes(2)
  })

  it('leaves folders alone when the project is already on show', () => {
    useStore.getState().setActiveProject('p2')
    useStore.getState().setActiveProject('loose')
    expect(setProjectFolderCollapsed).not.toHaveBeenCalled()
  })

  it('never reopens a folder on a state push: one the user collapsed stays collapsed', () => {
    const state = useStore.getState()
    state.applyState({
      projects: [{ id: 'p1', name: 'P', repoPath: '/p' } as AppState['projects'][number]],
      projectFolders: state.projectFolders,
      projectRail: state.projectRail,
      worktrees: [worktree('w1', ['a'])],
      tasks: [],
      settings: {} as Settings,
      workspace: { id: 'ws', name: 'Default' } as AppState['workspace'],
      devServers: {},
      settingUpWorktrees: []
    })
    expect(useStore.getState().activeProjectId).toBe('p1')
    expect(setProjectFolderCollapsed).not.toHaveBeenCalled()
  })
})

describe('openInEditor', () => {
  it('records the request and numbers each one, so a repeat of the same file is new', () => {
    useStore.setState({ editorOpen: null })
    useStore.getState().openInEditor('E1', { path: 'src/a.ts', gitState: 'modified' })
    expect(useStore.getState().editorOpen).toEqual({
      tabId: 'E1',
      path: 'src/a.ts',
      staged: false,
      gitState: 'modified',
      seq: 1
    })
    useStore.getState().openInEditor('E1', { path: 'src/a.ts', gitState: 'modified' })
    expect(useStore.getState().editorOpen?.seq).toBe(2)
  })

  it('carries a target line, which is how a content-search hit reaches the editor', () => {
    useStore.setState({ editorOpen: null })
    useStore.getState().openInEditor('E1', { path: 'src/a.ts', line: 42 })
    expect(useStore.getState().editorOpen).toMatchObject({ path: 'src/a.ts', line: 42, staged: false })
    // No git state and no staged side: a line request is a plain file open, and
    // the editor reads exactly that to decide against diff mode.
    expect(useStore.getState().editorOpen?.gitState).toBeUndefined()
  })
})
