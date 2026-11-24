import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project, Repo, RailFolder, RailItem, Tab, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import Rail from './Rail'
import { endRailDrag } from './folders'

/**
 * Projects in the rail: a group's header (its own session), the home repo's
 * worktrees and the member repos under it, their menus, and the drags that
 * move repos in and out of a project. What each gesture sends main is by id
 * only, as for folders.
 */

let bridge: Record<string, ReturnType<typeof vi.fn>>

const repo = (id: string, projectId: string, repoPath = `C:/Projects/${projectId}/${id}`): Repo => ({
  id,
  name: id,
  repoPath,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId
})
const project = (id: string, name: string, repoIds: string[], homeRepoId: string | null = null): Project => ({
  id,
  name,
  rootPath: `C:/Projects/${id}`,
  homeRepoId,
  managedBlock: true,
  codeWorkspace: false,
  repoIds,
  createdAt: 0
})
const tab = (id: string, worktreeId: string): Tab => ({
  id,
  worktreeId,
  paneId: `pane-${worktreeId}`,
  type: 'terminal',
  status: 'idle',
  position: 0,
  config: {}
})
const wt = (
  id: string,
  projectId: string,
  repoId: string | null,
  kind: Worktree['kind'],
  status: Worktree['status'] = 'idle',
  tabs: Tab[] = []
): Worktree => ({
  id,
  repoId,
  projectId,
  kind,
  name: id,
  path: `C:/${id}`,
  branch: kind === 'folder' ? '' : 'main',
  status,
  taskId: null,
  layout: { type: 'pane', paneId: `pane-${id}` },
  createdAt: 0,
  panes: [{ id: `pane-${id}`, worktreeId: id, activeTabId: tabs[0]?.id ?? null, tabs }]
})

/*
 * acme      home 'home', members api, web; home has a linked worktree 'adr'
 * platform  no home: folder session, members gateway, billing (outside the root)
 * orbital   flat
 * docs      flat
 */
const repos = [
  repo('home', 'acme'),
  repo('api', 'acme'),
  repo('web', 'acme'),
  repo('gateway', 'platform'),
  repo('billing', 'platform', 'D:/work/billing'),
  repo('orbital', 'orbital', 'C:/Projects/orbital'),
  repo('docs', 'docs', 'C:/Projects/docs')
]
const projects = [
  project('acme', 'Acme', ['home', 'api', 'web'], 'home'),
  project('platform', 'Platform', ['gateway', 'billing']),
  project('orbital', 'orbital', ['orbital']),
  project('docs', 'docs', ['docs'])
]

function renderRail(
  opts: {
    worktrees?: Worktree[]
    folders?: RailFolder[]
    rail?: RailItem[]
    projectItems?: Record<string, RailItem[]>
    expanded?: Record<string, boolean>
    active?: string | null
    projects?: Project[]
  } = {}
): void {
  const worktrees = opts.worktrees ?? [
    wt('acme-root', 'acme', 'home', 'root'),
    wt('adr', 'acme', 'home', 'linked'),
    wt('api-root', 'acme', 'api', 'root'),
    wt('web-root', 'acme', 'web', 'root'),
    wt('platform-folder', 'platform', null, 'folder'),
    wt('gateway-root', 'platform', 'gateway', 'root'),
    wt('billing-root', 'platform', 'billing', 'root'),
    wt('orbital-root', 'orbital', 'orbital', 'root'),
    wt('docs-root', 'docs', 'docs', 'root')
  ]
  const active = worktrees.find((w) => w.id === opts.active)
  useStore.setState({
    repos,
    projects: opts.projects ?? projects,
    railFolders: opts.folders ?? [],
    railItems: opts.rail ?? [],
    railProjectItems: opts.projectItems ?? {},
    renamingFolderId: null,
    worktrees,
    tasks: [],
    activeRepoId: active?.repoId ?? null,
    activeProjectId: active?.projectId ?? null,
    activeWorktreeId: active?.id ?? null,
    expanded: opts.expanded ?? {},
    renamingProjectId: null,
    railMessage: ''
  } as unknown as Parameters<typeof useStore.setState>[0])
  render(<Rail />)
}

/** A project's header row (it IS the session): the draggable row in its block. */
const groupHeader = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-project-id="${id}"] > [role="button"]`)!
const groupBlock = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-project-id="${id}"]`)!
const memberRow = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-repo-id="${id}"] > [role="button"]`)!
const flatRow = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-project-id="${id}"] > [role="button"]`)!
const items = (): string[] => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')
const dataTransfer = (): Record<string, unknown> => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' })
const marker = (within: ParentNode = document): Element | null => within.querySelector('.bg-accent')

/** Drop on `el` with the pointer at `clientY` (jsdom boxes are 0×0 at the origin). */
function dropAt(el: Element, clientY: number): void {
  const event = createEvent.drop(el, { dataTransfer: dataTransfer() })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(el, event)
}
const TOP = -1
const LOWER = 1

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
    addRepoToProject: vi.fn(async () => undefined),
    detachRepo: vi.fn(async () => null),
    setProjectHome: vi.fn(async () => undefined),
    setProjectRoot: vi.fn(async () => null),
    setProjectManagedBlock: vi.fn(async () => undefined),
    setProjectCodeWorkspace: vi.fn(async () => undefined),
    renameProject: vi.fn(async () => undefined),
    ungroupProject: vi.fn(async () => undefined),
    removeProject: vi.fn(async () => undefined),
    openProjectPath: vi.fn(async () => undefined),
    openProjectInTerminal: vi.fn(async () => undefined),
    clearWorktreeStatus: vi.fn(async () => undefined),
    placeProject: vi.fn(async () => undefined),
    placeRailFolder: vi.fn(async () => undefined),
    createRailFolder: vi.fn(async () => undefined),
    setRailFolderCollapsed: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
})

afterEach(() => {
  endRailDrag()
  cleanup()
  vi.unstubAllGlobals()
})

describe('project rows', () => {
  it('draws a group as a header with its children, and a one-repo project as a plain row', () => {
    renderRail()
    // Acme: the home is the header, never listed again; members follow its linked worktree.
    expect(within(groupBlock('acme')).getByText('Acme')).toBeTruthy()
    expect(document.querySelector('[data-repo-id="home"]')).toBeNull()
    expect(within(groupBlock('acme')).getByText('adr')).toBeTruthy()
    expect(memberRow('api')).toBeTruthy()
    expect(memberRow('web')).toBeTruthy()
    // Flat rows carry the project id only.
    expect(document.querySelector('[data-repo-id="orbital"]')).toBeNull()
    expect(within(flatRow('orbital')).getByText('main · C:/Projects/orbital')).toBeTruthy()
  })

  it("says what a header is: home or folder session, and how many repos", () => {
    renderRail()
    const acme = groupHeader('acme')
    expect(within(acme).getByText('main · C:/Projects/acme/home')).toBeTruthy()
    expect(within(acme).getByTitle('Home repo: home')).toBeTruthy()
    expect(within(acme).getByTitle('3 repos').textContent).toBe('3')
    expect(within(acme).getByText(/, project, 3 repos, home repo home/)).toBeTruthy()

    const platform = groupHeader('platform')
    expect(within(platform).getByText('C:/Projects/platform')).toBeTruthy()
    expect(within(platform).getByTitle('Folder session. No git here.')).toBeTruthy()
    expect(within(platform).getByText(/, project, 2 repos, folder session/)).toBeTruthy()
    expect(within(platform).getByRole('button', { name: 'Add repo to Platform' })).toBeTruthy()
  })

  it("reads a member's path from the project root, and gives the absolute path outside it", () => {
    renderRail()
    expect(within(memberRow('gateway')).getByText('main · ./gateway')).toBeTruthy()
    expect(within(memberRow('billing')).getByText('main · D:/work/billing')).toBeTruthy()
    expect(memberRow('gateway').getAttribute('title')).toBe('C:/Projects/platform/gateway')
  })

  it('collapses from the chevron only, and while collapsed reports what it hides', () => {
    renderRail({
      expanded: { platform: false },
      worktrees: [
        wt('platform-folder', 'platform', null, 'folder', 'working'),
        wt('gateway-root', 'platform', 'gateway', 'root', 'needs_attention'),
        wt('billing-root', 'platform', 'billing', 'root', 'needs_attention')
      ]
    })
    const header = groupHeader('platform')
    expect(memberRow('gateway')).toBeNull()
    expect(within(header).getByLabelText('2 worktrees need you').textContent).toBe('2')
    const chevron = within(header).getByRole('button', { name: /^Expand project — worktrees needs you/ })
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    expect(chevron.querySelector('svg')?.getAttribute('class')).toContain('animate-pulse')

    fireEvent.click(chevron)
    expect(useStore.getState().expanded.platform).toBe(true)
  })

  it('shows no pill while open: the rows below already say it', () => {
    renderRail({
      worktrees: [
        wt('platform-folder', 'platform', null, 'folder'),
        wt('gateway-root', 'platform', 'gateway', 'root', 'needs_attention')
      ]
    })
    expect(within(groupHeader('platform')).queryByLabelText('1 worktree needs you')).toBeNull()
  })

  it('opens its session from the header, and marks it as the open row', () => {
    renderRail()
    fireEvent.click(groupHeader('platform'))
    const s = useStore.getState()
    expect(s.activeWorktreeId).toBe('platform-folder')
    expect(s.activeProjectId).toBe('platform')
    expect(s.activeRepoId).toBeNull()
    expect(groupHeader('platform').getAttribute('aria-current')).toBe('true')
    expect(groupHeader('platform').className).toContain('bg-panel-2')
  })

  it("washes the header when a home worktree is open, and only names it when a member's is", () => {
    renderRail({ active: 'adr' })
    expect(groupHeader('acme').className).toContain('bg-hover')
    expect(groupHeader('acme').getAttribute('aria-current')).toBeNull()
    cleanup()
    renderRail({ active: 'api-root' })
    expect(groupHeader('acme').className).not.toContain('bg-hover ')
    expect(memberRow('api').className).toContain('bg-panel-2')
    expect(within(groupHeader('acme')).getByText('Acme').className).toContain('text-text')
  })

  it('opens and closes from the keyboard with the arrow keys', () => {
    renderRail()
    fireEvent.keyDown(groupHeader('platform'), { key: 'ArrowLeft' })
    expect(useStore.getState().expanded.platform).toBe(false)
    fireEvent.keyDown(groupHeader('platform'), { key: 'ArrowRight' })
    expect(useStore.getState().expanded.platform).toBe(true)
  })

  it('offers an empty project a way in', () => {
    renderRail({ projects: [...projects, project('fresh', 'Fresh', [])], worktrees: [] })
    expect(within(groupBlock('fresh')).getByText('No repos yet. Drag one here.')).toBeTruthy()
    expect(within(groupBlock('fresh')).getByRole('button', { name: 'Add Repo' })).toBeTruthy()
  })

  it('draws a home-only project as a header with nothing to open', () => {
    renderRail({ projects: [...projects, project('solo', 'Solo', ['docs'], 'docs')].filter((p) => p.id !== 'docs') })
    expect(within(groupHeader('solo')).queryByRole('button', { name: /project/ })).toBeNull()
    expect(within(groupHeader('solo')).getByTitle('1 repo')).toBeTruthy()
  })
})

describe('project header menu', () => {
  it('lists its items, with New Worktree only for a home and the managed block needing one', () => {
    renderRail()
    fireEvent.contextMenu(groupHeader('acme'))
    expect(items()).toEqual([
      'Rename',
      'Add Repo…',
      'New Folderfor its repos',
      'New Worktree',
      'Home Repohome',
      'Change Root Folder…',
      'Repo List in AGENTS.mdon',
      'VS Code Workspace Fileoff · in home',
      'Move to Folder',
      'Clear Status',
      'Open in File Explorer',
      'Open in External Terminal',
      'Ungroup',
      'Remove project'
    ])
    fireEvent.keyDown(window, { key: 'Escape' })

    fireEvent.contextMenu(groupHeader('platform'))
    expect(items()).not.toContain('New Worktree')
    const block = screen.getByText('Repo List in AGENTS.md').closest('button')!
    expect(block.disabled).toBe(true)
    expect(within(block).getByText('needs home repo')).toBeTruthy()
  })

  it('toggles the VS Code workspace file, naming where it goes', () => {
    renderRail()
    fireEvent.contextMenu(groupHeader('platform'))
    const item = screen.getByText('VS Code Workspace File').closest('button')!
    expect(item.disabled).toBe(false)
    expect(within(item).getByText('off · in root folder')).toBeTruthy()
    fireEvent.click(item)
    expect(bridge.setProjectCodeWorkspace).toHaveBeenCalledWith('platform', true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('turns an on workspace file off', () => {
    renderRail({ projects: projects.map((p) => (p.id === 'acme' ? { ...p, codeWorkspace: true } : p)) })
    fireEvent.contextMenu(groupHeader('acme'))
    const item = screen.getByText('VS Code Workspace File').closest('button')!
    expect(within(item).getByText('on · in home')).toBeTruthy()
    fireEvent.click(item)
    expect(bridge.setProjectCodeWorkspace).toHaveBeenCalledWith('acme', false)
  })

  it('renames inline, by project id', () => {
    renderRail()
    fireEvent.contextMenu(groupHeader('acme'))
    fireEvent.click(screen.getByText('Rename'))
    const field = screen.getByLabelText('Project name')
    fireEvent.change(field, { target: { value: ' Acme Corp ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(bridge.renameProject).toHaveBeenCalledWith('acme', 'Acme Corp')
  })

  it('picks a home repo from the Home Repo step, and clears one', () => {
    renderRail()
    fireEvent.contextMenu(groupHeader('platform'))
    fireEvent.click(screen.getByText('Home Repo'))
    expect(screen.getByText('Home repo for Platform')).toBeTruthy()
    expect(screen.getByText(/keeps a repo list in the home repo/)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('menu')).getByText('gateway'))
    expect(bridge.setProjectHome).toHaveBeenCalledWith('platform', 'gateway')

    fireEvent.contextMenu(groupHeader('acme'))
    fireEvent.click(screen.getByText('Home Repo'))
    expect(within(screen.getByRole('menu')).getByText('home').closest('button')?.disabled).toBe(true)
    fireEvent.click(screen.getByText('Clear Home Repo'))
    expect(bridge.setProjectHome).toHaveBeenLastCalledWith('acme', null)
  })

  it('confirms a home that would close a folder session with terminals open', () => {
    renderRail({
      worktrees: [
        wt('platform-folder', 'platform', null, 'folder', 'idle', [tab('t1', 'platform-folder'), tab('t2', 'platform-folder')]),
        wt('gateway-root', 'platform', 'gateway', 'root')
      ]
    })
    fireEvent.contextMenu(groupHeader('platform'))
    fireEvent.click(screen.getByText('Home Repo'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('billing'))
    expect(bridge.setProjectHome).not.toHaveBeenCalled()
    expect(screen.getByText('Make billing the home repo of "Platform"?')).toBeTruthy()
    expect(screen.getByText(/The 2 terminals open in the folder session close\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Make Home' }))
    expect(bridge.setProjectHome).toHaveBeenCalledWith('platform', 'billing')
  })

  it('confirms Ungroup, saying what happens to the session', () => {
    renderRail({
      worktrees: [wt('platform-folder', 'platform', null, 'folder', 'idle', [tab('t1', 'platform-folder')])]
    })
    fireEvent.contextMenu(groupHeader('platform'))
    fireEvent.click(screen.getByText('Ungroup'))
    expect(screen.getByText('Ungroup "Platform"?')).toBeTruthy()
    expect(
      screen.getByText(
        'Its 2 repos become separate rows. The project session closes, along with its 1 open terminal.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }))
    expect(bridge.ungroupProject).toHaveBeenCalledWith('platform')

    fireEvent.contextMenu(groupHeader('acme'))
    fireEvent.click(screen.getByText('Ungroup'))
    expect(screen.getByText('Its 3 repos become separate rows. home keeps its session.')).toBeTruthy()
  })

  it('confirms Remove project, and keeps the OS hand-offs to the project id', () => {
    renderRail()
    fireEvent.contextMenu(groupHeader('acme'))
    fireEvent.click(screen.getByText('Open in External Terminal'))
    expect(bridge.openProjectInTerminal).toHaveBeenCalledWith('acme')

    fireEvent.contextMenu(groupHeader('acme'))
    fireEvent.click(screen.getByText('Remove project'))
    expect(screen.getByText('Remove "Acme" and its 3 repos from Orbital?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(bridge.removeProject).toHaveBeenCalledWith('acme')
  })
})

describe('member and flat repo menus', () => {
  it("gives a member the project items, and Move to Folder among its project's folders", () => {
    renderRail()
    fireEvent.contextMenu(memberRow('api'))
    expect(items()).toEqual([
      'Rename',
      'Move to Folder',
      'New Worktree',
      'Make Home Repo',
      'Move to Project',
      'Remove from Project',
      'Clear Status',
      'Open in File Explorer',
      'Open in External Terminal',
      'Remove repo'
    ])
  })

  it('takes a member out to its own row just below the project', () => {
    renderRail({ rail: [{ kind: 'project', id: 'acme' }, { kind: 'project', id: 'orbital' }] })
    fireEvent.contextMenu(memberRow('web'))
    fireEvent.click(screen.getByText('Remove from Project'))
    expect(bridge.detachRepo).toHaveBeenCalledWith('web', null, 'orbital')
  })

  it('confirms taking a repo out of a two-repo group whose session has terminals', async () => {
    renderRail({
      worktrees: [wt('platform-folder', 'platform', null, 'folder', 'idle', [tab('t1', 'platform-folder')])]
    })
    fireEvent.contextMenu(memberRow('gateway'))
    fireEvent.click(screen.getByText('Remove from Project'))
    expect(bridge.detachRepo).not.toHaveBeenCalled()
    expect(screen.getByText('Take gateway out of "Platform"?')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take Out' }))
    })
    expect(bridge.detachRepo).toHaveBeenCalledWith('gateway', null, 'orbital')
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'gateway removed from Platform. Platform is now a plain repo row.'
    )
  })

  it('moves a repo to another project, or starts a new one with a plain repo row', async () => {
    renderRail()
    fireEvent.contextMenu(memberRow('api'))
    fireEvent.click(screen.getByText('Move to Project'))
    expect(screen.getByText('Move api to')).toBeTruthy()
    expect(within(screen.getByRole('menu')).getByText('Acme').closest('button')?.disabled).toBe(true)
    expect(screen.getByText('New project with')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('menu')).getByText('Platform'))
    expect(bridge.addRepoToProject).toHaveBeenCalledWith('platform', 'api', null, null)

    fireEvent.contextMenu(flatRow('orbital'))
    fireEvent.click(screen.getByText('Move to Project'))
    // A flat row lists no "current": it is in no group.
    expect(screen.queryByText('current')).toBeNull()
    await act(async () => {
      fireEvent.click(within(screen.getByRole('menu')).getByText('docs'))
    })
    expect(bridge.addRepoToProject).toHaveBeenLastCalledWith('docs', 'orbital', null, null)
    expect(useStore.getState().renamingProjectId).toBe('docs')
  })

  it('says so when there is nowhere to move to', () => {
    renderRail({ projects: [project('orbital', 'orbital', ['orbital'])], worktrees: [] })
    fireEvent.contextMenu(flatRow('orbital'))
    fireEvent.click(screen.getByText('Move to Project'))
    expect(screen.getByText('No other repos yet.')).toBeTruthy()
  })

  it('gives a flat row Move to Project and Make Home Repo beside its old items', () => {
    renderRail()
    fireEvent.contextMenu(flatRow('orbital'))
    expect(items()).toEqual([
      'Rename',
      'Move to Folder',
      'Move to Project',
      'Make Home Repo',
      'New Worktree',
      'Clear Status',
      'Open in File Explorer',
      'Open in External Terminal',
      'Remove repo'
    ])
    fireEvent.click(screen.getByText('Make Home Repo'))
    expect(bridge.setProjectHome).toHaveBeenCalledWith('orbital', 'orbital')
  })
})

describe('dragging repos in and out of projects', () => {
  it('rings the whole project while a repo would join it', () => {
    renderRail()
    fireEvent.dragStart(flatRow('orbital'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(groupHeader('platform'), { dataTransfer: dataTransfer() })
    expect(groupBlock('platform').className).toContain('ring-accent/50')
    fireEvent.drop(groupHeader('platform'), { dataTransfer: dataTransfer() })
    expect(bridge.addRepoToProject).toHaveBeenCalledWith('platform', 'orbital', null, null)
  })

  it('shows a slot among the members and inserts there', () => {
    renderRail()
    fireEvent.dragStart(flatRow('orbital'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(memberRow('web'), { dataTransfer: dataTransfer() })
    expect(marker(groupBlock('acme'))).toBeTruthy()
    fireEvent.drop(memberRow('web'), { dataTransfer: dataTransfer() })
    expect(bridge.addRepoToProject).toHaveBeenCalledWith('acme', 'orbital', 'web', null)
  })

  it('reorders a member inside its project', () => {
    renderRail()
    fireEvent.dragStart(memberRow('web'), { dataTransfer: dataTransfer() })
    fireEvent.drop(memberRow('api'), { dataTransfer: dataTransfer() })
    expect(bridge.addRepoToProject).toHaveBeenCalledWith('acme', 'web', 'api', null)
    expect(document.querySelector('[aria-live="polite"]')).toBeTruthy()
  })

  it('detaches a member dropped among the top-level rows', () => {
    renderRail({ rail: [{ kind: 'project', id: 'acme' }, { kind: 'project', id: 'orbital' }] })
    fireEvent.dragStart(memberRow('api'), { dataTransfer: dataTransfer() })
    dropAt(flatRow('orbital'), LOWER)
    expect(bridge.detachRepo).toHaveBeenCalledWith('api', null, 'platform')
  })

  it('detaches a member dragged up onto its own header, to just above the project', () => {
    renderRail({ rail: [{ kind: 'project', id: 'orbital' }, { kind: 'project', id: 'acme' }] })
    fireEvent.dragStart(memberRow('api'), { dataTransfer: dataTransfer() })
    dropAt(groupHeader('acme'), TOP)
    expect(bridge.detachRepo).toHaveBeenCalledWith('api', null, 'acme')
  })

  it('asks first when the move would close a folder session with terminals, at the drop point', () => {
    renderRail({
      worktrees: [wt('platform-folder', 'platform', null, 'folder', 'idle', [tab('t1', 'platform-folder')])]
    })
    fireEvent.dragStart(memberRow('billing'), { dataTransfer: dataTransfer() })
    fireEvent.drop(flatRow('orbital'), { dataTransfer: dataTransfer() })
    expect(bridge.addRepoToProject).not.toHaveBeenCalled()
    expect(screen.getByText('Take billing out of "Platform"?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(bridge.addRepoToProject).not.toHaveBeenCalled()

    fireEvent.dragStart(memberRow('billing'), { dataTransfer: dataTransfer() })
    fireEvent.drop(flatRow('orbital'), { dataTransfer: dataTransfer() })
    fireEvent.click(screen.getByRole('button', { name: 'Take Out' }))
    expect(bridge.addRepoToProject).toHaveBeenCalledWith('orbital', 'billing', null, null)
  })

  it('moves a whole project by its header, and never merges it into another', () => {
    renderRail({ rail: [{ kind: 'project', id: 'acme' }, { kind: 'project', id: 'platform' }] })
    fireEvent.dragStart(groupHeader('platform'), { dataTransfer: dataTransfer() })
    fireEvent.drop(groupHeader('acme'), { dataTransfer: dataTransfer() })
    expect(bridge.placeProject).toHaveBeenCalledWith('platform', null, 'acme')
    expect(bridge.addRepoToProject).not.toHaveBeenCalled()
  })
})

describe("folders among a project's repos", () => {
  /*
   * acme   home 'home' (worktree adr)
   *   api
   *   Apps [ web, Old [ ] ]
   */
  const apps: RailFolder = {
    id: 'f-apps',
    name: 'Apps',
    collapsed: false,
    projectId: 'acme',
    parentId: null,
    items: [
      { kind: 'repo', id: 'web' },
      { kind: 'folder', id: 'f-old' }
    ]
  }
  const old: RailFolder = { id: 'f-old', name: 'Old', collapsed: false, projectId: 'acme', parentId: 'f-apps', items: [] }
  /** A folder of projects, which has nothing to do with acme's repos. */
  const work: RailFolder = { id: 'f-work', name: 'Work', collapsed: false, projectId: null, parentId: null, items: [] }
  const filed = {
    folders: [apps, old, work],
    // The home is listed like any repo; the rail draws it as the header.
    projectItems: {
      acme: [
        { kind: 'repo', id: 'home' },
        { kind: 'repo', id: 'api' },
        { kind: 'folder', id: 'f-apps' }
      ] as RailItem[]
    }
  }
  const folderBox = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-folder-id="${id}"]`)!
  const folderHeader = (id: string): HTMLElement => folderBox(id).querySelector<HTMLElement>('[data-folder-header]')!

  it('draws them under the project header, nested, each with the repos filed in it', () => {
    renderRail(filed)
    expect(folderBox('f-apps').closest('[data-project-id]')).toBe(groupBlock('acme'))
    expect(folderBox('f-old').parentElement?.closest('[data-folder-id]')).toBe(folderBox('f-apps'))
    expect(memberRow('web').closest('[data-folder-id]')).toBe(folderBox('f-apps'))
    expect(memberRow('api').closest('[data-folder-id]')).toBeNull()
    expect(within(folderHeader('f-apps')).getByTitle('1 repo')).toBeTruthy()
    expect(within(folderBox('f-old')).getByText('Empty. Drag a repo here.')).toBeTruthy()
    // Filing changes nothing about the project: it still has its three repos, and the home is still the header.
    expect(within(groupHeader('acme')).getByTitle('3 repos')).toBeTruthy()
    expect(document.querySelector('[data-repo-id="home"]')).toBeNull()
  })

  it('reports what a collapsed folder of repos hides, by repo', () => {
    renderRail({
      ...filed,
      folders: [{ ...apps, collapsed: true }, old, work],
      worktrees: [
        wt('acme-root', 'acme', 'home', 'root'),
        wt('api-root', 'acme', 'api', 'root', 'needs_attention'),
        wt('web-root', 'acme', 'web', 'root', 'needs_attention')
      ]
    })
    expect(document.querySelector('[data-repo-id="web"]')).toBeNull()
    // web is in the folder; api needs you too, but it is not this folder's news.
    expect(within(folderHeader('f-apps')).getByLabelText('1 worktree needs you')).toBeTruthy()
    expect(within(folderHeader('f-apps')).getByTitle('Worktrees needs you')).toBeTruthy()
  })

  it("keeps the home repo's worktrees and the project's repos in separate lists, told apart by their lines", () => {
    renderRail(filed)
    const acme = groupBlock('acme')
    const worktrees = within(acme).getByRole('group', { name: 'Worktrees of home' })
    const repos = within(acme).getByRole('group', { name: 'Repos in Acme' })
    expect(within(worktrees).getByText('adr')).toBeTruthy()
    // No repo of the project is in the worktree list, and no worktree among the repos.
    expect(worktrees.querySelector('[data-repo-id]')).toBeNull()
    expect(repos.contains(memberRow('api'))).toBe(true)
    expect(repos.contains(worktrees)).toBe(false)
    // The lines do the telling, so neither list is captioned.
    expect(within(acme).queryByText('Worktrees')).toBeNull()
    expect(within(acme).queryByText('Repos')).toBeNull()
    // Each worktree is joined to the header's dot: a stub in the header, a trunk and a curve beside the row.
    expect(groupHeader('acme').querySelectorAll('[aria-hidden].bg-line-strong')).toHaveLength(1)
    expect(worktrees.querySelectorAll('span[aria-hidden].border-line-strong')).toHaveLength(2)
    // Collapsed, there is no branch for the stub to start.
    act(() => useStore.getState().setExpanded('acme', false))
    expect(groupHeader('acme').querySelector('[aria-hidden].bg-line-strong')).toBeNull()
  })

  it('makes a folder for the project from its header menu, and opens it into its name', async () => {
    bridge.createRailFolder.mockResolvedValue(old)
    renderRail({ ...filed, expanded: { acme: false } })
    fireEvent.contextMenu(groupHeader('acme'))
    await act(async () => {
      fireEvent.click(screen.getByText('New Folder'))
    })
    expect(bridge.createRailFolder).toHaveBeenCalledWith('New Folder', { projectId: 'acme' })
    // The project is opened so the folder is on screen, in rename.
    expect(useStore.getState().expanded.acme).toBe(true)
    expect(within(folderBox('f-old')).getByLabelText('Folder name')).toBeTruthy()
  })

  it("files a member through Move to Folder, among its own project's folders only", () => {
    renderRail(filed)
    fireEvent.contextMenu(memberRow('api'))
    fireEvent.click(screen.getByText('Move to Folder'))
    // Work holds projects, so it is not offered to a repo of acme.
    expect(items()).toEqual(['Apps', 'Old', 'New Folder…'])
    fireEvent.click(within(screen.getByRole('menu')).getByText('Old'))
    expect(bridge.addRepoToProject).toHaveBeenLastCalledWith('acme', 'api', null, 'f-old')

    fireEvent.contextMenu(memberRow('web'))
    fireEvent.click(screen.getByText('Move to Folder'))
    expect(items()).toEqual(['Appscurrent', 'Old', 'New Folder…', 'Remove from Folder'])
    fireEvent.click(screen.getByText('Remove from Folder'))
    // Out of Apps to the top of acme's list, just below Apps (which is last there).
    expect(bridge.addRepoToProject).toHaveBeenLastCalledWith('acme', 'web', null, null)

    fireEvent.contextMenu(memberRow('api'))
    fireEvent.click(screen.getByText('Move to Folder'))
    fireEvent.click(screen.getByText('New Folder…'))
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'Services' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(bridge.createRailFolder).toHaveBeenCalledWith('Services', { holding: { kind: 'repo', id: 'api' } })
    expect(bridge.placeProject).not.toHaveBeenCalled()
  })

  it('files a dragged repo in a folder, lighting the folder up, or at a place among its rows', () => {
    renderRail(filed)
    fireEvent.dragStart(memberRow('api'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(folderHeader('f-apps'), { dataTransfer: dataTransfer() })
    expect(folderBox('f-apps').firstElementChild?.className).toContain('ring-accent/50')
    // Into a folder is not joining the project, so the project itself is not ringed.
    expect(groupBlock('acme').className).not.toContain('ring-accent/50')
    fireEvent.drop(folderHeader('f-apps'), { dataTransfer: dataTransfer() })
    expect(bridge.addRepoToProject).toHaveBeenLastCalledWith('acme', 'api', null, 'f-apps')

    // A repo from outside the project, dropped beside a filed repo: it joins the project there.
    fireEvent.dragStart(flatRow('orbital'), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(memberRow('web'), { dataTransfer: dataTransfer() })
    expect(marker(folderBox('f-apps'))).toBeTruthy()
    fireEvent.drop(memberRow('web'), { dataTransfer: dataTransfer() })
    expect(bridge.addRepoToProject).toHaveBeenLastCalledWith('acme', 'orbital', 'web', 'f-apps')
  })

  it("moves a folder of repos within its project, and nowhere else", () => {
    renderRail(filed)
    fireEvent.dragStart(folderHeader('f-old'), { dataTransfer: dataTransfer() })
    fireEvent.drop(memberRow('api'), { dataTransfer: dataTransfer() })
    // Out of Apps to the top of acme's list, before api.
    expect(bridge.placeRailFolder).toHaveBeenLastCalledWith('f-old', null, 'api')

    bridge.placeRailFolder.mockClear()
    for (const target of [groupHeader('platform'), memberRow('gateway'), flatRow('orbital'), folderHeader('f-work')]) {
      fireEvent.dragStart(folderHeader('f-apps'), { dataTransfer: dataTransfer() })
      fireEvent.drop(target, { dataTransfer: dataTransfer() })
    }
    // Nor into itself.
    fireEvent.dragStart(folderHeader('f-apps'), { dataTransfer: dataTransfer() })
    fireEvent.drop(folderHeader('f-old'), { dataTransfer: dataTransfer() })
    expect(bridge.placeRailFolder).not.toHaveBeenCalled()
    expect(bridge.placeProject).not.toHaveBeenCalled()
    expect(bridge.addRepoToProject).not.toHaveBeenCalled()
  })
})
