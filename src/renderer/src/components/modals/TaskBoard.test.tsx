import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useStore } from '@renderer/store'
import type { Project, Repo, Task, Worktree } from '@shared/types'

import ModalRoot from './ModalRoot'
import { descriptionPreview } from './TaskBoard'

/**
 * The task board shows one project: the active one, until another is picked
 * in its header. It has a Project lane and a lane for each repo that has a
 * task, and is one plain board when no task is filed under a repo. Dropping a
 * card across lanes files it under the lane's repo, unless a live worktree
 * pins it.
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
  codeWorkspace: false,
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
  it('names the active project and lays out Project first, then the repos that have tasks', () => {
    seed('acme', [task('a', 1, 'api'), task('n', 2, null), task('x', 3, 'web', { projectId: 'solo' })])
    openBoard()
    expect(screen.getByRole('dialog', { name: 'Tasks in Acme' })).toBeTruthy()
    expect(screen.getByText('2 repos · 2 tasks')).toBeTruthy()
    const lanes = screen.getAllByRole('group', { name: /, Todo, / }).map((g) => g.getAttribute('aria-label'))
    // Nothing of Acme's is filed under web, so web has no lane.
    expect(lanes).toEqual(['Project, no repo, Todo, 1 tasks', 'api, Todo, 1 tasks'])
    // Another project's task never shows.
    expect(screen.queryByText('task x')).toBeNull()
  })

  it('is one plain board while no task is filed under a repo, and adds tasks with none', async () => {
    const createTask = vi.fn(async () => task('new', 9, null))
    vi.stubGlobal('orbital', { updateTask, createTask })
    seed('acme', [task('n', 1, null), task('m', 2, null, { status: 'done' })])
    openBoard()
    expect(screen.getByText('2 repos · 2 tasks')).toBeTruthy()
    // No lane labels, so the cells are named by status alone.
    expect(screen.queryByText('Project')).toBeNull()
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Draft, 0 tasks',
      'Todo, 1 tasks',
      'In progress, 0 tasks',
      'Review, 0 tasks',
      'Done, 1 tasks'
    ])
    drag('task n', 'Done, 1 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('n', { status: 'done' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Task' })[1])
    fireEvent.change(screen.getByPlaceholderText('Task title…'), { target: { value: 'Spans repos' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText('Task title…'), { key: 'Enter' })
    })
    expect(createTask).toHaveBeenCalledWith('acme', 'Spans repos', null)
  })

  it('files a card under the lane it is dropped in, and clears it in the Project lane', () => {
    seed('acme', [task('a', 1, 'api'), task('n', 2, null), task('w', 3, 'web')])
    openBoard()
    drag('task n', 'web, Todo, 1 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('n', { repoId: 'web' })
    drag('task a', 'Project, no repo, In progress, 0 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('a', { status: 'in_progress', repoId: null })
    // Within its own lane only the status changes.
    drag('task a', 'api, Done, 0 tasks')
    expect(updateTask).toHaveBeenLastCalledWith('a', { status: 'done' })
  })

  it('refuses to move a card with a live worktree to another lane', () => {
    const w = { id: 'w1', repoId: 'api', projectId: 'acme', kind: 'linked', panes: [] } as unknown as Worktree
    seed('acme', [task('a', 1, 'api', { worktreeId: 'w1' }), task('w', 2, 'web')], [w])
    openBoard()
    drag('task a', 'web, Todo, 1 tasks')
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

  it('switches to another project from its header, without changing the active one', async () => {
    const listArchivedTasks = vi.fn(async () => [
      task('old', 7, null, { projectId: 'solo', title: 'Shelved in solo', archivedAt: 5 }),
      task('older', 8, null, { title: 'Shelved in Acme', archivedAt: 5 })
    ])
    vi.stubGlobal('orbital', { updateTask, listArchivedTasks })
    seed('acme', [task('a', 1, 'api'), task('s', 2, null, { projectId: 'solo' })])
    openBoard()
    const picker = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement
    expect(picker.value).toBe('acme')
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Acme', 'solo'])

    fireEvent.change(picker, { target: { value: 'solo' } })
    expect(screen.getByRole('dialog', { name: 'Tasks in solo' })).toBeTruthy()
    expect(screen.getByText('task s')).toBeTruthy()
    expect(screen.queryByText('task a')).toBeNull()
    // Only the board looks elsewhere: the session underneath is where it was.
    expect(useStore.getState().activeProjectId).toBe('acme')
    // The pick holds when the rail's project changes behind the board.
    act(() => useStore.setState({ activeProjectId: null }))
    expect(screen.getByRole('dialog', { name: 'Tasks in solo' })).toBeTruthy()

    // The archive it opens is the shown project's.
    fireEvent.click(screen.getByRole('button', { name: /archived tasks/i }))
    expect(await screen.findByText('Shelved in solo')).toBeTruthy()
    expect(screen.queryByText('Shelved in Acme')).toBeNull()
  })

  it('offers no picker when there is only one project', () => {
    seed('solo', [])
    act(() => useStore.setState({ projects: [solo] }))
    openBoard()
    expect(screen.getByText('Tasks in solo')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

/**
 * Everything that can be done to a card, a column, a lane or the board is on
 * a button within reach and again on a right-click menu.
 */
describe('working the task board', () => {
  let createTask: ReturnType<typeof vi.fn>
  let archiveTask: ReturnType<typeof vi.fn>
  let openModal: ReturnType<typeof vi.fn>
  const realOpenModal = useStore.getState().openModal

  const linked = (id: string, repoId: string): Worktree =>
    ({ id, repoId, projectId: 'acme', kind: 'linked', name: id, branch: `feat/${id}`, status: 'working', panes: [] }) as unknown as Worktree
  const card = (title: string): HTMLElement => screen.getByText(title).closest('[data-task-id]') as HTMLElement
  const cell = (name: string | RegExp): HTMLElement => screen.getByRole('group', { name })
  const laneHead = (name: RegExp): HTMLElement => within(screen.getByRole('dialog')).getByRole('button', { name })
  const menuItems = (): (string | null)[] =>
    within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((i) => i.textContent)
  const pick = (label: string): void => fireEvent.click(within(screen.getByRole('menu')).getByText(label))

  /** Open the board, then stand in for openModal so nothing it opens has to render. */
  function openSpiedBoard(): void {
    openBoard()
    openModal = vi.fn()
    act(() => useStore.setState({ openModal } as unknown as Parameters<typeof useStore.setState>[0]))
  }

  beforeEach(() => {
    createTask = vi.fn(async () => task('new', 9, 'api'))
    archiveTask = vi.fn(async () => undefined)
    vi.stubGlobal(
      'orbital',
      new Proxy({ updateTask, createTask, archiveTask } as Record<string, unknown>, {
        get: (t, k: string) => (k in t ? t[k] : vi.fn(async () => null))
      })
    )
  })

  afterEach(() => {
    useStore.setState({ openModal: realOpenModal } as unknown as Parameters<typeof useStore.setState>[0])
  })

  it('shows on a card what it is about, and opens the task when the card is clicked', () => {
    const a = task('a', 1, 'api', {
      description: '## Why\n\n- **Folders** collapse on `drag`',
      tags: ['bug'],
      worktreeId: 'w1',
      createdBy: 'agent'
    })
    seed('acme', [a], [linked('w1', 'api')])
    openSpiedBoard()
    const c = card('task a')
    expect(within(c).getByText('Why Folders collapse on drag')).toBeTruthy()
    expect(within(c).getByText('bug')).toBeTruthy()
    expect(within(c).getByLabelText('Filed by an agent')).toBeTruthy()
    // The column already says the status.
    expect(within(c).queryByText('In progress')).toBeNull()
    expect(within(c).queryByText('Todo')).toBeNull()

    fireEvent.click(c)
    expect(openModal).toHaveBeenLastCalledWith('editTask', { task: a })

    // Its worktree, with that worktree's live status; going there leaves the board.
    openModal.mockClear()
    fireEvent.click(within(c).getByRole('button', { name: 'Go to worktree w1, working' }))
    expect(useStore.getState().activeWorktreeId).toBe('w1')
    expect(openModal).toHaveBeenCalledTimes(1)
    expect(openModal).toHaveBeenCalledWith(null)
  })

  it("puts a card's actions on the card: start a worktree, archive when done, and the full menu", () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const a = task('a', 1, 'api', { description: 'notes', tags: ['x'] })
    seed('acme', [a, task('d', 2, null, { status: 'done' })])
    openSpiedBoard()

    fireEvent.click(screen.getByRole('button', { name: 'Start a worktree from task #1' }))
    expect(openModal).toHaveBeenLastCalledWith('newWorktree', { task: a })
    // Neither button opens the task as well.
    expect(openModal).toHaveBeenCalledTimes(1)

    // A done card trades the start button for archive.
    expect(screen.queryByRole('button', { name: 'Start a worktree from task #2' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archive task #2' }))
    expect(archiveTask).toHaveBeenCalledWith('d')

    fireEvent.click(screen.getByRole('button', { name: 'More actions for task #1' }))
    expect(menuItems()).toEqual([
      'Edit task',
      'Start Worktree',
      'Repoapi',
      'Draft',
      'Todocurrent',
      'In progress',
      'Review',
      'Done',
      'Copy reference#1',
      'Duplicate',
      'Archive task'
    ])
    pick('Duplicate')
    expect(createTask).toHaveBeenCalledWith('acme', 'task a', 'api', 'notes', ['x'])
    expect(screen.queryByRole('menu')).toBeNull()

    // The same menu on a right-click.
    fireEvent.contextMenu(card('task a'))
    pick('Copy reference')
    expect(writeText).toHaveBeenCalledWith('#1 task a')
    expect(openModal).toHaveBeenCalledTimes(1)
  })

  it('closes a menu on Escape and leaves the board open under it', () => {
    seed('acme', [task('a', 1, 'api')])
    openBoard()
    fireEvent.contextMenu(card('task a'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useStore.getState().modalStack.map((m) => m.type)).toEqual(['board'])
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(useStore.getState().modalStack).toEqual([])
  })

  it('has a menu on a column, a cell, a lane and the board itself', async () => {
    seed('acme', [task('a', 1, 'api'), task('d1', 2, null, { status: 'done' }), task('d2', 3, 'api', { status: 'done' })])
    openSpiedBoard()

    // A column: add to it, and clear out Done in one go (asked first).
    fireEvent.contextMenu(screen.getByText('Done'))
    expect(menuItems()).toEqual(['New Task in Done', 'Archive All 2 Done Tasks', 'Collapse All Lanes'])
    pick('Archive All 2 Done Tasks')
    expect(archiveTask).not.toHaveBeenCalled()
    expect(screen.getByText('Archive these 2 done tasks?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(archiveTask.mock.calls.map((c) => c[0])).toEqual(['d1', 'd2'])

    // A cell: a task right there, in that lane and status. Enter keeps the input for the next one.
    fireEvent.contextMenu(cell('api, Done, 1 tasks'))
    expect(menuItems()).toEqual(['New Task Here', 'Archive the Done Task', 'Collapse All Lanes'])
    pick('New Task Here')
    const input = within(cell('api, Done, 1 tasks')).getByLabelText('New task title')
    fireEvent.change(input, { target: { value: 'Shipped it' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(createTask).toHaveBeenLastCalledWith('acme', 'Shipped it', 'api')
    expect(updateTask).toHaveBeenLastCalledWith('new', { status: 'done' })
    expect((within(cell('api, Done, 1 tasks')).getByLabelText('New task title') as HTMLInputElement).value).toBe('')
    // An empty Enter is "done adding".
    fireEvent.keyDown(within(cell('api, Done, 1 tasks')).getByLabelText('New task title'), { key: 'Enter' })
    expect(screen.queryByLabelText('New task title')).toBeNull()

    // A lane: add to it, go to its repo, start a worktree there, fold it away.
    fireEvent.contextMenu(laneHead(/^api/))
    expect(menuItems()).toEqual([
      'New Task in api',
      'Go to api',
      'New Worktree…in api',
      'Collapse Lane',
      'Collapse All Lanes'
    ])
    pick('Collapse Lane')
    expect(laneHead(/^api/).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('group', { name: /^api, / })).toBeNull()
    // Folded, it still says what it holds: one todo, one done.
    expect(laneHead(/^api/).textContent).toBe('api2 tasks1 Todo1 Done')
    fireEvent.contextMenu(laneHead(/^api/))
    pick('Go to api')
    expect(useStore.getState().activeRepoId).toBe('api')
    expect(openModal).toHaveBeenLastCalledWith(null)

    // The board: the header's actions again, wherever the pointer is.
    fireEvent.contextMenu(screen.getByRole('dialog').querySelector('.overflow-auto')!)
    expect(menuItems()).toEqual(['New TaskN', 'Filter Tasks/', 'Archived Tasks', 'Collapse All Lanes'])
    pick('Collapse All Lanes')
    expect(screen.queryAllByRole('group')).toEqual([])
    fireEvent.contextMenu(screen.getByRole('dialog').querySelector('.overflow-auto')!)
    pick('Expand All Lanes')
    expect(screen.getAllByRole('group')).toHaveLength(10)
  })

  it('folds a lane from its head, and files a card dropped on the head without changing its status', () => {
    seed('acme', [task('n', 1, null, { status: 'in_progress' }), task('w', 2, 'web')])
    openBoard()
    fireEvent.click(laneHead(/^web/))
    expect(screen.queryByRole('group', { name: /^web, / })).toBeNull()

    const dataTransfer = { setData: vi.fn(), getData: () => 'n', effectAllowed: '', dropEffect: '' }
    const head = laneHead(/^web/).parentElement!
    fireEvent.dragStart(card('task n'), { dataTransfer })
    fireEvent.dragOver(head, { dataTransfer })
    expect(laneHead(/^web/).textContent).toContain('Move to web')
    fireEvent.drop(head, { dataTransfer })
    expect(updateTask).toHaveBeenLastCalledWith('n', { repoId: 'web' })

    fireEvent.click(laneHead(/^web/))
    expect(cell('web, Todo, 1 tasks')).toBeTruthy()
  })

  it('filters the cards by number, title, tag or description, and Escape clears the filter first', () => {
    seed('acme', [
      task('a', 1, 'api', { tags: ['perf'] }),
      task('n', 2, null, { description: 'Mentions perf in passing' }),
      task('w', 3, 'web')
    ])
    openBoard()
    const filter = screen.getByLabelText('Filter tasks') as HTMLInputElement
    fireEvent.change(filter, { target: { value: 'PERF' } })
    expect(screen.getByText('2 repos · 2 of 3 tasks')).toBeTruthy()
    expect(screen.queryByText('task w')).toBeNull()
    // A lane with nothing left keeps its head and gives up its rows.
    expect(laneHead(/^web/).textContent).toBe('web0 of 1')
    expect(screen.queryByRole('group', { name: /^web, / })).toBeNull()

    fireEvent.change(filter, { target: { value: '#3' } })
    expect(screen.getByText('task w')).toBeTruthy()
    expect(screen.queryByText('task a')).toBeNull()

    fireEvent.change(filter, { target: { value: 'nothing like it' } })
    expect(screen.getByText('No task matches “nothing like it”.')).toBeTruthy()

    fireEvent.keyDown(filter, { key: 'Escape' })
    expect(filter.value).toBe('')
    expect(screen.getByText('task a')).toBeTruthy()
    expect(useStore.getState().modalStack.map((m) => m.type)).toEqual(['board'])
  })

  it('starts a task on N and goes to the filter on /, unless something is being typed', () => {
    seed('acme', [task('a', 1, 'api')])
    openBoard()
    fireEvent.keyDown(document.body, { key: '/' })
    const filter = screen.getByLabelText('Filter tasks')
    expect(document.activeElement).toBe(filter)
    // Typing an n into the filter is typing.
    fireEvent.keyDown(filter, { key: 'n' })
    expect(screen.queryByLabelText('New task title')).toBeNull()

    fireEvent.keyDown(document.body, { key: 'n' })
    // Nowhere was named, so it is a Todo under no repo.
    expect(within(cell(/^Project, no repo, Todo/)).getByLabelText('New task title')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('New task title'), { key: 'Escape' })
    expect(screen.queryByLabelText('New task title')).toBeNull()
    expect(useStore.getState().modalStack.map((m) => m.type)).toEqual(['board'])

    // The header button and a column's plus do the same.
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    expect(within(cell(/^Project, no repo, Todo/)).getByLabelText('New task title')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New task in Review' }))
    expect(within(cell(/^Project, no repo, Review/)).getByLabelText('New task title')).toBeTruthy()
    expect(screen.getAllByLabelText('New task title')).toHaveLength(1)
  })
})

describe('descriptionPreview', () => {
  it('reads the first lines of a description as plain text', () => {
    expect(descriptionPreview('')).toBe('')
    expect(descriptionPreview('\n\n  One line.  \n')).toBe('One line.')
    expect(descriptionPreview('# Goal\n\n- [ ] first `thing`\n2. **second**\n> quoted')).toBe(
      'Goal first thing second quoted'
    )
    // Names keep their underscores and stars inside words are left alone.
    expect(descriptionPreview('rename snake_case_name')).toBe('rename snake_case_name')
    // Only as much as a card can show.
    expect(descriptionPreview(Array(40).fill('a line of description text').join('\n')).length).toBeLessThan(300)
  })
})
