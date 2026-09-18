import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Project, SearchQuery, SearchResults, Settings, Tab, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'
import SearchTab from './SearchTab'

/**
 * The Search tab. What matters here is the wiring a user would notice breaking:
 * that the options reach the query main is given, that a hit opens the file at
 * its line, and that a failing checkout says so rather than reading as "no
 * results".
 */

let lastQuery: SearchQuery | null = null
let results: SearchResults
const searchContent = vi.fn(async (q: SearchQuery): Promise<SearchResults> => {
  lastQuery = q
  return results
})
const cancelSearch = vi.fn(async () => undefined)
const setActiveTab = vi.fn(async () => undefined)
const updateTabConfig = vi.fn(async () => undefined)
const createTab = vi.fn(async () => ({ id: 'new-editor' }) as never)
const splitPane = vi.fn(async () => ({ id: 'p-new' }) as never)

const EMPTY: SearchResults = { files: [], totalMatches: 0, truncated: false, errors: [], cancelled: false }

function worktree(id: string, projectId: string, name: string): Worktree {
  return {
    id,
    projectId,
    kind: 'root',
    name,
    path: `C:/repo/${name}`,
    branch: 'main',
    status: 'idle',
    taskId: null,
    layout: { type: 'pane', paneId: `${id}-pane` },
    createdAt: 0,
    panes: [{ id: `${id}-pane`, worktreeId: id, activeTabId: 's1', tabs: [] }]
  }
}

const project = (id: string, name: string): Project => ({
  id,
  name,
  repoPath: `C:/repo/${name}`,
  defaultAgentId: 'claude',
  addedAt: 0
})

const tab: Tab = {
  id: 's1',
  worktreeId: 'w1',
  paneId: 'w1-pane',
  type: 'search',
  status: null,
  position: 0,
  config: {}
}

/** A result set with one file and two hits. */
function twoHits(): SearchResults {
  return {
    files: [
      {
        worktreeId: 'w1',
        path: 'src/store.ts',
        truncated: false,
        matches: [
          { line: 12, text: 'const useStore = 1', ranges: [[6, 14]], clippedStart: 0 },
          { line: 40, text: '  useStore()', ranges: [[2, 10]], clippedStart: 0 }
        ]
      }
    ],
    totalMatches: 2,
    truncated: false,
    errors: [],
    cancelled: false
  }
}

beforeEach(() => {
  lastQuery = null
  results = EMPTY
  searchContent.mockClear()
  cancelSearch.mockClear()
  setActiveTab.mockClear()
  updateTabConfig.mockClear()
  createTab.mockClear()
  splitPane.mockClear()
  vi.stubGlobal('orbital', {
    searchContent,
    cancelSearch,
    setActiveTab,
    updateTabConfig,
    createTab,
    splitPane
  })
  useStore.setState({
    projects: [project('p1', 'orbital'), project('p2', 'website')],
    worktrees: [worktree('w1', 'p1', 'main'), worktree('w2', 'p2', 'docs')],
    activeProjectId: 'p1',
    activeWorktreeId: 'w1',
    activePaneIds: {},
    settings: { defaultOpenAction: 'right' } as unknown as Settings,
    editorOpen: null
  } as unknown as Parameters<typeof useStore.setState>[0])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const box = (): HTMLInputElement => screen.getByLabelText('Search in files') as HTMLInputElement

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

describe('SearchTab', () => {
  it('says what it needs before it will search', () => {
    render(<SearchTab tab={tab} active />)
    expect(screen.getByText(/at least two characters/i)).toBeTruthy()
    expect(searchContent).not.toHaveBeenCalled()
  })

  it('searches this Worktree by default, not the whole workspace', async () => {
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await waitFor(() => expect(searchContent).toHaveBeenCalled())
    expect(lastQuery).toMatchObject({ query: 'useStore', scope: 'worktree', worktreeId: 'w1' })
  })

  it('sends the tab id as the search slot, so two tabs do not cancel each other', async () => {
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await waitFor(() => expect(searchContent).toHaveBeenCalled())
    expect(searchContent.mock.calls[0][1]).toBe('s1')
  })

  it('carries the option toggles into the query', async () => {
    render(<SearchTab tab={tab} active />)
    type('useStore')
    fireEvent.click(screen.getByLabelText('Match case'))
    fireEvent.click(screen.getByLabelText('Whole word'))
    fireEvent.click(screen.getByLabelText('Regular expression'))
    await waitFor(() =>
      expect(lastQuery).toMatchObject({ caseSensitive: true, wholeWord: true, regex: true })
    )
  })

  it('carries the include globs and the chosen scope', async () => {
    render(<SearchTab tab={tab} active />)
    type('useStore')
    fireEvent.change(screen.getByLabelText('Files to include'), { target: { value: 'src/**' } })
    fireEvent.change(screen.getByLabelText('Search scope'), { target: { value: 'workspace' } })
    await waitFor(() => expect(lastQuery).toMatchObject({ include: 'src/**', scope: 'workspace' }))
  })

  it('lists the matching lines under their file, with line numbers', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('40')).toBeTruthy()
    expect(screen.getByText(/2 results in 1 file/)).toBeTruthy()
  })

  it('opens the file at the matched line when a hit is chosen', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')
    fireEvent.click(screen.getByText('40'))

    // No editor exists in this Worktree, so one is created; the line then
    // arrives as a follow-up request (a TabConfig has no room for it).
    await waitFor(() => expect(createTab).toHaveBeenCalled())
    await waitFor(() => expect(useStore.getState().editorOpen).toMatchObject({ path: 'src/store.ts', line: 40 }))
  })

  it('collapses a file so its hits stop taking up the list', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    const header = await screen.findByText('store.ts')
    expect(screen.queryByText('12')).toBeTruthy()
    fireEvent.click(header)
    expect(screen.queryByText('12')).toBeNull()
  })

  it('shows a checkout that failed instead of reporting no results', async () => {
    results = { ...EMPTY, errors: [{ worktreeId: 'w1', message: 'missing closing parenthesis' }] }
    render(<SearchTab tab={tab} active />)
    type('foo(')
    await screen.findByText(/missing closing parenthesis/)
  })

  it('says which checkout failed when the search spanned several', async () => {
    // With every checkout failing there are no files to infer the span from,
    // and "which one?" is exactly what is left to answer.
    results = {
      ...EMPTY,
      errors: [
        { worktreeId: 'w1', message: 'missing closing parenthesis' },
        { worktreeId: 'w2', message: 'missing closing parenthesis' }
      ]
    }
    render(<SearchTab tab={tab} active />)
    type('foo(')
    await screen.findByText(/orbital › main/)
    expect(screen.getByText(/website › docs/)).toBeTruthy()
  })

  it('says when the result set was capped', async () => {
    results = { ...twoHits(), truncated: true }
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText(/showing the first of many/)
  })

  it('labels each file with its checkout only when results span more than one', async () => {
    results = {
      ...twoHits(),
      files: [
        { ...twoHits().files[0] },
        { worktreeId: 'w2', path: 'src/store.ts', truncated: false, matches: [{ line: 1, text: 'useStore', ranges: [], clippedStart: 0 }] }
      ]
    }
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findAllByText('store.ts')
    expect(screen.getByText('orbital › main')).toBeTruthy()
    expect(screen.getByText('website › docs')).toBeTruthy()
  })

  it('strikes off one hit and leaves the rest', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')

    fireEvent.click(screen.getByLabelText('Dismiss store.ts line 12'))
    expect(screen.queryByText('12')).toBeNull()
    expect(screen.getByText('40')).toBeTruthy()
    expect(screen.getByText(/1 result in 1 file/)).toBeTruthy()
  })

  it('strikes off a whole file at once', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')

    fireEvent.click(screen.getByLabelText('Dismiss all results in store.ts'))
    expect(screen.queryByText('store.ts')).toBeNull()
    expect(screen.getByText(/All results dismissed/)).toBeTruthy()
  })

  it('drops a file header once its last hit is struck off', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')

    fireEvent.click(screen.getByLabelText('Dismiss store.ts line 12'))
    fireEvent.click(screen.getByLabelText('Dismiss store.ts line 40'))
    expect(screen.queryByText('store.ts')).toBeNull()
  })

  it('brings everything back on show all', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')

    fireEvent.click(screen.getByLabelText('Dismiss store.ts line 12'))
    fireEvent.click(screen.getByText(/1 dismissed · show all/))
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText(/2 results in 1 file/)).toBeTruthy()
  })

  it('does not re-run the search to restore a dismissed hit', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')
    const before = searchContent.mock.calls.length

    fireEvent.click(screen.getByLabelText('Dismiss store.ts line 12'))
    fireEvent.click(screen.getByText(/1 dismissed · show all/))
    expect(searchContent.mock.calls.length).toBe(before)
  })

  it('strikes off the highlighted row on Delete', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')

    fireEvent.keyDown(screen.getByText('12'), { key: 'Delete' })
    expect(screen.queryByText('12')).toBeNull()
    expect(screen.getByText('40')).toBeTruthy()
  })

  it('leaves Backspace in the query box deleting characters', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')

    fireEvent.keyDown(box(), { key: 'Backspace' })
    expect(screen.getByText('12')).toBeTruthy()
  })

  it('clears the strike-offs when the search itself changes', async () => {
    results = twoHits()
    render(<SearchTab tab={tab} active />)
    type('useStore')
    await screen.findByText('store.ts')
    fireEvent.click(screen.getByLabelText('Dismiss store.ts line 12'))
    expect(screen.queryByText('12')).toBeNull()

    // A different query means different results; nothing carries over.
    type('useStore2')
    await waitFor(() => expect(screen.getByText('12')).toBeTruthy())
  })

  it('seeds itself from the query the tab was restored with', () => {
    const seeded: Tab = { ...tab, config: { search: { query: 'resolveOpenTarget', regex: true } } }
    render(<SearchTab tab={seeded} active />)
    expect(box().value).toBe('resolveOpenTarget')
    expect(screen.getByLabelText('Regular expression').getAttribute('aria-checked')).toBe('true')
  })

  it('stops whatever it had running when the tab goes away', () => {
    const view = render(<SearchTab tab={tab} active />)
    view.unmount()
    expect(cancelSearch).toHaveBeenCalledWith('s1')
  })
})
