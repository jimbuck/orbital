import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Repo as RepoModel, RailFolder, RailItem, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import Repo from './Repo'

/**
 * The repo header's context menu, and specifically which items survive when
 * the repo has NO root Worktree row.
 *
 * That state is not a corner case and it is not transient: the root row comes
 * from `reconcileRepoWorktrees`, which returns without writing any rows when
 * `git worktree list` fails — a folder that was never a repo, or has become
 * unreadable, permanently has none. "Open in File Explorer" / "Open in External
 * Terminal" are what a user reaches for in exactly that state, so they must not
 * be conditioned on a Worktree existing. Clear Status genuinely acts on a
 * Worktree row and correctly disappears with it.
 */

let bridge: Record<string, ReturnType<typeof vi.fn>>

const repo: RepoModel = {
  id: 'p1',
  name: 'orbital',
  repoPath: 'C:/repo',
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId: 'pr1'
}

const rootWorktree: Worktree = {
  id: 'w-root',
  repoId: repo.id,
  kind: 'root',
  name: 'main',
  path: 'C:/repo',
  branch: 'main',
  status: 'idle',
  taskId: null,
  layout: { type: 'pane', paneId: 'pane-1' },
  createdAt: 0,
  panes: []
}

beforeEach(() => {
  bridge = {
    openRepoPath: vi.fn(async () => undefined),
    openRepoInTerminal: vi.fn(async () => undefined),
    clearWorktreeStatus: vi.fn(async () => undefined),
    renameRepo: vi.fn(async () => undefined),
    removeRepo: vi.fn(async () => undefined),
    placeProject: vi.fn(async () => undefined),
    createRailFolder: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render the header with `worktrees` (and rail `folders`) seeded, then right-click it open. */
function openMenu(worktrees: Worktree[], folders: RailFolder[] = [], rail: RailItem[] = []): void {
  useStore.setState({
    repos: [repo],
    railFolders: folders,
    railItems: rail,
    worktrees,
    tasks: [],
    activeRepoId: repo.id,
    activeWorktreeId: null,
    expanded: {}
  } as unknown as Parameters<typeof useStore.setState>[0])
  render(<Repo repo={repo} />)
  fireEvent.contextMenu(screen.getByText(repo.name))
}

/** A linked Worktree in `status`, for the group-summary tests. */
function linked(id: string, status: Worktree['status']): Worktree {
  return { ...rootWorktree, id, kind: 'linked', name: id, status }
}

/** Render the header with `worktrees` seeded, and the repo expanded or not. */
function renderHeader(worktrees: Worktree[], expanded = false): void {
  useStore.setState({
    repos: [repo],
    worktrees,
    tasks: [],
    activeRepoId: repo.id,
    activeWorktreeId: null,
    expanded: expanded ? { [repo.id]: true } : {}
  } as unknown as Parameters<typeof useStore.setState>[0])
  render(<Repo repo={repo} />)
}

/** The chevron's className — where the group summary is painted. */
function chevronClass(): string {
  const button = screen.getByRole('button', { name: /^(Expand|Collapse) repo/ })
  return button.querySelector('svg')?.getAttribute('class') ?? ''
}

/** Menu item labels, in rendered order. */
function items(): string[] {
  return screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')
}

describe('repo context menu', () => {
  it('offers the OS hand-offs when the repo has no root Worktree', () => {
    openMenu([])
    expect(items()).toEqual([
      'Rename',
      'Move to Folder',
      'New Worktree',
      'Open in File Explorer',
      'Open in External Terminal',
      'Remove repo'
    ])
    // Clear Status is the only item that needs the row, so it is the only one missing.
    expect(screen.queryByText('Clear Status')).toBeNull()
  })

  it('offers Clear Status as well once the root Worktree exists', () => {
    openMenu([rootWorktree])
    expect(items()).toEqual([
      'Rename',
      'Move to Folder',
      'New Worktree',
      'Clear Status',
      'Open in File Explorer',
      'Open in External Terminal',
      'Remove repo'
    ])
  })

  it('sends the OS hand-offs the REPO id, with no path over the bridge', () => {
    openMenu([])

    fireEvent.click(screen.getByText('Open in File Explorer'))
    expect(bridge.openRepoPath).toHaveBeenCalledWith(repo.id)
    // A path parameter here would be the renderer telling main what to open,
    // which is the shape the containment work removed.
    expect(bridge.openRepoPath.mock.calls[0]).toHaveLength(1)

    fireEvent.contextMenu(screen.getByText(repo.name))
    fireEvent.click(screen.getByText('Open in External Terminal'))
    expect(bridge.openRepoInTerminal).toHaveBeenCalledWith(repo.id)
    expect(bridge.openRepoInTerminal.mock.calls[0]).toHaveLength(1)
  })

  it('still routes Clear Status at the root Worktree row', () => {
    openMenu([rootWorktree])
    fireEvent.click(screen.getByText('Clear Status'))
    expect(bridge.clearWorktreeStatus).toHaveBeenCalledWith(rootWorktree.id)
  })
})

describe('repo context menu — Move to Folder', () => {
  // Folders hold projects: the repo is filed through its project.
  const work: RailFolder = { id: 'f-work', name: 'Work', collapsed: false, projectIds: [] }
  const play: RailFolder = { id: 'f-play', name: 'Play', collapsed: false, projectIds: [repo.projectId] }

  it('lists the folders in place of the menu and files the repo project in the one picked', () => {
    openMenu([], [work, play])
    fireEvent.click(screen.getByText('Move to Folder'))

    expect(items()).toEqual(['Work', 'Playcurrent', 'New Folder…', 'Remove from Folder'])
    // The folder it is already in is shown, but is not a move.
    expect((screen.getByRole('menuitem', { name: /Play/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByText('Work'))
    // A project id and a folder id (last in it), and nothing else: no path, no setting.
    expect(bridge.placeProject.mock.calls).toEqual([[repo.projectId, work.id, null]])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('takes the repo out of its folder, to the top level just below it', () => {
    openMenu([], [work, play], [
      { kind: 'folder', id: play.id },
      { kind: 'folder', id: work.id }
    ])
    fireEvent.click(screen.getByText('Move to Folder'))
    fireEvent.click(screen.getByText('Remove from Folder'))
    // Below Play is before Work, the row that follows it.
    expect(bridge.placeProject).toHaveBeenCalledWith(repo.projectId, null, work.id)
  })

  it('takes the repo out to the end when its folder is the last row', () => {
    openMenu([], [work, play], [
      { kind: 'folder', id: work.id },
      { kind: 'folder', id: play.id }
    ])
    fireEvent.click(screen.getByText('Move to Folder'))
    fireEvent.click(screen.getByText('Remove from Folder'))
    expect(bridge.placeProject).toHaveBeenCalledWith(repo.projectId, null, null)
  })

  it('offers only New Folder when there is none yet, and creates one holding the repo', () => {
    openMenu([])
    fireEvent.click(screen.getByText('Move to Folder'))
    expect(items()).toEqual(['New Folder…'])

    fireEvent.click(screen.getByText('New Folder…'))
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'Clients' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(bridge.createRailFolder).toHaveBeenCalledWith('Clients', repo.projectId)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('repo header — whose status is whose', () => {
  it('shows the ROOT Worktree\'s status on the header dot, not the whole repo\'s', () => {
    // The bug: one agent working in one linked Worktree painted a spinner on
    // that row AND on the repo header, which reads as two things running.
    // The header row IS the root Worktree, so it reports the root and nothing
    // else — here the root is idle while a child works.
    renderHeader([rootWorktree, linked('w-a', 'working')])

    expect(screen.getByTitle('idle')).toBeTruthy()
    expect(screen.queryByTitle('working')).toBeNull()
  })

  it('summarises the hidden Worktrees on the chevron instead', () => {
    renderHeader([rootWorktree, linked('w-a', 'working')])
    // The app's status vocabulary, not a second palette: working is blue.
    expect(chevronClass()).toContain('text-blue')
    expect(screen.getByRole('button', { name: 'Expand repo — worktrees working' })).toBeTruthy()
  })

  it('pulses only for the states that are asking for a person', () => {
    renderHeader([rootWorktree, linked('w-a', 'needs_attention')])
    expect(chevronClass()).toContain('animate-pulse')

    cleanup()
    renderHeader([rootWorktree, linked('w-a', 'working')])
    expect(chevronClass()).not.toContain('animate-pulse')
  })

  it('stops pulsing once the rows it was standing in for are on screen', () => {
    // Expanded, every child shows its own dot; a second animation over the top
    // of them is noise. The tint stays, because it still summarises.
    renderHeader([rootWorktree, linked('w-a', 'needs_attention')], true)

    expect(chevronClass()).not.toContain('animate-pulse')
    expect(chevronClass()).toContain('text-amber-2')
  })

  it('leaves the chevron plain when nothing is hidden behind it', () => {
    renderHeader([rootWorktree, linked('w-a', 'idle')])

    expect(chevronClass()).toContain('text-faint')
    expect(screen.getByRole('button', { name: 'Expand repo' })).toBeTruthy()
  })

  it('counts only the hidden Worktrees in the needs-you badge', () => {
    // A root that needs you already says so in its own dot; counting it here
    // too would report the same agent twice on one row.
    renderHeader([{ ...rootWorktree, status: 'needs_attention' }, linked('w-a', 'needs_attention')])

    expect(screen.getByText('1')).toBeTruthy()
  })
})
