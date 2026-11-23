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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbital-dispatch-test-'))
  initDb(dir)
  tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
  repoId = tables.repos.create({ name: 'p', repoPath: 'C:/p' }).id
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
    tables.tasks.create({ repoId, title: 'keep', createdBy: 'agent' })
    tables.tasks.create({ repoId, title: 'shelve', createdBy: 'agent' })

    const res = await run('task-archive', { id: '#2' })
    expect(res).toMatchObject({ ok: true, data: { seq: 2, title: 'shelve' } })
    expect(await listed()).toEqual([1])
    expect(await listed({ archived: true })).toEqual([2])

    expect((await run('task-unarchive', { id: '2' })).ok).toBe(true)
    expect(await listed()).toEqual([1, 2])
    expect(await listed({ archived: true })).toEqual([])
  })

  it('treats the legacy task-delete as archive: the row survives', async () => {
    const t = tables.tasks.create({ repoId, title: 'old script', createdBy: 'agent' })
    expect((await run('task-delete', { id: String(t.seq) })).ok).toBe(true)
    expect(tables.tasks.get(t.id)?.archivedAt).toEqual(expect.any(Number))
  })

  it('--all includes done and archived tasks; --status still filters', async () => {
    tables.tasks.create({ repoId, title: 'open', createdBy: 'agent' })
    const done = tables.tasks.create({ repoId, title: 'done', createdBy: 'agent' })
    tables.tasks.update(done.id, { status: 'done' })
    const gone = tables.tasks.create({ repoId, title: 'gone', createdBy: 'agent' })
    tables.tasks.archive(gone.id)

    expect(await listed()).toEqual([1])
    expect(await listed({ all: true })).toEqual([1, 2, 3])
    expect(await listed({ status: 'done' })).toEqual([2])
    expect(await listed({ archived: true, status: 'todo' })).toEqual([3])
  })

  it('still resolves an archived task for show and update, and show carries archivedAt', async () => {
    const t = tables.tasks.create({ repoId, title: 'a', createdBy: 'agent' })
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

  it('task commands from a folder session point at orbital project', async () => {
    const { folder, project } = platform()
    const res = await handleControl({ cmd: 'task-list', worktreeId: folder.id, projectId: project.id, args: {} })
    expect(res.error).toMatch(/pass --repo <name\|id> \(`orbital project` lists its repos\)/)
  })
})
