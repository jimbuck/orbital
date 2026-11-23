import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '@renderer/store'
import type { Project, Repo, Task, Worktree } from '@shared/types'

import TaskTracker from './TaskTracker'

/**
 * The tracker's three contexts: a one-repo project (one list), the project
 * session of a multi-repo one (one list, every card chipped, capture files
 * under no repo), and a repo session (its tasks, then Rest of project).
 */

const repo = (id: string, projectId = 'acme'): Repo => ({
  id,
  name: id,
  repoPath: `C:/acme/${id}`,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId
})
const acme: Project = {
  id: 'acme',
  name: 'Acme',
  rootPath: 'C:/acme',
  homeRepoId: 'home',
  managedBlock: true,
  codeWorkspace: false,
  repoIds: ['home', 'api'],
  createdAt: 0
}
const solo: Project = { ...acme, id: 'solo', name: 'solo', homeRepoId: null, repoIds: ['solo'] }
const wt = (id: string, repoId: string, kind: Worktree['kind'], projectId = 'acme'): Worktree =>
  ({ id, repoId, projectId, kind, name: id, path: id, branch: 'main', panes: [] }) as unknown as Worktree
const task = (id: string, repoId: string | null, projectId = 'acme'): Task => ({
  id,
  seq: id.length,
  projectId,
  repoId,
  title: `task ${id}`,
  description: '',
  tags: [],
  status: 'todo',
  worktreeId: null,
  createdBy: 'user',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null
})

let createTask: ReturnType<typeof vi.fn>
let storage: Map<string, string>

function seed(activeProjectId: string, activeWorktreeId: string): void {
  useStore.setState({
    repos: [repo('home'), repo('api'), repo('solo', 'solo')],
    projects: [acme, solo],
    worktrees: [wt('home-root', 'home', 'root'), wt('api-root', 'api', 'root'), wt('solo-root', 'solo', 'root', 'solo')],
    tasks: [task('a', 'api'), task('hh', 'home'), task('nnn', null), task('s', 'solo', 'solo')],
    activeProjectId,
    activeWorktreeId,
    modalStack: [],
    modal: null,
    modalData: null
  } as unknown as Parameters<typeof useStore.setState>[0])
}

function capture(title: string): void {
  const box = screen.getByRole('textbox')
  fireEvent.change(box, { target: { value: title } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

beforeEach(() => {
  createTask = vi.fn(async () => null)
  vi.stubGlobal('orbital', { createTask, updateTask: vi.fn(async () => null) })
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TaskTracker', () => {
  it("in a repo session: that repo's tasks first, the rest folded away, capture files under the repo", () => {
    seed('acme', 'api-root')
    render(<TaskTracker />)
    expect(screen.getByPlaceholderText('Capture a task for api…')).toBeTruthy()
    expect(screen.getByText('task a')).toBeTruthy()
    expect(screen.queryByText('task nnn')).toBeNull()
    // No chips in the repo's own list.
    expect(screen.queryByRole('button', { name: /Change repo/ })).toBeNull()

    const rest = screen.getByRole('button', { name: /Rest of project/ })
    expect(rest.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(rest)
    expect(screen.getByText('task nnn')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'No repo, whole project. Change repo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Repo: home. Change repo' })).toBeTruthy()
    expect(storage.get('orbital.tracker.restOpen')).toBe('1')

    capture('new one')
    expect(createTask).toHaveBeenCalledWith('acme', 'new one', 'api')
  })

  it('remembers Rest of project open across mounts', () => {
    storage.set('orbital.tracker.restOpen', '1')
    seed('acme', 'api-root')
    render(<TaskTracker />)
    expect(screen.getByText('task nnn')).toBeTruthy()
  })

  it('in the project session: every task, every card chipped, capture files under no repo', () => {
    seed('acme', 'home-root')
    render(<TaskTracker />)
    expect(screen.getByPlaceholderText('Capture a project task…')).toBeTruthy()
    for (const t of ['task a', 'task hh', 'task nnn']) expect(screen.getByText(t)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Change repo/ })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /Rest of project/ })).toBeNull()
    capture('spans')
    expect(createTask).toHaveBeenCalledWith('acme', 'spans', null)
  })

  it('in a one-repo project: one list, no chips, capture files under its repo', () => {
    seed('solo', 'solo-root')
    render(<TaskTracker />)
    expect(screen.getByPlaceholderText('Capture a task…')).toBeTruthy()
    expect(screen.getByText('task s')).toBeTruthy()
    expect(screen.queryByText('task a')).toBeNull()
    expect(screen.queryByRole('button', { name: /Change repo/ })).toBeNull()
    capture('x')
    expect(createTask).toHaveBeenCalledWith('solo', 'x', 'solo')
  })

  it('opens the Repo step from a chip and files the task there', () => {
    seed('acme', 'home-root')
    render(<TaskTracker />)
    fireEvent.click(screen.getByRole('button', { name: 'No repo, whole project. Change repo' }))
    expect(screen.getByText('Repo for #3')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /api/ }))
    expect(window.orbital.updateTask).toHaveBeenCalledWith('nnn', { repoId: 'api' })
  })
})
