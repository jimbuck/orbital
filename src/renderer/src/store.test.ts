import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/types'
import type { AppState, Settings } from '@shared/types'
import { activePaneId, deepEqual, shareById, useStore } from './store'

function worktree(id: string, paneIds: string[]): Worktree {
  return {
    id,
    repoId: 'p1',
    projectId: 'pr1',
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
      repos: [{ id: 'p1', name: 'P', repoPath: '/p', projectId: 'pr1' } as AppState['repos'][number]],
      projects: [
        {
          id: 'pr1',
          name: 'P',
          rootPath: '/p',
          homeRepoId: null,
          managedBlock: true,
          codeWorkspace: false,
          repoIds: ['p1'],
          createdAt: 0
        }
      ],
      railFolders: [
        {
          id: 'f1',
          name: 'Work',
          collapsed: false,
          projectId: null,
          parentId: null,
          items: [{ kind: 'project', id: 'pr1' }]
        }
      ],
      railItems: [{ kind: 'folder', id: 'f1' }],
      railProjectItems: {},
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
    expect(after.repos).toBe(before.repos)
    expect(after.projects).toBe(before.projects)
    expect(after.railFolders).toBe(before.railFolders)
    expect(after.railItems).toBe(before.railItems)
    expect(after.railProjectItems).toBe(before.railProjectItems)
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
    expect(after.repos).toBe(before.repos)
    expect(after.settings).toBe(before.settings)
  })
})

describe('selecting a repo hidden in a collapsed rail folder', () => {
  const setRailFolderCollapsed = vi.fn(async () => undefined)

  beforeEach(() => {
    setRailFolderCollapsed.mockClear()
    vi.stubGlobal('orbital', { setRailFolderCollapsed })
    useStore.setState({
      worktrees: [worktree('w1', ['a'])],
      // Folders hold projects; the store finds a repo's folder through its project.
      repos: [
        { id: 'p1', name: 'P', repoPath: '/p', projectId: 'pr1' } as AppState['repos'][number],
        { id: 'p2', name: 'Q', repoPath: '/q', projectId: 'pr2' } as AppState['repos'][number]
      ],
      railFolders: [
        {
          id: 'f-shut',
          name: 'Shut',
          collapsed: true,
          projectId: null,
          parentId: null,
          items: [{ kind: 'project', id: 'pr1' }]
        },
        {
          id: 'f-open',
          name: 'Open',
          collapsed: false,
          projectId: null,
          parentId: null,
          items: [{ kind: 'project', id: 'pr2' }]
        }
      ]
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the folder, whether the repo or one of its Worktrees was picked', () => {
    useStore.getState().setActiveRepo('p1')
    expect(setRailFolderCollapsed.mock.calls).toEqual([['f-shut', false]])

    // w1 belongs to p1: this is the palette / needs-attention banner path.
    useStore.getState().setActiveWorktree('w1')
    expect(setRailFolderCollapsed).toHaveBeenCalledTimes(2)
  })

  it('leaves folders alone when the repo is already on show', () => {
    useStore.getState().setActiveRepo('p2')
    useStore.getState().setActiveRepo('loose')
    expect(setRailFolderCollapsed).not.toHaveBeenCalled()
  })

  it('opens every folder between the row and the top: the nested ones, and the ones among its project\'s repos', () => {
    const folder = (
      id: string,
      collapsed: boolean,
      parentId: string | null,
      projectId: string | null,
      items: AppState['railItems']
    ): AppState['railFolders'][number] => ({ id, name: id, collapsed, projectId, parentId, items })
    useStore.setState({
      railFolders: [
        // pr1 is in `inner`, which is in `outer`; `between` is open already.
        folder('outer', true, null, null, [{ kind: 'folder', id: 'between' }]),
        folder('between', false, 'outer', null, [{ kind: 'folder', id: 'inner' }]),
        folder('inner', true, 'between', null, [{ kind: 'project', id: 'pr1' }]),
        // p1 is in `apps`, one of pr1's own folders, itself in `all`.
        folder('all', true, null, 'pr1', [{ kind: 'folder', id: 'apps' }]),
        folder('apps', true, 'all', 'pr1', [{ kind: 'repo', id: 'p1' }]),
        folder('elsewhere', true, null, null, [{ kind: 'project', id: 'pr2' }])
      ]
    })
    useStore.getState().setActiveRepo('p1')
    expect(setRailFolderCollapsed.mock.calls.map((c) => c[0]).sort()).toEqual(['all', 'apps', 'inner', 'outer'])

    // Selecting the project itself opens what hides its header, not its repos' folders.
    setRailFolderCollapsed.mockClear()
    useStore.setState({
      projects: [{ id: 'pr1', name: 'P', homeRepoId: null, repoIds: ['p1'] } as AppState['projects'][number]]
    })
    useStore.getState().setActiveProject('pr1')
    expect(setRailFolderCollapsed.mock.calls.map((c) => c[0]).sort()).toEqual(['inner', 'outer'])
  })

  it('never reopens a folder on a state push: one the user collapsed stays collapsed', () => {
    const state = useStore.getState()
    state.applyState({
      repos: state.repos,
      projects: [],
      railFolders: state.railFolders,
      railItems: state.railItems,
      railProjectItems: {},
      worktrees: [worktree('w1', ['a'])],
      tasks: [],
      settings: {} as Settings,
      workspace: { id: 'ws', name: 'Default' } as AppState['workspace'],
      devServers: {},
      settingUpWorktrees: []
    })
    expect(useStore.getState().activeRepoId).toBe('p1')
    expect(setRailFolderCollapsed).not.toHaveBeenCalled()
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

describe('project sessions', () => {
  const settings = {} as Settings
  const repoOf = (id: string, projectId: string): AppState['repos'][number] =>
    ({ id, name: id, repoPath: `/${id}`, projectId }) as AppState['repos'][number]
  const wt = (id: string, projectId: string, repoId: string | null, kind: Worktree['kind']): Worktree =>
    ({ ...worktree(id, []), projectId, repoId, kind }) as Worktree
  /** Project g (repos a, b) with `home`, its sessions given by `worktrees`. */
  function state(home: string | null, worktrees: Worktree[]): AppState {
    return {
      repos: [repoOf('a', 'g'), repoOf('b', 'g')],
      projects: [
        {
          id: 'g',
          name: 'G',
          rootPath: '/g',
          homeRepoId: home,
          managedBlock: true,
          codeWorkspace: false,
          repoIds: ['a', 'b'],
          createdAt: 0
        }
      ],
      railFolders: [],
      railItems: [],
      worktrees,
      tasks: [],
      settings,
      workspace: { id: 'ws', name: 'Default' } as AppState['workspace'],
      devServers: {},
      settingUpWorktrees: []
    }
  }
  const noHome = [wt('folder', 'g', null, 'folder'), wt('a-root', 'g', 'a', 'root'), wt('b-root', 'g', 'b', 'root')]

  beforeEach(() => {
    vi.stubGlobal('orbital', { setRailFolderCollapsed: vi.fn(async () => undefined) })
    useStore.setState({ activeRepoId: null, activeProjectId: null, activeWorktreeId: null, expanded: {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("opens a folder session from the project, with no repo active", () => {
    useStore.getState().applyState(state(null, noHome))
    useStore.getState().setActiveProject('g')
    const s = useStore.getState()
    expect(s.activeWorktreeId).toBe('folder')
    expect(s.activeProjectId).toBe('g')
    expect(s.activeRepoId).toBeNull()
    expect(s.expanded.g).toBe(true)
  })

  it('keeps a folder session open across pushes, and moves to the home once it is gone', () => {
    useStore.getState().applyState(state(null, noHome))
    useStore.getState().setActiveProject('g')
    useStore.getState().applyState(state(null, noHome))
    expect(useStore.getState().activeWorktreeId).toBe('folder')

    // A home was set: main closed the folder session; the project's session is now the home's root.
    useStore.getState().applyState(state('b', noHome.slice(1)))
    const s = useStore.getState()
    expect(s.activeWorktreeId).toBe('b-root')
    expect(s.activeRepoId).toBe('b')
    expect(s.activeProjectId).toBe('g')
  })

  it('opens the project and the repo when a linked worktree is picked from outside the rail', () => {
    useStore.getState().applyState(state(null, [...noHome, wt('a-feat', 'g', 'a', 'linked')]))
    useStore.setState({ expanded: { g: false } })
    useStore.getState().setActiveWorktree('a-feat')
    const s = useStore.getState()
    expect(s.expanded).toMatchObject({ g: true, a: true })
    expect(s.activeRepoId).toBe('a')
    expect(s.activeProjectId).toBe('g')
  })
})
