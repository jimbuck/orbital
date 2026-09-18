import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { FileSearchHit, Project, SearchResults, Settings, Task, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'
import CommandPalette, { parseQuery } from './CommandPalette'

/**
 * The palette is the app's one keyboard-first surface, so these cover the parts
 * a keyboard user cannot see failing: which view a prefix selects, that a file
 * hit says which checkout it came from, and that Enter runs the highlighted row
 * rather than the first one.
 */

const searchFiles = vi.fn(async (): Promise<FileSearchHit[]> => [])
const searchContent = vi.fn(async (): Promise<SearchResults> => ({
  files: [],
  totalMatches: 0,
  truncated: false,
  errors: [],
  cancelled: false
}))
const cancelSearch = vi.fn(async () => undefined)
const createTab = vi.fn(async () => ({}) as never)
const splitPane = vi.fn(async () => ({ id: 'newpane' }) as never)

function project(id: string, name: string): Project {
  return { id, name, repoPath: `C:/repos/${name}`, defaultAgentId: 'claude', addedAt: 0 }
}

function worktree(id: string, projectId: string, name: string, branch: string): Worktree {
  return {
    id,
    projectId,
    kind: 'linked',
    name,
    path: `C:/repos/${name}`,
    branch,
    status: 'idle',
    taskId: null,
    layout: { type: 'pane', paneId: `${id}-pane` },
    createdAt: 0,
    panes: [{ id: `${id}-pane`, worktreeId: id, activeTabId: null, tabs: [] }]
  }
}

function task(id: string, seq: number, projectId: string, title: string): Task {
  return {
    id,
    seq,
    projectId,
    title,
    description: '',
    tags: [],
    status: 'todo',
    worktreeId: null,
    createdBy: 'user',
    createdAt: 0,
    updatedAt: 0
  }
}

const settings = {
  defaultShell: 'pwsh.exe',
  alerts: { indicator: true, sound: true, taskbarBadge: false, taskbarFlash: false },
  envSyncPatterns: [],
  periodicFetch: true,
  debugLogging: false,
  agents: [{ id: 'claude', name: 'Claude', provider: 'claude' }],
  theme: 'dark',
  defaultOpenAction: 'right',
  accentColor: null
} as unknown as Settings

/** Seed a two-project workspace and open the palette with `query` typed. */
function seed(query: string): void {
  useStore.setState({
    projects: [project('p1', 'orbital'), project('p2', 'website')],
    worktrees: [
      worktree('w1', 'p1', 'main', 'main'),
      worktree('w2', 'p1', 'palette', 'feat/palette'),
      worktree('w3', 'p2', 'main', 'main')
    ],
    tasks: [task('t1', 98, 'p1', 'Command Palette and Global Search')],
    settings,
    devServers: {},
    workspace: null,
    activeProjectId: 'p1',
    activeWorktreeId: 'w1',
    activePaneIds: {},
    alertCount: 0,
    updateStatus: { phase: 'idle' },
    zoomFactor: 1,
    modalStack: [],
    modal: null,
    modalData: null,
    palette: { query, seq: 1 }
  } as unknown as Parameters<typeof useStore.setState>[0])
}

function input(): HTMLInputElement {
  return screen.getByLabelText('Command palette query') as HTMLInputElement
}

function optionLabels(): string[] {
  return screen.queryAllByRole('option').map((o) => o.textContent ?? '')
}

beforeEach(() => {
  searchFiles.mockClear()
  searchFiles.mockResolvedValue([])
  searchContent.mockClear()
  cancelSearch.mockClear()
  createTab.mockClear()
  splitPane.mockClear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  vi.stubGlobal('orbital', {
    searchFiles,
    searchContent,
    cancelSearch,
    createTab,
    splitPane,
    setActiveTab: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => settings),
    gitStageAll: vi.fn(async () => undefined),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    toggleDevTools: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useStore.setState({ palette: null } as Parameters<typeof useStore.setState>[0])
})

describe('parseQuery', () => {
  it('maps each prefix to its view and strips it from the term', () => {
    expect(parseQuery('>push')).toEqual({ mode: 'commands', term: 'push' })
    expect(parseQuery('/useStore')).toEqual({ mode: 'text', term: 'useStore' })
    expect(parseQuery('@main')).toEqual({ mode: 'goto', term: 'main' })
    expect(parseQuery('#98')).toEqual({ mode: 'tasks', term: '98' })
    expect(parseQuery('store.ts')).toEqual({ mode: 'mixed', term: 'store.ts' })
  })

  it('treats a bare prefix as that view with nothing typed yet', () => {
    expect(parseQuery('>')).toEqual({ mode: 'commands', term: '' })
  })

  it('does not trim a text query — trailing whitespace is searchable', () => {
    expect(parseQuery('/foo  ')).toEqual({ mode: 'text', term: 'foo  ' })
  })
})

describe('CommandPalette', () => {
  it('renders nothing until the store says it is open', () => {
    useStore.setState({ palette: null } as Parameters<typeof useStore.setState>[0])
    render(<CommandPalette />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens seeded with the requested prefix and focuses its input', () => {
    seed('>')
    render(<CommandPalette />)
    expect(input().value).toBe('>')
    expect(document.activeElement).toBe(input())
  })

  it('lists commands in the > view and narrows them as you type', () => {
    seed('>')
    render(<CommandPalette />)
    const all = optionLabels().length
    expect(all).toBeGreaterThan(10)

    fireEvent.change(input(), { target: { value: '>stage all' } })
    const narrowed = optionLabels()
    expect(narrowed.length).toBeLessThan(all)
    expect(narrowed[0]).toContain('Stage All Changes')
  })

  it('finds a command through a synonym its label does not contain', () => {
    seed('>preferences')
    render(<CommandPalette />)
    expect(optionLabels().join(' ')).toContain('Settings')
  })

  it('lists Worktrees in the @ view, each tagged with its project', () => {
    seed('@')
    render(<CommandPalette />)
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('orbital')).toBeTruthy()
    expect(rows.map((r) => r.textContent).join(' ')).toContain('feat/palette')
  })

  it('switches the active Worktree when one is chosen', () => {
    seed('@palette')
    render(<CommandPalette />)
    fireEvent.click(screen.getAllByRole('option')[0])
    expect(useStore.getState().activeWorktreeId).toBe('w2')
    expect(useStore.getState().palette).toBeNull()
  })

  it('finds a task by its number in the # view', () => {
    seed('#98')
    render(<CommandPalette />)
    expect(optionLabels()[0]).toContain('#98 Command Palette and Global Search')
  })

  it('shows which project and Worktree a file hit came from', async () => {
    searchFiles.mockResolvedValue([
      { worktreeId: 'w2', path: 'src/renderer/src/store.ts', score: 90 },
      { worktreeId: 'w3', path: 'src/store.ts', score: 80 }
    ])
    seed('')
    render(<CommandPalette />)
    fireEvent.change(input(), { target: { value: 'store.ts' } })

    // Both rows are the same file name — the origin chip is the only thing
    // telling them apart, which is exactly why it has to be there.
    await screen.findByText('orbital › palette')
    expect(screen.getByText('website › main')).toBeTruthy()
    expect(searchFiles).toHaveBeenCalledWith('store.ts', expect.any(Number))
  })

  it('leaves the file section empty until something is typed', () => {
    seed('')
    render(<CommandPalette />)
    expect(searchFiles).not.toHaveBeenCalled()
    // The landing view offers the other views and somewhere to go.
    expect(optionLabels().join(' ')).toContain('Go to File')
  })

  it('runs the highlighted row on Enter, not the first one', () => {
    seed('@')
    render(<CommandPalette />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useStore.getState().activeWorktreeId).toBe('w2')
  })

  it('wraps the selection around both ends of the list', () => {
    seed('@')
    render(<CommandPalette />)
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    const rows = screen.getAllByRole('option')
    expect(rows[rows.length - 1].getAttribute('aria-selected')).toBe('true')
  })

  it('closes on Escape without running anything', () => {
    seed('@')
    render(<CommandPalette />)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(useStore.getState().palette).toBeNull()
    expect(useStore.getState().activeWorktreeId).toBe('w1')
  })

  it('keeps itself open for the rows that only switch view', () => {
    seed('')
    render(<CommandPalette />)
    const goToTasks = screen.getAllByRole('option').find((o) => o.textContent?.includes('Go to Task'))!
    fireEvent.click(goToTasks)
    expect(useStore.getState().palette).not.toBeNull()
    expect(input().value).toBe('#')
  })

  it('opens a new tab through the Default Open Action, splitting a solo pane', async () => {
    seed('>new terminal')
    render(<CommandPalette />)
    fireEvent.click(screen.getAllByRole('option')[0])

    // w1 has one pane and the setting is Right Pane, so the pane is created
    // first and the tab goes into it.
    expect(splitPane).toHaveBeenCalledWith('w1', 'w1-pane', 'row', 'after')
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledWith('w1', 'newpane', 'terminal', undefined))
  })

  it('searches file contents in the / view, scoped to the active Worktree', async () => {
    searchContent.mockResolvedValue({
      files: [
        {
          worktreeId: 'w1',
          path: 'src/store.ts',
          truncated: false,
          matches: [{ line: 12, text: 'const useStore = 1', ranges: [[6, 14]], clippedStart: 0 }]
        }
      ],
      totalMatches: 1,
      truncated: false,
      errors: [],
      cancelled: false
    })
    seed('/')
    render(<CommandPalette />)
    fireEvent.change(input(), { target: { value: '/useStore' } })

    await screen.findByText(/const/)
    expect(screen.getByText('store.ts:12')).toBeTruthy()
    // Scoped, unlike file search: a global content search is expensive and noisy.
    expect(searchContent.mock.calls[0][0]).toMatchObject({
      query: 'useStore',
      scope: 'worktree',
      worktreeId: 'w1'
    })
  })

  it('opens the file at the matched line when a content hit is chosen', async () => {
    searchContent.mockResolvedValue({
      files: [
        {
          worktreeId: 'w1',
          path: 'src/store.ts',
          truncated: false,
          matches: [{ line: 12, text: 'const useStore = 1', ranges: [[6, 14]], clippedStart: 0 }]
        }
      ],
      totalMatches: 1,
      truncated: false,
      errors: [],
      cancelled: false
    })
    seed('/')
    render(<CommandPalette />)
    fireEvent.change(input(), { target: { value: '/useStore' } })
    await screen.findByText(/const/)
    fireEvent.click(screen.getAllByRole('option')[0])
    await vi.waitFor(() =>
      expect(useStore.getState().editorOpen).toMatchObject({ path: 'src/store.ts', line: 12 })
    )
  })

  it('always offers the hand-off to a Search tab, even with no hits', async () => {
    seed('/')
    render(<CommandPalette />)
    fireEvent.change(input(), { target: { value: '/nothingmatches' } })
    const row = await screen.findByText(/Open all results for/)
    fireEvent.click(row)
    // w1 has a single pane and the setting is Right Pane, so one is made first.
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledWith('w1', 'newpane', 'search', expect.anything()))
  })

  it('keeps content matches out of the mixed view', async () => {
    seed('')
    render(<CommandPalette />)
    fireEvent.change(input(), { target: { value: 'useStore' } })
    await vi.waitFor(() => expect(searchFiles).toHaveBeenCalled())
    // File names, commands, Worktrees and tasks — but no greps.
    expect(searchContent).not.toHaveBeenCalled()
  })

  it('reports an empty result rather than a stale list', () => {
    seed('>zzzzzzzz')
    render(<CommandPalette />)
    expect(screen.getByText('No matching results.')).toBeTruthy()
  })
})
