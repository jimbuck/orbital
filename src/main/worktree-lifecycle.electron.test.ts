import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Worktree } from '@shared/types'
import { closeDb, initDb } from './db/database'
import * as repo from './db/repositories'

/**
 * Worktree and Project lifecycle through its interface, against a real git
 * repository and a real SQLite store (hence `*.electron.test.ts`, run by
 * `npm run test:db`). What is stood in for is what would otherwise reach the
 * live app: the runtime's watchers, PTYs and pushes, PTY launch, the
 * node_modules bulk copy, and Electron itself.
 */
const rt = vi.hoisted(() => ({
  watch: vi.fn(),
  unwatch: vi.fn(),
  kill: vi.fn(),
  state: vi.fn(),
  alert: vi.fn(),
  markSettingUp: vi.fn(),
  clearSettingUp: vi.fn(),
  clearDevServers: vi.fn(),
  gitChanged: vi.fn(),
  startPtyTab: vi.fn(),
  deleteBriefing: vi.fn()
}))

vi.mock('electron', () => ({ shell: {}, app: {}, clipboard: {} }))
vi.mock('./runtime', async () => ({
  repo: await import('./db/repositories'),
  runtime: {
    gitWatcher: { watch: rt.watch, unwatch: rt.unwatch },
    terminals: { kill: rt.kill, on: vi.fn() },
    broadcastState: rt.state,
    broadcastAlert: rt.alert,
    broadcastGitChanged: rt.gitChanged,
    markSettingUp: rt.markSettingUp,
    clearSettingUp: rt.clearSettingUp,
    clearDevServers: rt.clearDevServers
  }
}))
vi.mock('./services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), cli: vi.fn(), ui: vi.fn(), isEnabled: () => false }
}))
vi.mock('./services/agents/launch', () => ({ startPtyTab: rt.startPtyTab }))
vi.mock('./services/agents/briefing', () => ({
  deleteBriefing: rt.deleteBriefing,
  pruneBriefings: vi.fn(),
  briefingKey: (w: string, t: string) => `${w}:${t}`
}))
vi.mock('./services/pasted-images', () => ({ prunePastedImages: vi.fn() }))
// The node_modules bulk copy runs in the background and outlives the call that
// started it; the env-file sync that happens inline stays real.
vi.mock('./services/env-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/env-sync')>()),
  copyNodeModulesTree: vi.fn(async () => ({ copied: 0, skipped: 0, links: 0, bytes: 0, errorCount: 0, errors: [], ms: 0 }))
}))
// Real checkout removal, wrapped so one test can make it fail.
vi.mock('./services/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/worktree')>()
  return { ...actual, removeWorktree: vi.fn(actual.removeWorktree) }
})

const { createWorktree, removeWorktree, addProject, removeProject, stopWorktreesWatchers } = await import(
  './worktree-lifecycle'
)
const checkout = await import('./services/worktree')

let dir: string
let repoPath: string
let project: Project
let root: Worktree

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(() => {
  // realpath: on Windows tmpdir() can be an 8.3 short path, which git reports
  // back in long form and the lifecycle then fails to match against its rows.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orbital-lifecycle-test-')))
  initDb(dir)
  repo.setActiveWorkspaceId(repo.workspaces.list()[0].id)

  repoPath = join(dir, 'repo')
  mkdirSync(repoPath)
  gitIn(repoPath, 'init', '-q', '-b', 'main')
  gitIn(repoPath, 'config', 'user.email', 'test@example.com')
  gitIn(repoPath, 'config', 'user.name', 'Test')
  gitIn(repoPath, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoPath, '.gitignore'), '.env\n')
  writeFileSync(join(repoPath, 'README.md'), 'hello\n')
  writeFileSync(join(repoPath, '.env'), 'SECRET=1\n')
  gitIn(repoPath, 'add', '.gitignore', 'README.md')
  gitIn(repoPath, 'commit', '-q', '-m', 'init')

  project = repo.projects.create({ name: 'repo', repoPath })
  root = repo.worktrees.create({ projectId: project.id, kind: 'root', name: 'main', path: repoPath, branch: 'main' })
  for (const spy of Object.values(rt)) spy.mockClear()
})

afterEach(() => {
  stopWorktreesWatchers()
  closeDb()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('creating a Worktree', () => {
  it('checks out a new branch, records it, copies env files, watches it and tells the window', async () => {
    const w = await createWorktree({ projectId: project.id, name: 'Login flow' })

    expect(w).toMatchObject({ kind: 'linked', name: 'Login flow', branch: 'login-flow', projectId: project.id })
    expect(w.panes).toHaveLength(1)
    expect(gitIn(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('login-flow')
    expect(readFileSync(join(w.path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(repo.worktrees.get(w.id)).toBeDefined()
    expect(rt.watch).toHaveBeenCalledWith(w.path)
    expect(rt.state).toHaveBeenCalled()
    expect(rt.alert).toHaveBeenCalled()
  })

  it('starts the background node_modules copy when node_modules is a sync target', async () => {
    const w = await createWorktree({ projectId: project.id, name: 'deps' })
    expect(rt.markSettingUp).toHaveBeenCalledWith(w.id)
  })

  it('takes an explicit branch over the name, and forks it from the base ref', async () => {
    gitIn(repoPath, 'branch', 'release')
    const w = await createWorktree({ projectId: project.id, name: 'Hotfix', branch: 'fix/crash', baseRef: 'release' })
    expect(w.branch).toBe('fix/crash')
    expect(w.name).toBe('Hotfix')
    expect(gitIn(w.path, 'rev-parse', 'HEAD')).toBe(gitIn(repoPath, 'rev-parse', 'release'))
  })

  it('opens an existing branch instead of creating one', async () => {
    gitIn(repoPath, 'branch', 'feature/a')
    const w = await createWorktree({ projectId: project.id, existingBranch: 'feature/a' })
    expect(w.branch).toBe('feature/a')
    expect(gitIn(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/a')
  })

  it('started from a task: named after it, linked both ways, and the task moves to in-progress', async () => {
    const task = repo.tasks.create({ projectId: project.id, title: 'Fix the flaky test', createdBy: 'user' })
    expect(task.status).not.toBe('in_progress')

    const w = await createWorktree({ projectId: project.id, taskId: task.id })

    expect(w).toMatchObject({ name: 'Fix the flaky test', branch: 'fix-the-flaky-test', taskId: task.id })
    expect(repo.tasks.get(task.id)).toMatchObject({ worktreeId: w.id, status: 'in_progress' })
  })

  it('links a task that is already done without reopening it', async () => {
    const task = repo.tasks.create({ projectId: project.id, title: 'Shipped', createdBy: 'user' })
    repo.tasks.update(task.id, { status: 'done' })
    const w = await createWorktree({ projectId: project.id, taskId: task.id, name: 'follow-up' })
    expect(repo.tasks.get(task.id)).toMatchObject({ worktreeId: w.id, status: 'done' })
  })

  it('rejects an unknown project or task and creates nothing', async () => {
    await expect(createWorktree({ projectId: 'nope', name: 'x' })).rejects.toThrow(/project nope not found/)
    await expect(createWorktree({ projectId: project.id, taskId: 'nope' })).rejects.toThrow(/task nope not found/)
    expect(repo.worktrees.list().map((w) => w.id)).toEqual([root.id])
    expect(rt.watch).not.toHaveBeenCalled()
    expect(rt.state).not.toHaveBeenCalled()
  })
})

describe('removing a Worktree', () => {
  const made = async (name = 'feature'): Promise<Worktree> => {
    const w = await createWorktree({ projectId: project.id, name })
    for (const spy of Object.values(rt)) spy.mockClear()
    return w
  }

  it('refuses the root Worktree', async () => {
    await expect(removeWorktree(root.id, { removeWorktree: true })).rejects.toThrow(/root Worktree cannot be removed/)
    expect(repo.worktrees.get(root.id)).toBeDefined()
  })

  it('refuses a checkout with uncommitted changes, and leaves it fully intact', async () => {
    const w = await made()
    repo.tabs.create({ worktreeId: w.id, paneId: w.panes[0].id, type: 'terminal' })
    writeFileSync(join(w.path, 'README.md'), 'edited\n')

    await expect(removeWorktree(w.id, { removeWorktree: true })).rejects.toThrow(/uncommitted changes/)

    expect(existsSync(w.path)).toBe(true)
    expect(repo.worktrees.get(w.id)).toBeDefined()
    expect(rt.kill).not.toHaveBeenCalled()
    expect(rt.unwatch).not.toHaveBeenCalled()
  })

  it('deletes a clean checkout: PTYs, watcher, briefing, row and task link all go', async () => {
    const task = repo.tasks.create({ projectId: project.id, title: 'feature', createdBy: 'user' })
    const w = await createWorktree({ projectId: project.id, taskId: task.id })
    const terminal = repo.tabs.create({ worktreeId: w.id, paneId: w.panes[0].id, type: 'terminal' })
    const agent = repo.tabs.create({ worktreeId: w.id, paneId: w.panes[0].id, type: 'agent' })
    for (const spy of Object.values(rt)) spy.mockClear()

    await removeWorktree(w.id, { removeWorktree: true })

    expect(existsSync(w.path)).toBe(false)
    expect(repo.worktrees.get(w.id)).toBeUndefined()
    expect(repo.tasks.get(task.id)!.worktreeId).toBeNull()
    expect(rt.kill).toHaveBeenCalledWith(terminal.id)
    expect(rt.kill).toHaveBeenCalledWith(agent.id)
    expect(rt.deleteBriefing).toHaveBeenCalledWith(w.id, agent.id)
    expect(rt.unwatch).toHaveBeenCalledWith(w.path)
    expect(rt.clearDevServers).toHaveBeenCalledWith(w.id)
    expect(rt.state).toHaveBeenCalled()
    expect(rt.alert).toHaveBeenCalled()
    expect(gitIn(repoPath, 'worktree', 'list', '--porcelain')).not.toContain('feature')
  })

  it('deletes a dirty checkout when forced', async () => {
    const w = await made()
    writeFileSync(join(w.path, 'README.md'), 'edited\n')
    await removeWorktree(w.id, { removeWorktree: true, force: true })
    expect(existsSync(w.path)).toBe(false)
    expect(repo.worktrees.get(w.id)).toBeUndefined()
  })

  it('closes a Worktree but keeps its checkout on disk when not asked to delete it', async () => {
    const w = await made()
    writeFileSync(join(w.path, 'README.md'), 'edited\n') // dirty is fine: nothing is deleted
    await removeWorktree(w.id, {})
    expect(existsSync(w.path)).toBe(true)
    expect(repo.worktrees.get(w.id)).toBeUndefined()
    expect(rt.unwatch).toHaveBeenCalledWith(w.path)
  })

  it('puts the Worktree back in a usable state when git cannot delete the checkout', async () => {
    const w = await made()
    const terminal = repo.tabs.create({ worktreeId: w.id, paneId: w.panes[0].id, type: 'terminal' })
    repo.tabs.create({ worktreeId: w.id, paneId: w.panes[0].id, type: 'editor' })
    vi.mocked(checkout.removeWorktree).mockRejectedValueOnce(new Error('directory is locked'))

    await expect(removeWorktree(w.id, { removeWorktree: true })).rejects.toThrow('directory is locked')

    // Still there, watched again, and its PTY tabs (only those) have fresh PTYs.
    expect(repo.worktrees.get(w.id)).toBeDefined()
    expect(existsSync(w.path)).toBe(true)
    expect(rt.unwatch).toHaveBeenCalledWith(w.path)
    expect(rt.watch).toHaveBeenCalledWith(w.path)
    expect(rt.kill).toHaveBeenCalledWith(terminal.id)
    expect(rt.startPtyTab).toHaveBeenCalledTimes(1)
    expect(rt.startPtyTab.mock.calls[0][1]).toMatchObject({ id: terminal.id })
    expect(rt.state).toHaveBeenCalled()
  })

  it('is a no-op for a Worktree that is already gone', async () => {
    await removeWorktree('nope', { removeWorktree: true })
    expect(rt.state).not.toHaveBeenCalled()
  })
})

describe('adding and removing a Project', () => {
  it('registers the repo with a root Worktree and adopts the worktrees it already has', async () => {
    const other = join(dir, 'other')
    mkdirSync(other)
    gitIn(other, 'init', '-q', '-b', 'trunk')
    gitIn(other, 'config', 'user.email', 'test@example.com')
    gitIn(other, 'config', 'user.name', 'Test')
    gitIn(other, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(other, 'a.txt'), 'a\n')
    gitIn(other, 'add', 'a.txt')
    gitIn(other, 'commit', '-q', '-m', 'init')
    gitIn(other, 'worktree', 'add', '-q', '-b', 'side', join(dir, 'other-side'))

    const added = await addProject(other)

    const rows = repo.worktrees.list().filter((w) => w.projectId === added.id)
    expect(rows.map((w) => [w.kind, w.branch]).sort()).toEqual([
      ['linked', 'side'],
      ['root', 'trunk']
    ])
    expect(rt.watch).toHaveBeenCalledWith(other)
    expect(rt.state).toHaveBeenCalled()
    // Adding it again is the same Project, not a second one.
    expect((await addProject(other)).id).toBe(added.id)
  })

  it('removes a Project and everything held for its Worktrees, leaving the checkouts on disk', async () => {
    const w = await createWorktree({ projectId: project.id, name: 'feature' })
    const terminal = repo.tabs.create({ worktreeId: w.id, paneId: w.panes[0].id, type: 'terminal' })
    for (const spy of Object.values(rt)) spy.mockClear()

    removeProject(project.id)

    expect(repo.projects.get(project.id)).toBeUndefined()
    expect(repo.worktrees.list()).toEqual([])
    expect(rt.kill).toHaveBeenCalledWith(terminal.id)
    expect(rt.unwatch).toHaveBeenCalledWith(w.path)
    expect(rt.unwatch).toHaveBeenCalledWith(repoPath)
    expect(existsSync(w.path)).toBe(true)
    expect(existsSync(repoPath)).toBe(true)
    expect(rt.state).toHaveBeenCalled()
  })
})
