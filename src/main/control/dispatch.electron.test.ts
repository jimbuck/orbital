import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlRequest } from '@shared/types'
import { closeDb, initDb } from '../db/database'
import * as repo from '../db/repositories'

/**
 * The `task` CLI commands' dispatch against a real SQLite store (hence
 * `*.electron.test.ts`, run by `npm run test:db`). Everything else the
 * dispatcher reaches for (the runtime's broadcast, worktree and tab services)
 * is stubbed; the task handlers only need the repositories.
 */
vi.mock('../runtime', async () => ({
  repo: await import('../db/repositories'),
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
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbital-dispatch-test-'))
  initDb(dir)
  repo.setActiveWorkspaceId(repo.workspaces.list()[0].id)
  projectId = repo.projects.create({ name: 'p', repoPath: 'C:/p' }).id
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const run = (cmd: ControlRequest['cmd'], args: Record<string, unknown> = {}) =>
  handleControl({ cmd, projectId, args })

const listed = async (args: Record<string, unknown> = {}): Promise<number[]> => {
  const res = await run('task-list', args)
  expect(res.ok).toBe(true)
  return (res.data as { seq: number }[]).map((t) => t.seq).sort((a, b) => a - b)
}

describe('task archive', () => {
  it('archives by number, hides the task from the default list, and unarchives it again', async () => {
    repo.tasks.create({ projectId, title: 'keep', createdBy: 'agent' })
    repo.tasks.create({ projectId, title: 'shelve', createdBy: 'agent' })

    const res = await run('task-archive', { id: '#2' })
    expect(res).toMatchObject({ ok: true, data: { seq: 2, title: 'shelve' } })
    expect(await listed()).toEqual([1])
    expect(await listed({ archived: true })).toEqual([2])

    expect((await run('task-unarchive', { id: '2' })).ok).toBe(true)
    expect(await listed()).toEqual([1, 2])
    expect(await listed({ archived: true })).toEqual([])
  })

  it('treats the legacy task-delete as archive: the row survives', async () => {
    const t = repo.tasks.create({ projectId, title: 'old script', createdBy: 'agent' })
    expect((await run('task-delete', { id: String(t.seq) })).ok).toBe(true)
    expect(repo.tasks.get(t.id)?.archivedAt).toEqual(expect.any(Number))
  })

  it('--all includes done and archived tasks; --status still filters', async () => {
    repo.tasks.create({ projectId, title: 'open', createdBy: 'agent' })
    const done = repo.tasks.create({ projectId, title: 'done', createdBy: 'agent' })
    repo.tasks.update(done.id, { status: 'done' })
    const gone = repo.tasks.create({ projectId, title: 'gone', createdBy: 'agent' })
    repo.tasks.archive(gone.id)

    expect(await listed()).toEqual([1])
    expect(await listed({ all: true })).toEqual([1, 2, 3])
    expect(await listed({ status: 'done' })).toEqual([2])
    expect(await listed({ archived: true, status: 'todo' })).toEqual([3])
  })

  it('still resolves an archived task for show and update, and show carries archivedAt', async () => {
    const t = repo.tasks.create({ projectId, title: 'a', createdBy: 'agent' })
    repo.tasks.archive(t.id)

    const shown = await run('task-show', { id: '1' })
    expect(shown.ok).toBe(true)
    expect((shown.data as { archivedAt: number | null }).archivedAt).toEqual(expect.any(Number))

    const updated = await run('task-update', { id: t.id.slice(0, 8), title: 'renamed' })
    expect(updated).toMatchObject({ ok: true, data: { title: 'renamed' } })
    // An edit does not unarchive.
    expect(repo.tasks.get(t.id)?.archivedAt).toEqual(expect.any(Number))
  })

  it('reports an unknown number', async () => {
    expect(await run('task-archive', { id: '99' })).toEqual({ ok: false, error: "no task matches number '99'" })
  })
})
