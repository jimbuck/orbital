import { beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '@shared/types'
import { activePaneId, useStore } from './store'

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
