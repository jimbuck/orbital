import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project, Repo, RailFolder, RailItem, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import Rail from './Rail'
import { endRailDrag } from './folders'

/**
 * Folders and ordering in the rail: what is listed where, and what each
 * gesture asks main to do. Every one of those asks names rows by id and nothing
 * else. None of them carries a path or a setting, which is the whole promise
 * of the feature: arranging this panel leaves the repos alone.
 */

let bridge: Record<string, ReturnType<typeof vi.fn>>

/** Each repo is alone in a project of the same id; the rail arranges (and drags) the project. */
const repo = (id: string): Repo => ({
  id,
  name: id,
  repoPath: `C:/${id}`,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId: id
})
const project = (id: string): Project => ({
  id,
  name: id,
  rootPath: `C:/${id}`,
  homeRepoId: null,
  managedBlock: true,
  repoIds: [id],
  createdAt: 0
})

const worktree = (repoId: string, status: Worktree['status'] = 'idle'): Worktree => ({
  id: `w-${repoId}`,
  repoId,
  projectId: repoId,
  kind: 'root',
  name: 'main',
  path: `C:/${repoId}`,
  branch: 'main',
  status,
  taskId: null,
  layout: { type: 'pane', paneId: 'pane-1' },
  createdAt: 0,
  panes: []
})

const folder = (id: string, projectIds: string[], collapsed = false): RailFolder => ({
  id,
  name: id,
  collapsed,
  projectIds
})

/**
 * Three repos, alpha, beta and gamma. With no `rail` order given the rail
 * falls back to folders first, then the loose repos as listed.
 */
function renderRail(folders: RailFolder[], worktrees: Worktree[] = [], rail: RailItem[] = []): void {
  useStore.setState({
    repos: [repo('alpha'), repo('beta'), repo('gamma')],
    projects: [project('alpha'), project('beta'), project('gamma')],
    railFolders: folders,
    railItems: rail,
    worktrees,
    tasks: [],
    activeRepoId: 'alpha',
    activeWorktreeId: null,
    expanded: {}
  } as unknown as Parameters<typeof useStore.setState>[0])
  render(<Rail />)
}

/** The folder's header row (the button that toggles it). */
const header = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}`) })
/** The element the Rail resolves a drag against: header plus the rows inside. */
const folderBox = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-folder-id="${id}"]`)!
/** The header row of a repo, which is what drags. */
const repoRow = (name: string): HTMLElement => screen.getByText(name).closest<HTMLElement>('[draggable]')!
/** The scrolling list itself: what a drag is over once it is below every row. */
const emptyRail = (): HTMLElement => document.querySelector<HTMLElement>('aside .overflow-y-auto')!
/** The insertion line, wherever it is currently drawn. */
const marker = (within: ParentNode = document): Element | null => within.querySelector('.bg-accent')
const names = (): Array<string | null> => screen.getAllByText(/^(alpha|beta|gamma)$/).map((el) => el.textContent)
const dataTransfer = (): Record<string, unknown> => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' })

beforeEach(() => {
  // Node 26 ships its own localStorage, unset without --localstorage-file,
  // which shadows jsdom's unless NODE_OPTIONS=--no-experimental-webstorage.
  // The rail only remembers its width there, so a map stands in.
  if (window.localStorage) window.localStorage.clear()
  else {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear()
    })
  }
  bridge = {
    createRailFolder: vi.fn(async () => folder('f-new', [])),
    renameRailFolder: vi.fn(async () => undefined),
    removeRailFolder: vi.fn(async () => undefined),
    setRailFolderCollapsed: vi.fn(async () => undefined),
    placeProject: vi.fn(async () => undefined),
    placeRailFolder: vi.fn(async () => undefined),
    addRepoToProject: vi.fn(async () => undefined),
    detachRepo: vi.fn(async () => null)
  }
  vi.stubGlobal('orbital', bridge)
})

afterEach(() => {
  endRailDrag()
  cleanup()
  vi.unstubAllGlobals()
})

describe('rail folders — layout', () => {
  it('lists a folder with its repos inside and the rest loose below it', () => {
    renderRail([folder('work', ['beta'])])

    expect(within(folderBox('work')).getByText('beta')).toBeTruthy()
    expect(within(folderBox('work')).queryByText('alpha')).toBeNull()
    expect(names()).toEqual(['beta', 'alpha', 'gamma'])
    // Still three repos: a folder is not a repo and is not counted as one.
    expect(screen.getByText(/3 projects/)).toBeTruthy()
  })

  it('lists the top level in its own order, with a folder between loose repos', () => {
    renderRail([folder('work', ['beta'])], [], [
      { kind: 'project', id: 'gamma' },
      { kind: 'folder', id: 'work' },
      { kind: 'project', id: 'alpha' }
    ])
    expect(names()).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('lists the repos in a folder in the order the folder keeps', () => {
    renderRail([folder('work', ['gamma', 'alpha'])])
    expect(names()).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('hides a collapsed folder\'s repos and says how many there are', () => {
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
    expect(within(folderBox('empty')).getByText(/Drag a repo or project here/)).toBeTruthy()
  })
})

describe('rail folders — actions', () => {
  it('toggles a folder from its header, by id', () => {
    renderRail([folder('work', ['beta'])])
    fireEvent.click(header('work'))
    expect(bridge.setRailFolderCollapsed).toHaveBeenCalledWith('work', true)
  })

  it('creates a folder from the header button and opens it straight into its name', async () => {
    renderRail([folder('f-new', [])])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    })
    expect(bridge.createRailFolder).toHaveBeenCalledWith('New Folder')

    const field = screen.getByLabelText('Folder name')
    fireEvent.change(field, { target: { value: '  Client work ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(bridge.renameRailFolder).toHaveBeenCalledWith('f-new', 'Client work')
    expect(screen.queryByLabelText('Folder name')).toBeNull()
  })

  it('renames from the context menu, and Escape leaves the name alone', () => {
    renderRail([folder('work', [])])
    fireEvent.contextMenu(header('work'))
    fireEvent.click(screen.getByText('Rename'))

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'other' } })
    fireEvent.keyDown(screen.getByLabelText('Folder name'), { key: 'Escape' })
    expect(bridge.renameRailFolder).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Folder name')).toBeNull()
  })

  it('confirms before deleting a folder that holds repos, and says they stay', () => {
    renderRail([folder('work', ['alpha', 'beta'])])
    fireEvent.contextMenu(header('work'))
    fireEvent.click(screen.getByText('Delete Folder'))

    expect(bridge.removeRailFolder).not.toHaveBeenCalled()
    expect(screen.getByText(/Everything in it stays in Orbital, at the top level/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Folder' }))
    expect(bridge.removeRailFolder).toHaveBeenCalledWith('work')
  })

  it('deletes an empty folder without asking', () => {
    renderRail([folder('work', [])])
    fireEvent.contextMenu(header('work'))
    fireEvent.click(screen.getByText('Delete Folder'))
    expect(bridge.removeRailFolder).toHaveBeenCalledWith('work')
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

/** Drag over `el` with the pointer at `clientY` (see dropAt). */
function dragOverAt(el: Element, clientY: number): void {
  const event = createEvent.dragOver(el, { dataTransfer: dataTransfer() })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(el, event)
}

describe('rail folders — dragging a repo', () => {
  it('files a loose repo in the folder it is dropped on, after the ones already there', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(repoRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(header('work'), { dataTransfer: dataTransfer() })
    // The folder lights up while the drop would land in it.
    expect(folderBox('work').firstElementChild?.className).toContain('ring-accent/50')
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('alpha', 'work', null)
    expect(folderBox('work').firstElementChild?.className).not.toContain('ring-accent/50')
  })

  it('reorders the repos inside a folder, showing where the drop would land', () => {
    renderRail([folder('work', ['alpha', 'beta', 'gamma'])])

    // A repo row's top quarter is "before it"; its middle would start a project.
    fireEvent.dragStart(repoRow('gamma'), { dataTransfer: dataTransfer() })
    dragOverAt(repoRow('alpha'), TOP_EDGE)
    // A line inside the folder, and no "into the folder" highlight.
    expect(marker(folderBox('work'))).toBeTruthy()
    expect(folderBox('work').firstElementChild?.className).not.toContain('ring-accent/50')
    dropAt(repoRow('alpha'), TOP_EDGE)

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', 'work', 'alpha')
    expect(marker()).toBeNull()
  })

  it('drops below a repo from its lower half', () => {
    renderRail([folder('work', ['alpha', 'beta', 'gamma'])])

    fireEvent.dragStart(repoRow('alpha'), { dataTransfer: dataTransfer() })
    dropAt(repoRow('beta'), LOWER)

    expect(bridge.placeProject).toHaveBeenCalledWith('alpha', 'work', 'gamma')
  })

  it('reorders the loose repos at the top level', () => {
    renderRail([])

    fireEvent.dragStart(repoRow('gamma'), { dataTransfer: dataTransfer() })
    dragOverAt(repoRow('alpha'), TOP_EDGE)
    expect(marker()).toBeTruthy()
    dropAt(repoRow('alpha'), TOP_EDGE)

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', null, 'alpha')
  })

  it('takes a repo out of its folder to the place it is dropped at', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(repoRow('beta'), { dataTransfer: dataTransfer() })
    dropAt(repoRow('gamma'), TOP_EDGE)

    expect(bridge.placeProject).toHaveBeenCalledWith('beta', null, 'gamma')
  })

  it('moves a loose repo into a folder at the place it is dropped at', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(repoRow('gamma'), { dataTransfer: dataTransfer() })
    dropAt(repoRow('beta'), TOP_EDGE)

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', 'work', 'beta')
  })

  it('goes above a folder, not into it, from the top edge of its header', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(repoRow('gamma'), { dataTransfer: dataTransfer() })
    dropAt(header('work'), TOP_EDGE)

    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', null, 'work')
  })

  it('goes last when dropped below every row', () => {
    renderRail([folder('work', ['beta'])])

    fireEvent.dragStart(repoRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.drop(emptyRail(), { dataTransfer: dataTransfer() })

    expect(bridge.placeProject).toHaveBeenCalledWith('alpha', null, null)
  })

  it('does nothing when a repo is dropped where it already is', () => {
    renderRail([folder('work', ['beta'])])

    // On its own folder, on itself, and on the near half of its neighbour.
    fireEvent.dragStart(repoRow('beta'), { dataTransfer: dataTransfer() })
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.dragStart(repoRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.drop(repoRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.dragStart(repoRow('alpha'), { dataTransfer: dataTransfer() })
    dropAt(repoRow('gamma'), TOP_EDGE)

    expect(bridge.placeProject).not.toHaveBeenCalled()
    expect(bridge.addRepoToProject).not.toHaveBeenCalled()
  })
})

describe('rail folders — dragging a folder', () => {
  it('moves a folder in among the loose repos', () => {
    renderRail([folder('work', []), folder('play', [])])

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(repoRow('beta'), { dataTransfer: dataTransfer() })
    expect(marker()).toBeTruthy()
    fireEvent.drop(repoRow('beta'), { dataTransfer: dataTransfer() })

    expect(bridge.placeRailFolder).toHaveBeenCalledWith('work', 'beta')
    expect(bridge.placeProject).not.toHaveBeenCalled()
  })

  it('goes before another folder from the upper half of its header, and after it from the lower', () => {
    renderRail([folder('work', []), folder('play', [])])

    fireEvent.dragStart(header('play'), { dataTransfer: dataTransfer() })
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })
    expect(bridge.placeRailFolder).toHaveBeenLastCalledWith('play', 'work')

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    dropAt(header('play'), LOWER)
    // After play is before whatever follows play.
    expect(bridge.placeRailFolder).toHaveBeenLastCalledWith('work', 'alpha')
  })

  it('never lands inside another folder: over its repos it goes after that folder', () => {
    renderRail([folder('work', []), folder('play', ['beta'])])

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    // Over a repo in play, which sits below play's header.
    dropAt(repoRow('beta'), LOWER)

    expect(bridge.placeRailFolder).toHaveBeenCalledWith('work', 'alpha')
    expect(bridge.placeProject).not.toHaveBeenCalled()
  })

  it('goes last when dropped below every row', () => {
    renderRail([folder('work', []), folder('play', [])])

    fireEvent.dragStart(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.drop(emptyRail(), { dataTransfer: dataTransfer() })

    expect(bridge.placeRailFolder).toHaveBeenCalledWith('work', null)
  })
})

describe('rail folders — other drags', () => {
  it('ignores a drop that did not start as a rail drag', () => {
    renderRail([folder('work', ['beta'])])
    fireEvent.drop(header('work'), { dataTransfer: dataTransfer() })
    fireEvent.drop(repoRow('alpha'), { dataTransfer: dataTransfer() })
    expect(bridge.placeProject).not.toHaveBeenCalled()
    expect(bridge.placeRailFolder).not.toHaveBeenCalled()
  })
})

describe('dragging a repo onto another: starting a project', () => {
  it('says what the drop will make while over the middle of a plain repo row', () => {
    renderRail([])
    fireEvent.dragStart(repoRow('alpha'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(repoRow('gamma'), { dataTransfer: dataTransfer() })

    expect(within(repoRow('gamma')).getByText('Drop to start a project')).toBeTruthy()
    expect(repoRow('gamma').className).toContain('ring-accent/50')
    // No insertion line: this is not a place in a list.
    expect(marker()).toBeNull()
  })

  it('adds the repo to that project, then opens the new header into its name and says so', async () => {
    renderRail([])
    fireEvent.dragStart(repoRow('alpha'), { dataTransfer: dataTransfer() })
    await act(async () => {
      fireEvent.drop(repoRow('gamma'), { dataTransfer: dataTransfer() })
    })

    expect(bridge.addRepoToProject).toHaveBeenCalledWith('gamma', 'alpha', null)
    expect(bridge.placeProject).not.toHaveBeenCalled()
    expect(useStore.getState().renamingProjectId).toBe('gamma')
    expect(useStore.getState().expanded.gamma).toBe(true)
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'alpha and gamma are now a project. Name it.'
    )
  })

  it('goes after a plain repo row from its bottom quarter, without joining it', () => {
    renderRail([])
    fireEvent.dragStart(repoRow('gamma'), { dataTransfer: dataTransfer() })
    dropAt(repoRow('alpha'), LOWER)
    expect(bridge.placeProject).toHaveBeenCalledWith('gamma', null, 'beta')
    expect(bridge.addRepoToProject).not.toHaveBeenCalled()
  })
})
