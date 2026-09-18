import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Project as ProjectModel, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import Project from './Project'

/**
 * The project header's context menu, and specifically which items survive when
 * the project has NO root Worktree row.
 *
 * That state is not a corner case and it is not transient: the root row comes
 * from `reconcileProjectWorktrees`, which returns without writing any rows when
 * `git worktree list` fails — a folder that was never a repo, or has become
 * unreadable, permanently has none. "Open in Explorer" / "Open in External
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
    removeProject: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render the header with `worktrees` seeded, then right-click it open. */
function openMenu(worktrees: Worktree[]): void {
  useStore.setState({
    projects: [project],
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
      'New Worktree',
      'Open in Explorer',
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
      'New Worktree',
      'Clear Status',
      'Open in Explorer',
      'Open in External Terminal',
      'Remove project'
    ])
  })

  it('sends the OS hand-offs the PROJECT id, with no path over the bridge', () => {
    openMenu([])

    fireEvent.click(screen.getByText('Open in Explorer'))
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
