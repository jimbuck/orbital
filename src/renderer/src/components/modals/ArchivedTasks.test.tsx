import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '@renderer/store'
import type { Task } from '@shared/types'

import ModalRoot from './ModalRoot'

/**
 * The full board links to the archived-tasks table, which the hydrated state
 * does not carry: it fetches the archived tasks itself and offers Unarchive.
 */

const archived: Task = {
  id: 't-archived',
  seq: 12,
  projectId: 'proj',
  repoId: 'p1',
  title: 'Shelved idea',
  description: '',
  tags: ['ui'],
  status: 'todo',
  worktreeId: null,
  createdBy: 'user',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: 1_700_000_000_000
}

let unarchiveTask: ReturnType<typeof vi.fn>

beforeEach(() => {
  unarchiveTask = vi.fn(async () => undefined)
  vi.stubGlobal('orbital', {
    listArchivedTasks: vi.fn(async () => [
      archived,
      { ...archived, id: 't-other', seq: 13, projectId: 'other', repoId: 'p2', title: 'Elsewhere' }
    ]),
    unarchiveTask
  })
  useStore.setState({
    modalStack: [],
    modal: null,
    modalData: null,
    repos: [
      { id: 'p1', name: 'orbital' },
      { id: 'p2', name: 'other' }
    ],
    projects: [
      { id: 'proj', name: 'orbital', homeRepoId: null, repoIds: ['p1'] },
      { id: 'other', name: 'other', homeRepoId: null, repoIds: ['p2'] }
    ],
    activeProjectId: 'proj',
    worktrees: [],
    tasks: []
  } as unknown as Parameters<typeof useStore.setState>[0])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('archived tasks', () => {
  it('opens from the board and unarchives a row', async () => {
    render(<ModalRoot />)
    act(() => useStore.getState().openModal('board'))
    fireEvent.click(await screen.findByRole('button', { name: /archived tasks/i }))
    expect(await screen.findByText('Shelved idea')).toBeTruthy()
    expect(screen.getByText('#12')).toBeTruthy()
    // Only the active project's: another project's archived task stays out.
    expect(screen.queryByText('Elsewhere')).toBeNull()
    expect(screen.getByText('1 archived in orbital')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    expect(unarchiveTask).toHaveBeenCalledWith('t-archived')
  })
})
