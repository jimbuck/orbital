import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

// Mock the tab bodies: this test is about PaneView's mount/visibility decision,
// not xterm/editor internals. The editor mock records its `active` prop.
vi.mock('./TabStrip', () => ({ default: () => null }))
vi.mock('./BrowserTab', () => ({ default: () => null }))
vi.mock('./TerminalTab', () => ({
  default: ({ tab }: { tab: { id: string } }) => <div data-testid={`term-${tab.id}`} />
}))
vi.mock('./EditorTab', () => ({
  default: ({ tab, active }: { tab: { id: string }; active: boolean }) => (
    <div data-testid={`editor-${tab.id}`} data-active={String(active)} />
  )
}))

import PaneGroup from './PaneGroup'

/** A worktree with one pane holding a terminal + an editor tab. */
function makeWorktree(activeTabId: string): Worktree {
  return {
    id: 'w1',
    projectId: 'p1',
    kind: 'root',
    name: 'main',
    path: '/tmp/w1',
    branch: 'main',
    status: 'idle',
    layout: null,
    panes: [
      {
        id: 'pane1',
        activeTabId,
        tabs: [
          { id: 'T1', worktreeId: 'w1', paneId: 'pane1', type: 'terminal', status: 'idle', config: {} },
          { id: 'E1', worktreeId: 'w1', paneId: 'pane1', type: 'editor', config: {} }
        ]
      }
    ]
  } as unknown as Worktree
}

function seed(activeTabId: string): void {
  useStore.setState({
    projects: [{ id: 'p1' }],
    worktrees: [makeWorktree(activeTabId)],
    activeProjectId: 'p1',
    activeWorktreeId: 'w1',
    settings: null
  } as unknown as Parameters<typeof useStore.setState>[0])
}

describe('PaneView editor tab mounting', () => {
  afterEach(cleanup)

  it('renders the editor active and visible when its tab is the active tab', () => {
    seed('E1')
    render(<PaneGroup />)

    const marker = screen.getByTestId('editor-E1')
    expect(marker.getAttribute('data-active')).toBe('true')
    expect(marker.parentElement?.className).not.toContain('hidden')
  })

  it('keeps the editor mounted (hidden, inactive) when another tab is active', () => {
    seed('T1')
    render(<PaneGroup />)

    // The regression: the editor must stay in the DOM even while a terminal tab
    // is showing, so its in-memory state is not thrown away.
    const marker = screen.getByTestId('editor-E1')
    expect(marker.getAttribute('data-active')).toBe('false')
    expect(marker.parentElement?.className).toContain('hidden')
  })

  it('preserves the same editor DOM node across an active-tab switch', () => {
    seed('E1')
    render(<PaneGroup />)
    const before = screen.getByTestId('editor-E1')

    act(() => seed('T1')) // switch the pane's active tab away from the editor

    const after = screen.getByTestId('editor-E1')
    expect(after).toBe(before) // same node → the editor was not unmounted
    expect(after.getAttribute('data-active')).toBe('false')
  })
})
