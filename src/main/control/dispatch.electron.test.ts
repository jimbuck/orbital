import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlRequest } from '@shared/types'
import { closeDb, initDb } from '../db/database'
import * as tables from '../db/repositories'

/**
 * The `task` CLI commands' dispatch against a real SQLite store (hence
 * `*.electron.test.ts`, run by `npm run test:db`). Everything else the
 * dispatcher reaches for (the runtime's broadcast, worktree and tab services)
 * is stubbed; the task handlers only need the repositories.
 */
vi.mock('../runtime', async () => ({
  tables: await import('../db/repositories'),
  runtime: { broadcastState: vi.fn(), devServersFor: () => [] }
}))
vi.mock('../services/worktree', () => ({}))
vi.mock('../services/settings', () => ({
  getSettings: () => ({
    agents: [
      { id: 'claude', name: 'Claude', provider: 'claude' },
      { id: 'cursor', name: 'Cursor', provider: 'cursor' }
    ]
  })
}))
vi.mock('../services/logger', () => ({ logger: { cli: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))
const scheduleProjectPointers = vi.fn()
vi.mock('../services/project-pointers', () => ({ scheduleProjectPointers }))
vi.mock('../services/agents/launch', () => ({}))
const createTabInWorktree = vi.fn((worktreeId: string, _pane: string | null, type: string, config: unknown) => ({
  id: 'tab-new',
  worktreeId,
  type,
  config
}))
vi.mock('../tabs', () => ({ createTabInWorktree }))
vi.mock('../worktree-lifecycle', () => ({}))
vi.mock('../status', () => ({}))

const { handleControl } = await import('./dispatch')

let dir: string
let repoId: string
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbital-dispatch-test-'))
  initDb(dir)
  tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
  const repo = tables.repos.create({ name: 'p', repoPath: 'C:/p' })
  repoId = repo.id
  projectId = repo.projectId
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const run = (cmd: ControlRequest['cmd'], args: Record<string, unknown> = {}) =>
  handleControl({ cmd, repoId, args })

const listed = async (args: Record<string, unknown> = {}): Promise<number[]> => {
  const res = await run('task-list', args)
  expect(res.ok).toBe(true)
  return (res.data as { seq: number }[]).map((t) => t.seq).sort((a, b) => a - b)
}

describe('task archive', () => {
  it('archives by number, hides the task from the default list, and unarchives it again', async () => {
    tables.tasks.create({ projectId, repoId, title: 'keep', createdBy: 'agent' })
    tables.tasks.create({ projectId, repoId, title: 'shelve', createdBy: 'agent' })

    const res = await run('task-archive', { id: '#2' })
    expect(res).toMatchObject({ ok: true, data: { seq: 2, title: 'shelve' } })
    expect(await listed()).toEqual([1])
    expect(await listed({ archived: true })).toEqual([2])

    expect((await run('task-unarchive', { id: '2' })).ok).toBe(true)
    expect(await listed()).toEqual([1, 2])
    expect(await listed({ archived: true })).toEqual([])
  })

  it('treats the legacy task-delete as archive: the row survives', async () => {
    const t = tables.tasks.create({ projectId, repoId, title: 'old script', createdBy: 'agent' })
    expect((await run('task-delete', { id: String(t.seq) })).ok).toBe(true)
    expect(tables.tasks.get(t.id)?.archivedAt).toEqual(expect.any(Number))
  })

  it('--all includes done and archived tasks; --status still filters', async () => {
    tables.tasks.create({ projectId, repoId, title: 'open', createdBy: 'agent' })
    const done = tables.tasks.create({ projectId, repoId, title: 'done', createdBy: 'agent' })
    tables.tasks.update(done.id, { status: 'done' })
    const gone = tables.tasks.create({ projectId, repoId, title: 'gone', createdBy: 'agent' })
    tables.tasks.archive(gone.id)

    expect(await listed()).toEqual([1])
    expect(await listed({ all: true })).toEqual([1, 2, 3])
    expect(await listed({ status: 'done' })).toEqual([2])
    expect(await listed({ archived: true, status: 'todo' })).toEqual([3])
  })

  it('still resolves an archived task for show and update, and show carries archivedAt', async () => {
    const t = tables.tasks.create({ projectId, repoId, title: 'a', createdBy: 'agent' })
    tables.tasks.archive(t.id)

    const shown = await run('task-show', { id: '1' })
    expect(shown.ok).toBe(true)
    expect((shown.data as { archivedAt: number | null }).archivedAt).toEqual(expect.any(Number))

    const updated = await run('task-update', { id: t.id.slice(0, 8), title: 'renamed' })
    expect(updated).toMatchObject({ ok: true, data: { title: 'renamed' } })
    // An edit does not unarchive.
    expect(tables.tasks.get(t.id)?.archivedAt).toEqual(expect.any(Number))
  })

  it('reports an unknown number', async () => {
    expect(await run('task-archive', { id: '99' })).toEqual({ ok: false, error: "no task matches number '99'" })
  })
})

describe('cross-repo writes', () => {
  it('returns the target repo name so the CLI can confirm where the write landed', async () => {
    const other = tables.repos.create({ name: 'sibling', repoPath: 'C:/sibling' })
    const added = await handleControl({ cmd: 'task-add', repoId, args: { title: 'x', repo: 'sibling' } })
    expect(added).toMatchObject({ ok: true, data: { repo: 'sibling' } })
    expect(tables.tasks.list('all').some((t) => t.repoId === other.id && t.title === 'x')).toBe(true)
  })

  it("leaves an unknown worktree id to the handler's not-found", async () => {
    const res = await handleControl({ cmd: 'whoami', worktreeId: 'nope-not-real', args: {} })
    // Unknown ids fall through to the handler's own not-found.
    expect(res).toEqual({ ok: false, error: 'worktree not found' })
  })
})

describe('projects', () => {
  /** A no-home project of two repos with root checkouts, plus its folder session. */
  function platform() {
    const api = tables.repos.create({ name: 'api', repoPath: join(dir, 'api') })
    const web = tables.repos.create({ name: 'web', repoPath: join(dir, 'web') })
    const project = tables.projects.create({ name: 'Platform', rootPath: dir, repoIds: [api.id, web.id] })
    const apiRoot = tables.worktrees.create({ repoId: api.id, kind: 'root', name: 'main', path: api.repoPath, branch: 'main' })
    const apiLinked = tables.worktrees.create({
      repoId: api.id,
      kind: 'linked',
      name: 'health',
      path: join(dir, 'wt-health'),
      branch: 'feat/health'
    })
    const folder = tables.worktrees.create({
      repoId: null,
      projectId: project.id,
      kind: 'folder',
      name: 'Platform',
      path: dir,
      branch: ''
    })
    return { api, web, project, apiRoot, apiLinked, folder }
  }

  beforeEach(() => createTabInWorktree.mockClear())

  it('whoami answers from a folder session with its project and no repo', async () => {
    const { folder, project } = platform()
    const res = await handleControl({ cmd: 'whoami', worktreeId: folder.id, projectId: project.id, args: {} })
    expect(res).toMatchObject({ ok: true, data: { project: 'Platform', projectId: project.id, repo: '', kind: 'folder' } })
  })

  it('project lists the members with their worktrees, marking the caller', async () => {
    const { api, apiRoot, project } = platform()
    const res = await handleControl({ cmd: 'project', worktreeId: apiRoot.id, repoId: api.id, args: {} })
    expect(res.ok).toBe(true)
    const data = res.data as { name: string; projectSession: boolean; repos: { name: string; current: boolean; worktrees: unknown[] }[] }
    expect(data.name).toBe(project.name)
    expect(data.projectSession).toBe(false)
    expect(data.repos.map((r) => [r.name, r.current, r.worktrees.length])).toEqual([
      ['api', true, 1],
      ['web', false, 0]
    ])
  })

  it('project knows it is the project session in the folder session', async () => {
    const { folder } = platform()
    const res = await handleControl({ cmd: 'project', worktreeId: folder.id, args: {} })
    expect((res.data as { projectSession: boolean }).projectSession).toBe(true)
  })

  it("tab new --repo opens in that repo's root checkout, --worktree in one of its worktrees", async () => {
    const { folder, apiRoot, apiLinked } = platform()
    const atRoot = await handleControl({ cmd: 'tab-new', worktreeId: folder.id, args: { type: 'terminal', repo: 'api' } })
    expect(atRoot).toMatchObject({ ok: true, data: { repo: 'api', worktree: 'main' } })
    expect(createTabInWorktree).toHaveBeenLastCalledWith(apiRoot.id, null, 'terminal', {})

    const inLinked = await handleControl({
      cmd: 'tab-new',
      worktreeId: folder.id,
      args: { type: 'agent', repo: 'api', worktree: 'feat/health', prompt: 'Add /health' }
    })
    expect(inLinked).toMatchObject({ ok: true, data: { worktree: 'health' } })
    expect(createTabInWorktree).toHaveBeenLastCalledWith(apiLinked.id, null, 'agent', { agentPrompt: 'Add /health' })
  })

  it('tab new explains what is wrong with a bad target or prompt', async () => {
    const { folder } = platform()
    expect(await handleControl({ cmd: 'tab-new', worktreeId: folder.id, args: { type: 'terminal', worktree: 'x' } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/folder session .*orbital project/)
    })
    expect(
      await handleControl({ cmd: 'tab-new', worktreeId: folder.id, args: { type: 'terminal', repo: 'api', worktree: 'nope' } })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/no worktree 'nope' in repo 'api'/) })
    expect(
      await handleControl({ cmd: 'tab-new', worktreeId: folder.id, args: { type: 'browser', repo: 'api', prompt: 'x' } })
    ).toEqual({ ok: false, error: '--prompt only applies to agent tabs' })
    expect(
      await handleControl({ cmd: 'tab-new', worktreeId: folder.id, args: { type: 'agent', arg: 'Cursor', repo: 'api', prompt: 'x' } })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Cursor cannot be started with a prompt/) })
    expect(createTabInWorktree).not.toHaveBeenCalled()
  })

  describe('tasks at project scope', () => {
    const add = async (worktreeId: string, args: Record<string, unknown>) => {
      const res = await handleControl({ cmd: 'task-add', worktreeId, args: { title: 't', ...args } })
      expect(res.ok).toBe(true)
      return tables.tasks.get((res.data as { id: string }).id)!
    }
    const list = async (worktreeId: string, args: Record<string, unknown> = {}) => {
      const res = await handleControl({ cmd: 'task-list', worktreeId, args })
      expect(res.ok).toBe(true)
      return (res.data as { title: string; repo: string | null }[]).map((t) => `${t.title}@${t.repo ?? '-'}`)
    }

    it('task add files where quick capture would: none from the project session, this repo from a repo session', async () => {
      const { api, web, project, folder, apiLinked } = platform()
      expect(await add(folder.id, {})).toMatchObject({ projectId: project.id, repoId: null })
      expect(await add(apiLinked.id, {})).toMatchObject({ projectId: project.id, repoId: api.id })
      expect(await add(apiLinked.id, { noRepo: true })).toMatchObject({ repoId: null })
      expect(await add(folder.id, { repo: 'web' })).toMatchObject({ projectId: project.id, repoId: web.id })
      const both = await handleControl({ cmd: 'task-add', worktreeId: folder.id, args: { title: 'x', repo: 'web', noRepo: true } })
      expect(both).toEqual({ ok: false, error: 'pass --repo or --no-repo, not both' })
    })

    it("the home repo's root is the project session; its linked worktree is the home repo's", async () => {
      const { api, project } = platform()
      tables.projects.setHome(project.id, api.id)
      const homeRoot = tables.worktrees.list().find((w) => w.repoId === api.id && w.kind === 'root')!
      const homeLinked = tables.worktrees.list().find((w) => w.repoId === api.id && w.kind === 'linked')!
      expect((await add(homeRoot.id, {})).repoId).toBeNull()
      expect((await add(homeLinked.id, {})).repoId).toBe(api.id)
    })

    it('a one-repo project files under its repo from anywhere in it', async () => {
      const solo = tables.repos.create({ name: 'solo', repoPath: join(dir, 'solo') })
      const wt = tables.worktrees.create({ repoId: solo.id, kind: 'root', name: 'main', path: solo.repoPath, branch: 'main' })
      expect((await add(wt.id, {})).repoId).toBe(solo.id)
    })

    it("task list defaults to the terminal's scope and widens with --all-repos", async () => {
      const { folder, apiLinked } = platform()
      await add(folder.id, { title: 'span' })
      await add(apiLinked.id, { title: 'a1' })
      await add(folder.id, { title: 'w1', repo: 'web' })
      expect(await list(apiLinked.id)).toEqual(['a1@api'])
      expect(await list(folder.id)).toEqual(['span@-', 'a1@api', 'w1@web'])
      expect(await list(apiLinked.id, { allRepos: true })).toEqual(['span@-', 'a1@api', 'w1@web'])
      expect(await list(apiLinked.id, { noRepo: true })).toEqual(['span@-'])
      expect(await list(folder.id, { repo: 'web' })).toEqual(['w1@web'])
    })

    it('show, update and archive find any task of the project, from the folder session too', async () => {
      const { folder, apiLinked, web } = platform()
      const t = await add(apiLinked.id, { title: 'mine' })
      const shown = await handleControl({ cmd: 'task-show', worktreeId: folder.id, args: { id: String(t.seq) } })
      expect(shown).toMatchObject({ ok: true, data: { seq: t.seq, repo: 'api', project: 'Platform' } })

      const moved = await handleControl({ cmd: 'task-update', worktreeId: folder.id, args: { id: String(t.seq), repo: 'web', retag: true } })
      expect(moved).toMatchObject({ ok: true, data: { repo: 'web', retagged: true } })
      expect(tables.tasks.get(t.id)!.repoId).toBe(web.id)
      // `task done --repo web` finds the task through --repo but never moves it.
      await handleControl({ cmd: 'task-update', worktreeId: folder.id, args: { id: String(t.seq), noRepo: true } })
      expect(tables.tasks.get(t.id)!.repoId).toBeNull()
      const done = await handleControl({ cmd: 'task-update', worktreeId: apiLinked.id, args: { id: String(t.seq), status: 'done', repo: 'web' } })
      expect(done.ok).toBe(true)
      expect(tables.tasks.get(t.id)).toMatchObject({ repoId: null, status: 'done' })

      expect((await handleControl({ cmd: 'task-archive', worktreeId: folder.id, args: { id: String(t.seq) } })).ok).toBe(true)
    })

    it('a task with a live worktree keeps its repo', async () => {
      const { folder, apiLinked } = platform()
      const t = await add(apiLinked.id, { title: 'busy' })
      tables.worktrees.linkTask(apiLinked.id, t.id)
      const res = await handleControl({ cmd: 'task-update', worktreeId: folder.id, args: { id: String(t.seq), repo: 'web', retag: true } })
      expect(res).toEqual({ ok: false, error: `task #${t.seq} has a worktree in api; its repo follows that worktree` })
    })

    it('starting an untagged task in a project of several repos asks for --repo', async () => {
      const { folder } = platform()
      const t = await add(folder.id, { title: 'span' })
      const res = await handleControl({ cmd: 'worktree-new', worktreeId: folder.id, args: { task: String(t.seq) } })
      expect(res.ok).toBe(false)
      expect(res.error).toContain(`task #${t.seq} has no repo, so say where to start it: pass --repo <name|id>`)
    })

    it('worktree new without a task still needs a repo in the folder session', async () => {
      const { folder, project } = platform()
      const res = await handleControl({ cmd: 'worktree-new', worktreeId: folder.id, projectId: project.id, args: {} })
      expect(res.error).toMatch(/pass --repo <name\|id> \(`orbital project` lists its repos\)/)
    })
  })
})

describe('orbital folder', () => {
  type Row = { kind: string; name: string; path?: string; items?: Row[] }
  /** A group "src" of a (the home), b, c and d; `a.id` stands in for the calling terminal's repo. */
  const group = (): { pid: string; ids: Record<string, string> } => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => tables.repos.create({ name, repoPath: `C:/src/${name}` }))
    for (const r of [b, c, d]) tables.projects.addRepo(a.projectId, r.id, null)
    tables.projects.setHome(a.projectId, a.id)
    return { pid: a.projectId, ids: { a: a.id, b: b.id, c: c.id, d: d.id } }
  }
  const view = (rows: Row[]): string[] =>
    rows.map((row) => (row.kind === 'folder' ? `${row.name}[${view(row.items ?? []).join(' ')}]` : row.name))

  it("arranges the calling project's repos: add, nest, move, rename, remove", async () => {
    const { pid, ids } = group()
    const at = (cmd: ControlRequest['cmd'], args: Record<string, unknown> = {}) =>
      handleControl({ cmd, repoId: ids.b, args })
    const tree = async (): Promise<string[]> => view(((await at('folder-list')).data as { items: Row[] }).items)

    // The home is the project's header, so it is not a row; no folders yet.
    expect(await at('folder-list')).toMatchObject({ ok: true, data: { scope: 'project', project: 'src' } })
    expect(await tree()).toEqual(['b', 'c', 'd'])

    // New folders go last, in the order they are made, so a script's folders read as written.
    expect(await at('folder-add', { name: 'Games' })).toMatchObject({ ok: true, data: { name: 'Games', path: 'Games' } })
    expect(await at('folder-add', { name: 'Engines', in: 'games' })).toMatchObject({
      ok: true,
      data: { path: 'Games/Engines' }
    })
    await at('folder-add', { name: 'Sites' })
    expect(await tree()).toEqual(['b', 'c', 'd', 'Games[Engines[]]', 'Sites[]'])

    // By name, by path, case aside; --before places it among the rows already there.
    expect(await at('folder-move', { row: 'c', to: 'Games/Engines' })).toMatchObject({
      ok: true,
      data: { kind: 'repo', name: 'c', folder: 'Games/Engines' }
    })
    await at('folder-move', { row: 'D', to: 'games', before: 'Engines' })
    expect(await tree()).toEqual(['b', 'Games[d Engines[c]]', 'Sites[]'])
    await at('folder-move', { row: 'Sites', top: true, before: 'b' })
    await at('folder-move', { row: 'c', top: true })
    expect(await tree()).toEqual(['Sites[]', 'b', 'Games[d Engines[]]', 'c'])
    // The flat order of the project follows, and its managed repo list is refreshed for it.
    expect(tables.projects.get(pid)!.repoIds.map((rid) => tables.repos.get(rid)!.name)).toEqual(['a', 'b', 'd', 'c'])
    expect(scheduleProjectPointers).toHaveBeenCalled()

    expect(await at('folder-rename', { folder: 'Games', name: 'Game dev' })).toMatchObject({
      ok: true,
      data: { name: 'Game dev', was: 'Games' }
    })
    // Removing a folder leaves what was in it where the folder was.
    expect(await at('folder-remove', { folder: 'Game dev' })).toMatchObject({ ok: true, data: { released: 2 } })
    expect(await tree()).toEqual(['Sites[]', 'b', 'd', 'Engines[]', 'c'])
    // Nothing about a repo itself moved.
    expect(tables.repos.get(ids.c)).toMatchObject({ repoPath: 'C:/src/c', projectId: pid })
  })

  it('refuses what the rail refuses, and says why', async () => {
    const { ids } = group()
    const at = (cmd: ControlRequest['cmd'], args: Record<string, unknown> = {}) =>
      handleControl({ cmd, repoId: ids.b, args })
    await at('folder-add', { name: 'Games' })
    await at('folder-add', { name: 'Engines', in: 'Games' })
    await at('folder-add', { name: 'Tools' })
    await at('folder-add', { name: 'Engines', in: 'Tools' })

    expect(await at('folder-move', { row: 'Games', to: 'Games/Engines' })).toEqual({
      ok: false,
      error: "folder 'Games' cannot go inside itself"
    })
    expect((await at('folder-move', { row: 'c' })).error).toBe('say where it goes: --to <folder>, or --top')
    // Two folders share the name, neither at the top: the path says which.
    expect((await at('folder-move', { row: 'c', to: 'Engines' })).error).toMatch(
      /folder 'Engines' is ambiguous: Games\/Engines \(.*\), Tools\/Engines/
    )
    expect((await at('folder-move', { row: 'c', to: 'tools/engines' })).ok).toBe(true)
    expect((await at('folder-move', { row: 'a', to: 'Games' })).error).toMatch(/'a' is the home repo of 'src'/)
    expect((await at('folder-move', { row: 'nope', to: 'Games' })).error).toMatch(/no repo or folder 'nope' in project 'src'/)
    expect((await at('folder-remove', { folder: 'nope' })).error).toMatch(/no folder 'nope' among the repos of project 'src'/)
    expect((await at('folder-add', { name: '  ' })).error).toBe('folder name required')
  })

  it('needs --rail in a project that is a single repo, and then arranges projects', async () => {
    expect((await run('folder-list')).error).toMatch(/project 'p' is a single repo.*pass --rail/)
    const other = tables.repos.create({ name: 'q', repoPath: 'C:/q' })

    expect(await run('folder-add', { name: 'Work', rail: true })).toMatchObject({ ok: true, data: { scope: 'rail' } })
    await run('folder-add', { name: 'Clients', in: 'Work', rail: true })
    expect(await run('folder-move', { row: 'q', to: 'Work/Clients', rail: true })).toMatchObject({
      ok: true,
      data: { kind: 'project', name: 'q', folder: 'Work/Clients' }
    })
    const listed = (await run('folder-list', { rail: true })).data as { scope: string; items: Row[] }
    expect(listed.scope).toBe('rail')
    expect(view(listed.items)).toEqual(['p', 'Work[Clients[q]]'])
    expect(tables.repos.get(other.id)).toMatchObject({ repoPath: 'C:/q', projectId: other.projectId })
  })
})
