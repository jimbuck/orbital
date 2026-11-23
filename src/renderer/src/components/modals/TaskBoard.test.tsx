import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '@renderer/store'
import type { Project, Repo, Task, Worktree } from '@shared/types'

import ModalRoot from './ModalRoot'

/**
 * The task board is the active project's: a Project lane and a lane per repo
 * when it has two or more, one plain lane otherwise. Dropping a card across
 * lanes files it under the lane's repo, unless a live worktree pins it.
 */

const repo = (id: string): Repo => ({
  id,
  name: id,
  repoPath: `C:/acme/${id}`,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId: 'acme'
})
const acme: Project = {
  id: 'acme',
  name: 'Acme',
  rootPath: 'C:/acme',
  homeRepoId: null,
  managedBlock: true,
  repoIds: ['api', 'web'],
  createdAt: 0
}
const solo: Project = { ...acme, id: 'solo', name: 'solo', repoIds: ['solo'] }
const task = (id: string, seq: number, repoId: string | null, over: Partial<Task> = {}): Task => ({
  id,
  seq,
  projectId: 'acme',
  repoId,
  title: `task ${id}`,
  description: '',
  tags: [],
  status: 'todo',
  worktreeId: null,
  createdBy: 'user',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  ...over
})

let updateTask: ReturnType<typeof vi.fn>

function seed(activeProjectId: string, tasks: Task[], worktrees: Worktree[] = []): void {
  useStore.setState({
    modalStack: [],
    modal: null,
    modalData: null,
    repos: [repo('api'), repo('web'), { ...repo('solo'), projectId: 'solo' }],
    projects: [acme, solo],
    worktrees,
    tasks,
    activeProjectId,
    activeWorktreeId: null
  } as unknown as Parameters<typeof useStore.setState>[0])
}

beforeEach(() => {
  updateTask = vi.fn(async () => null)
  vi.stubGlobal('orbital', new Proxy({ updateTask }, { get: (t, k) => (k in t ? t[k as 'updateTask'] : vi.fn(async () => null)) }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function openBoard(): void {
  render(<ModalRoot />)
  act(() => useStore.getState().openModal('board'))
}

/** Drag the card titled `title` onto the cell named `cell` (its aria-label). */
function drag(title: string, cell: string): void {
  const store = new Map<string, string>()
  const dataTransfer = {
    setData: (k: string, v: string) => store.set(k, v),
    getData: (k: string) => store.get(k) ?? '',
    effectAllowed: '',
    dropEffect: ''
  }
  const card = screen.getByText(title).closest('[draggable]')!
  fireEvent.dragStart(card, { dataTransfer })
  const target = screen.getByRole('group', { name: cell })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
  fireEvent.dragEnd(card, { dataTransfer })
}

describe('the task board', () => {
  it('names the active project and lays out Project first, then its repos', () => {
    seed('acme', [task('a', 1, 'api'), task('n', 2, null), task('x', 3, 'web', { projectId: 'solo' })])
    openBoard()
    expect(screen.getByRole('dialog', { name: 'Tasks in Acme' })).toBeTruthy()
    expect(screen.getByText('2 repos · 2 tasks')).toBeTruthy()
    const lanes = screen.getAllByRole('group', { name: /, Todo, / }).map((g) => g.getAttribute('aria-label'))
    expect(lanes).toEqual(['Project, no repo, Todo, 1 tasks', 'api, Todo, 1 tasks', 'web, Todo, 0 tasks'])
    // Another project's task never shows.
    expect(screen.queryByText('task x')).toBeNull()
  })

  it('files a card under the lane it is dropped in, and clears it in the Project lane', () => {
    seed('acme', [task('a', 1, 'api'), task('n', 2, null)])
    openBoard()
    drag('task n', 'web, Todo, 0 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('n', { repoId: 'web' })
    drag('task a', 'Project, no repo, In progress, 0 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('a', { status: 'in_progress', repoId: null })
    // Within its own lane only the status changes.
    drag('task a', 'api, Done, 0 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('a', { status: 'done' })
  })

  it('refuses to move a card with a live worktree to another lane', () => {
    const w = { id: 'w1', repoId: 'api', projectId: 'acme', kind: 'linked', panes: [] } as unknown as Worktree
    seed('acme', [task('a', 1, 'api', { worktreeId: 'w1' })], [w])
    openBoard()
    drag('task a', 'web, Todo, 0 tasks')
    expect(updateTask).not.toHaveBeenCalled()
    drag('task a', 'api, Review, 0 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('a', { status: 'ready_for_review' })
  })

  it('is one plain lane for a one-repo project, and never sends a repo', () => {
    seed('solo', [task('s', 1, null, { projectId: 'solo' })])
    openBoard()
    expect(screen.getByRole('dialog', { name: 'Tasks in solo' })).toBeTruthy()
    expect(screen.getByText('1 task')).toBeTruthy()
    expect(screen.queryByText('Project')).toBeNull()
    drag('task s', 'Done, 0 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('s', { status: 'done' })
  })

  it('follows the active project while open, and says when there is none', () => {
    seed('acme', [])
    openBoard()
    expect(screen.getByText('No tasks in Acme yet. Add one from any column.')).toBeTruthy()
    act(() => useStore.setState({ activeProjectId: 'solo' }))
    expect(screen.getByRole('dialog', { name: 'Tasks in solo' })).toBeTruthy()
    act(() => useStore.setState({ activeProjectId: null }))
    expect(screen.getByRole('dialog', { name: 'Tasks' })).toBeTruthy()
    expect(screen.getByText('No projects yet.')).toBeTruthy()
  })
})
