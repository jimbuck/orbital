import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Project as ProjectModel, ProjectFolder, RailItem, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import Project from './Project'

/**
 * The project header's context menu, and specifically which items survive when
 * the project has NO root Worktree row.
 *
 * That state is not a corner case and it is not transient: the root row comes
 * from `reconcileProjectWorktrees`, which returns without writing any rows when
 * `git worktree list` fails — a folder that was never a repo, or has become
 * unreadable, permanently has none. "Open in File Explorer" / "Open in External
 * Terminal" are what a user reaches for in exactly that state, so they must not
 * be conditioned on a Worktree existing. Clear Status genuinely acts on a
 * Worktree row and correctly disappears with it.
 */

let bridge: Record<string, ReturnType<typeof vi.fn>>

const project: ProjectModel = {
  id: 'p1',
  name: 'orbital',
  repoPath: 'C:/repo',
  defaultAgentId: 'claude',
  addedAt: 0
}

const rootWorktree: Worktree = {
  id: 'w-root',
  projectId: project.id,
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
    openProjectPath: vi.fn(async () => undefined),
    openProjectInTerminal: vi.fn(async () => undefined),
    clearWorktreeStatus: vi.fn(async () => undefined),
    renameProject: vi.fn(async () => undefined),
    removeProject: vi.fn(async () => undefined),
    placeProject: vi.fn(async () => undefined),
    createProjectFolder: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render the header with `worktrees` (and rail `folders`) seeded, then right-click it open. */
function openMenu(worktrees: Worktree[], folders: ProjectFolder[] = [], rail: RailItem[] = []): void {
  useStore.setState({
    projects: [project],
    projectFolders: folders,
    projectRail: rail,
    worktrees,
    tasks: [],
    activeProjectId: project.id,
    activeWorktreeId: null,
    expanded: {}
  } as unknown as Parameters<typeof useStore.setState>[0])
  render(<Project project={project} />)
  fireEvent.contextMenu(screen.getByText(project.name))
}

/** A linked Worktree in `status`, for the group-summary tests. */
function linked(id: string, status: Worktree['status']): Worktree {
  return { ...rootWorktree, id, kind: 'linked', name: id, status }
}

/** Render the header with `worktrees` seeded, and the project expanded or not. */
function renderHeader(worktrees: Worktree[], expanded = false): void {
  useStore.setState({
    projects: [project],
    worktrees,
    tasks: [],
    activeProjectId: project.id,
    activeWorktreeId: null,
    expanded: expanded ? { [project.id]: true } : {}
  } as unknown as Parameters<typeof useStore.setState>[0])
  render(<Project project={project} />)
}

/** The chevron's className — where the group summary is painted. */
function chevronClass(): string {
  const button = screen.getByRole('button', { name: /project/ })
  return button.querySelector('svg')?.getAttribute('class') ?? ''
}

/** Menu item labels, in rendered order. */
function items(): string[] {
  return screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')
}

describe('project context menu', () => {
  it('offers the OS hand-offs when the project has no root Worktree', () => {
    openMenu([])
    expect(items()).toEqual([
      'Rename',
      'Move to Folder',
      'New Worktree',
      'Open in File Explorer',
      'Open in External Terminal',
      'Remove project'
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
      'Remove project'
    ])
  })

  it('sends the OS hand-offs the PROJECT id, with no path over the bridge', () => {
    openMenu([])

    fireEvent.click(screen.getByText('Open in File Explorer'))
    expect(bridge.openProjectPath).toHaveBeenCalledWith(project.id)
    // A path parameter here would be the renderer telling main what to open,
    // which is the shape the containment work removed.
    expect(bridge.openProjectPath.mock.calls[0]).toHaveLength(1)

    fireEvent.contextMenu(screen.getByText(project.name))
    fireEvent.click(screen.getByText('Open in External Terminal'))
    expect(bridge.openProjectInTerminal).toHaveBeenCalledWith(project.id)
    expect(bridge.openProjectInTerminal.mock.calls[0]).toHaveLength(1)
  })

  it('still routes Clear Status at the root Worktree row', () => {
    openMenu([rootWorktree])
    fireEvent.click(screen.getByText('Clear Status'))
    expect(bridge.clearWorktreeStatus).toHaveBeenCalledWith(rootWorktree.id)
  })
})

describe('project context menu — Move to Folder', () => {
  const work: ProjectFolder = { id: 'f-work', name: 'Work', collapsed: false, projectIds: [] }
  const play: ProjectFolder = { id: 'f-play', name: 'Play', collapsed: false, projectIds: [project.id] }

  it('lists the folders in place of the menu and files the project in the one picked', () => {
    openMenu([], [work, play])
    fireEvent.click(screen.getByText('Move to Folder'))

    expect(items()).toEqual(['Work', 'Playcurrent', 'New Folder…', 'Remove from Folder'])
    // The folder it is already in is shown, but is not a move.
    expect((screen.getByRole('menuitem', { name: /Play/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByText('Work'))
    // A project id and a folder id (last in it), and nothing else: no path, no setting.
    expect(bridge.placeProject.mock.calls).toEqual([[project.id, work.id, null]])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('takes the project out of its folder, to the top level just below it', () => {
    openMenu([], [work, play], [
      { kind: 'folder', id: play.id },
      { kind: 'folder', id: work.id }
    ])
    fireEvent.click(screen.getByText('Move to Folder'))
    fireEvent.click(screen.getByText('Remove from Folder'))
    // Below Play is before Work, the row that follows it.
    expect(bridge.placeProject).toHaveBeenCalledWith(project.id, null, work.id)
  })

  it('takes the project out to the end when its folder is the last row', () => {
    openMenu([], [work, play], [
      { kind: 'folder', id: work.id },
      { kind: 'folder', id: play.id }
    ])
    fireEvent.click(screen.getByText('Move to Folder'))
    fireEvent.click(screen.getByText('Remove from Folder'))
    expect(bridge.placeProject).toHaveBeenCalledWith(project.id, null, null)
  })

  it('offers only New Folder when there is none yet, and creates one holding the project', () => {
    openMenu([])
    fireEvent.click(screen.getByText('Move to Folder'))
    expect(items()).toEqual(['New Folder…'])

    fireEvent.click(screen.getByText('New Folder…'))
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'Clients' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(bridge.createProjectFolder).toHaveBeenCalledWith('Clients', project.id)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('project header — whose status is whose', () => {
  it('shows the ROOT Worktree\'s status on the header dot, not the whole project\'s', () => {
    // The bug: one agent working in one linked Worktree painted a spinner on
    // that row AND on the project header, which reads as two things running.
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
    expect(screen.getByRole('button', { name: 'Expand project — worktrees working' })).toBeTruthy()
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
    expect(screen.getByRole('button', { name: 'Expand project' })).toBeTruthy()
  })

  it('counts only the hidden Worktrees in the needs-you badge', () => {
    // A root that needs you already says so in its own dot; counting it here
    // too would report the same agent twice on one row.
    renderHeader([{ ...rootWorktree, status: 'needs_attention' }, linked('w-a', 'needs_attention')])

    expect(screen.getByText('1')).toBeTruthy()
  })
})
