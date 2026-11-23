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
  runtime: { broadcastState: vi.fn() }
}))
vi.mock('../services/worktree', () => ({}))
vi.mock('../services/settings', () => ({}))
vi.mock('../services/logger', () => ({ logger: { cli: vi.fn(), error: vi.fn() } }))
vi.mock('../services/agents/launch', () => ({}))
vi.mock('../tabs', () => ({}))
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
