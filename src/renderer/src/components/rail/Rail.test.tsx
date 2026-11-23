import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project, ProjectFolder, RailItem, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import Rail from './Rail'
import { endRailDrag } from './folders'

/**
 * Folders and ordering in the rail: what is listed where, and what each
 * gesture asks main to do. Every one of those asks names rows by id and nothing
 * else. None of them carries a path or a setting, which is the whole promise
 * of the feature: arranging this panel leaves the projects alone.
 */

let bridge: Record<string, ReturnType<typeof vi.fn>>

const project = (id: string): Project => ({ id, name: id, repoPath: `C:/${id}`, defaultAgentId: 'claude', addedAt: 0 })

const worktree = (projectId: string, status: Worktree['status'] = 'idle'): Worktree => ({
  id: `w-${projectId}`,
  projectId,
  kind: 'root',
  name: 'main',
  path: `C:/${projectId}`,
  branch: 'main',
  status,
  taskId: null,
  layout: { type: 'pane', paneId: 'pane-1' },
  createdAt: 0,
  panes: []
})

const folder = (id: string, projectIds: string[], collapsed = false): ProjectFolder => ({
  id,
  name: id,
  collapsed,
  projectIds
})

/**
 * Three projects, alpha, beta and gamma. With no `rail` order given the rail
 * falls back to folders first, then the loose projects as listed.
 */
function renderRail(folders: ProjectFolder[], worktrees: Worktree[] = [], rail: RailItem[] = []): void {
  useStore.setState({
    projects: [project('alpha'), project('beta'), project('gamma')],
    projectFolders: folders,
    projectRail: rail,
    worktrees,
    tasks: [],
    activeProjectId: 'alpha',
    activeWorktreeId: null,
    expanded: {}
  } as unknown as Parameters<typeof useStore.setState>[0])
  render(<Rail />)
}

/** The folder's header row (the button that toggles it). */
const header = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}`) })
/** The element the Rail resolves a drag against: header plus the rows inside. */
const folderBox = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-folder-id="${id}"]`)!
/** The header row of a project, which is what drags. */
const projectRow = (name: string): HTMLElement => screen.getByText(name).closest<HTMLElement>('[draggable]')!
/** The scrolling list itself: what a drag is over once it is below every row. */
const emptyRail = (): HTMLElement => document.querySelector<HTMLElement>('aside .overflow-y-auto')!
/** The insertion line, wherever it is currently drawn. */
const marker = (within: ParentNode = document): Element | null => within.querySelector('.bg-accent')
const names = (): Array<string | null> => screen.getAllByText(/^(alpha|beta|gamma)$/).map((el) => el.textContent)
const dataTransfer = (): Record<string, unknown> => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' })

beforeEach(() => {
  window.localStorage.clear()
  bridge = {
    createProjectFolder: vi.fn(async () => folder('f-new', [])),
    renameProjectFolder: vi.fn(async () => undefined),
    removeProjectFolder: vi.fn(async () => undefined),
    setProjectFolderCollapsed: vi.fn(async () => undefined),
    placeProject: vi.fn(async () => undefined),
    placeProjectFolder: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
})

afterEach(() => {
  endRailDrag()
  cleanup()
  vi.unstubAllGlobals()
})

describe('rail folders — layout', () => {
  it('lists a folder with its projects inside and the rest loose below it', () => {
    renderRail([folder('work', ['beta'])])

    expect(within(folderBox('work')).getByText('beta')).toBeTruthy()
    expect(within(folderBox('work')).queryByText('alpha')).toBeNull()
    expect(names()).toEqual(['beta', 'alpha', 'gamma'])
    // Still three repos: a folder is not a project and is not counted as one.
    expect(screen.getByText(/3 repos/)).toBeTruthy()
  })

  it('lists the top level in its own order, with a folder between loose projects', () => {
    renderRail([folder('work', ['beta'])], [], [
      { kind: 'project', id: 'gamma' },
      { kind: 'folder', id: 'work' },
      { kind: 'project', id: 'alpha' }
    ])
    expect(names()).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('lists the projects in a folder in the order the folder keeps', () => {
    renderRail([folder('work', ['gamma', 'alpha'])])
    expect(names()).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('hides a collapsed folder\'s projects and says how many there are', () => {
    renderRail([folder('work', ['alpha', 'beta'], true)])

    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.queryByText('beta')).toBeNull()
    expect(header('work').getAttribute('aria-expanded')).toBe('false')
    expect(within(header('work')).getByTitle('2 repos')).toBeTruthy()
  })

  it('reports what a collapsed folder is hiding: a needs-you count and the status on the chevron', () => {
    renderRail(
      [folder('work', ['alpha', 'beta'], true)],
      [worktree('alpha', 'needs_attention'), worktree('beta', 'working'), worktree('gamma', 'needs_attention')]
    )

    // gamma is loose, so it is not this folder's news.
    expect(within(header('work')).getByText('1')).toBeTruthy()
    expect(within(header('work')).getByTitle('Worktrees needs you')).toBeTruthy()
    expect(header('work').querySelector('svg')?.getAttribute('class')).toContain('animate-pulse')
  })

  it('tells an empty folder apart from a collapsed one', () => {
    renderRail([folder('empty', [])])
    expect(within(folderBox('empty')).getByText(/Drag a repo here/)).toBeTruthy()
  })
})

describe('rail folders — actions', () => {
  it('toggles a folder from its header, by id', () => {
    renderRail([folder('work', ['beta'])])
    fireEvent.click(header('work'))
    expect(bridge.setProjectFolderCollapsed).toHaveBeenCalledWith('work', true)
  })

  it('creates a folder from the header button and opens it straight into its name', async () => {
    renderRail([folder('f-new', [])])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    })
    expect(bridge.createProjectFolder).toHaveBeenCalledWith('New Folder')

    const field = screen.getByLabelText('Folder name')
    fireEvent.change(field, { target: { value: '  Client work ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(bridge.renameProjectFolder).toHaveBeenCalledWith('f-new', 'Client work')
    expect(screen.queryByLabelText('Folder name')).toBeNull()
  })

  it('renames from the context menu, and Escape leaves the name alone', () => {
    renderRail([folder('work', [])])
    fireEvent.contextMenu(header('work'))
    fireEvent.click(screen.getByText('Rename'))

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'other' } })
    fireEvent.keyDown(screen.getByLabelText('Folder name'), { key: 'Escape' })
    expect(bridge.renameProjectFolder).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Folder name')).toBeNull()
  })

  it('confirms before deleting a folder that holds projects, and says they stay', () => {
    renderRail([folder('work', ['alpha', 'beta'])])
    fireEvent.contextMenu(header('work'))
    fireEvent.click(screen.getByText('Delete Folder'))

    expect(bridge.removeProjectFolder).not.toHaveBeenCalled()
    expect(screen.getByText(/Its 2 projects stay in Orbital/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Folder' }))
    expect(bridge.removeProjectFolder).toHaveBeenCalledWith('work')
  })

  it('deletes an empty folder without asking', () => {
    renderRail([folder('work', [])])
    fireEvent.contextMenu(header('work'))
    fireEvent.click(screen.getByText('Delete Folder'))
    expect(bridge.removeProjectFolder).toHaveBeenCalledWith('work')
  })
})

// jsdom lays nothing out: every box is 0×0 at the origin. So a pointer left at
// y = 0 is in the upper half of whatever it is over and on no edge of a folder
// header; y = 1 is below the middle (the lower half); y = -1 is on a header's
// top edge.
const LOWER = 1
const TOP_EDGE = -1

/**
 * Drop on `el` with the pointer at `clientY`. jsdom has no DragEvent, so the
 * event Testing Library builds is a plain Event that ignores `clientY` in its
 * init; the coordinate has to be put on it by hand.
 */
function dropAt(el: Element, clientY: number): void {
  const event = createEvent.drop(el, { dataTransfer: dataTransfer() })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(el, event)
}

describe('rail folders — dragging a project', () => {
  it('files a loose project in the folder it is dropped on, after the ones already there', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(projectRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(header('work'), { dataTransfer: dataTransfer() })
    // The folder lights up while the drop would land in it.
    expect(folderBox('work').firstElementChild?.className).toContain('ring-accent/50')
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('alpha', 'work', null)
    expect(folderBox('work').firstElementChild?.className).not.toContain('ring-accent/50')
  })

  it('reorders the projects inside a folder, showing where the drop would land', () => {
    renderRail([folder('work', ['alpha', 'beta', 'gamma'])])

    fireEvent.dragStart(projectRow('gamma'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(projectRow('alpha'), { dataTransfer: dataTransfer() })
    // A line inside the folder, and no "into the folder" highlight.
    expect(marker(folderBox('work'))).toBeTruthy()
    expect(folderBox('work').firstElementChild?.className).not.toContain('ring-accent/50')
    fireEvent.drop(projectRow('alpha'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', 'work', 'alpha')
    expect(marker()).toBeNull()
  })

  it('drops below a project from its lower half', () => {
    renderRail([folder('work', ['alpha', 'beta', 'gamma'])])

    fireEvent.dragStart(projectRow('alpha'), { dataTransfer: dataTransfer() })
    dropAt(projectRow('beta'), LOWER)

    expect(bridge.placeProject).toHaveBeenCalledWith('alpha', 'work', 'gamma')
  })

  it('reorders the loose projects at the top level', () => {
    renderRail([])

    fireEvent.dragStart(projectRow('gamma'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(projectRow('alpha'), { dataTransfer: dataTransfer() })
    expect(marker()).toBeTruthy()
    fireEvent.drop(projectRow('alpha'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', null, 'alpha')
  })

  it('takes a project out of its folder to the place it is dropped at', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(projectRow('beta'), { dataTransfer: dataTransfer() })
    fireEvent.drop(projectRow('gamma'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('beta', null, 'gamma')
  })

  it('moves a loose project into a folder at the place it is dropped at', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(projectRow('gamma'), { dataTransfer: dataTransfer() })
    fireEvent.drop(projectRow('beta'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', 'work', 'beta')
  })

  it('goes above a folder, not into it, from the top edge of its header', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(projectRow('gamma'), { dataTransfer: dataTransfer() })
    dropAt(header('work'), TOP_EDGE)

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', null, 'work')
  })

  it('goes last when dropped below every row', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(projectRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.drop(emptyRail(), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('alpha', null, null)
  })

  it('does nothing when a project is dropped where it already is', () => {
    renderRail([folder('work', ['beta'])])

    // On its own folder, on itself, and on the near half of its neighbour.
    fireEvent.dragStart(projectRow('beta'), { dataTransfer: dataTransfer() })
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.dragStart(projectRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.drop(projectRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.dragStart(projectRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.drop(projectRow('gamma'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).not.toHaveBeenCalled()
  })
})

describe('rail folders — dragging a folder', () => {
  it('moves a folder in among the loose projects', () => {
    renderRail([folder('work', []), folder('play', [])])

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(projectRow('beta'), { dataTransfer: dataTransfer() })
    expect(marker()).toBeTruthy()
    fireEvent.drop(projectRow('beta'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProjectFolder).toHaveBeenCalledWith('work', 'beta')
    expect(bridge.placeProject).not.toHaveBeenCalled()
  })

  it('goes before another folder from the upper half of its header, and after it from the lower', () => {
    renderRail([folder('work', []), folder('play', [])])

    fireEvent.dragStart(header('play'), { dataTransfer: dataTransfer() })
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })
    expect(bridge.placeProjectFolder).toHaveBeenLastCalledWith('play', 'work')

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    dropAt(header('play'), LOWER)
    // After play is before whatever follows play.
    expect(bridge.placeProjectFolder).toHaveBeenLastCalledWith('work', 'alpha')
  })

  it('never lands inside another folder: over its projects it goes after that folder', () => {
    renderRail([folder('work', []), folder('play', ['beta'])])

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    // Over a project in play, which sits below play's header.
    dropAt(projectRow('beta'), LOWER)

    expect(bridge.placeProjectFolder).toHaveBeenCalledWith('work', 'alpha')
    expect(bridge.placeProject).not.toHaveBeenCalled()
  })

  it('goes last when dropped below every row', () => {
    renderRail([folder('work', []), folder('play', [])])

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.drop(emptyRail(), { dataTransfer: dataTransfer() })

    expect(bridge.placeProjectFolder).toHaveBeenCalledWith('work', null)
  })
})

describe('rail folders — other drags', () => {
  it('ignores a drop that did not start as a rail drag', () => {
    renderRail([folder('work', ['beta'])])
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.drop(projectRow('alpha'), { dataTransfer: dataTransfer() })
    expect(bridge.placeProject).not.toHaveBeenCalled()
    expect(bridge.placeProjectFolder).not.toHaveBeenCalled()
  })
})
