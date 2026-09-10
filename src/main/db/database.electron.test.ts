import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DEFAULT_ENV_SYNC_PATTERNS } from '@shared/types'
import { closeDb, getDb, initDb, writeTx } from './database'
import * as repo from './repositories'

/**
 * The migrations and the repositories against a REAL SQLite file. better-sqlite3
 * is built for Electron's ABI, so this suite does not run under plain vitest:
 * `npm run test:db` runs it on Electron-as-Node (see scripts/test-db.mjs).
 *
 * What is pinned here is the highest-blast-radius code in the app — the
 * in-place rename of a pre-revamp database (the user's every project, tab and
 * task rides through it), its idempotency on a second boot, and that the
 * repositories' multi-statement writes are atomic.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbital-db-test-'))
  initDb(dir)
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

/** A database as the app wrote it before the workspace→project / flight→worktree revamp. */
function writeLegacyDb(file: string): void {
  const d = new Database(file)
  d.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
      env_sync_patterns TEXT NOT NULL DEFAULT '[]',
      default_agent_provider TEXT NOT NULL DEFAULT 'claude',
      agent_exec_path TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL
    );
    CREATE TABLE flights (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, worktree_path TEXT NOT NULL, branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle', task_id TEXT, split_direction TEXT NOT NULL DEFAULT 'row',
      layout TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_flights_workspace ON flights(workspace_id);
    CREATE TABLE panes (
      id TEXT PRIMARY KEY, flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, flex REAL NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_panes_flight ON panes(flight_id);
    CREATE TABLE tabs (
      id TEXT PRIMARY KEY, flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
      pane_id TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE, type TEXT NOT NULL, status TEXT,
      position INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_tabs_flight ON tabs(flight_id);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo',
      flight_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('ws1', 'repo', 'C:/repo', '["**/.env"]', 'codex', 'C:/tools/codex.exe', 1);
    INSERT INTO flights VALUES ('f1', 'ws1', 'root', 'main', 'C:/repo', 'main', 'idle', NULL, 'row', '', 1);
    INSERT INTO flights VALUES ('f2', 'ws1', 'worktree', 'feat', 'C:/repo/.orbital-worktrees/repo/feat', 'feat', 'idle', 't1', 'row', '', 2);
    INSERT INTO panes VALUES ('p1', 'f1', 0, 1);
    INSERT INTO tabs VALUES ('tab1', 'f1', 'p1', 'terminal', 'idle', 0, 1, '{}');
    INSERT INTO tasks VALUES ('t1', 'ws1', 'Older task', '', 'todo', 'f2', 5, 5);
    INSERT INTO tasks VALUES ('t2', 'ws1', 'Newer task', 'd', 'done', NULL, 9, 9);
    INSERT INTO settings VALUES ('app', '{"theme":"light"}');
  `)
  d.close()
}

const tables = (): string[] =>
  (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))

describe('a fresh database', () => {
  it('creates the schema, WAL mode and exactly one Default workspace, and stays that way on reopen', () => {
    expect(tables()).toEqual(['panes', 'projects', 'settings', 'tabs', 'tasks', 'workspaces', 'worktrees'])
    expect(getDb().pragma('journal_mode', { simple: true })).toBe('wal')
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
    const first = repo.workspaces.list()
    expect(first.map((w) => w.name)).toEqual(['Default'])
    closeDb()
    initDb(dir)
    expect(repo.workspaces.list().map((w) => w.id)).toEqual(first.map((w) => w.id))
  })
})

describe('migrating a pre-revamp database', () => {
  it('renames tables and columns in place, keeping every row, and scopes projects to the Default workspace', () => {
    closeDb()
    writeLegacyDb(join(dir, 'orbital.db'))
    initDb(dir)
    const d = getDb()
    expect(tables()).toEqual(['panes', 'projects', 'settings', 'tabs', 'tasks', 'workspaces', 'worktrees'])

    const ws = repo.workspaces.list()
    expect(ws.map((w) => w.name)).toEqual(['Default'])
    const project = d.prepare('SELECT * FROM projects').get() as Record<string, unknown>
    expect(project.id).toBe('ws1')
    expect(project.workspace_id).toBe(ws[0].id)
    expect(project.repo_path).toBe('C:/repo')
    // The provider column was renamed, not dropped — the stored value rides through.
    expect(project.default_agent_id).toBe('codex')
    expect(project.agent_exec_path).toBe('C:/tools/codex.exe')

    const wts = d.prepare('SELECT id, project_id, kind, path FROM worktrees ORDER BY created_at').all() as Record<
      string,
      unknown
    >[]
    expect(wts).toEqual([
      { id: 'f1', project_id: 'ws1', kind: 'root', path: 'C:/repo' },
      { id: 'f2', project_id: 'ws1', kind: 'linked', path: 'C:/repo/.orbital-worktrees/repo/feat' }
    ])
    expect(d.prepare('SELECT worktree_id FROM panes').get()).toEqual({ worktree_id: 'f1' })
    expect(d.prepare('SELECT worktree_id, pane_id FROM tabs').get()).toEqual({ worktree_id: 'f1', pane_id: 'p1' })

    // Tasks got numbers in creation order, kept their links, and grew the tags column.
    const tasks = d
      .prepare('SELECT id, seq, project_id, worktree_id, tags FROM tasks ORDER BY seq')
      .all() as Record<string, unknown>[]
    expect(tasks).toEqual([
      { id: 't1', seq: 1, project_id: 'ws1', worktree_id: 'f2', tags: '[]' },
      { id: 't2', seq: 2, project_id: 'ws1', worktree_id: null, tags: '[]' }
    ])
    // The projects' stored env patterns were folded into the settings blob
    // (union with the defaults), so a custom glob survives the move.
    const app = JSON.parse((d.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }).value)
    expect(app.theme).toBe('light')
    expect(app.envSyncPatterns).toEqual(expect.arrayContaining(['**/.env', ...DEFAULT_ENV_SYNC_PATTERNS]))
  })

  it('is idempotent: a second boot changes nothing', () => {
    closeDb()
    writeLegacyDb(join(dir, 'orbital.db'))
    initDb(dir)
    const snapshot = (): unknown => ({
      tables: tables(),
      projects: getDb().prepare('SELECT * FROM projects ORDER BY id').all(),
      worktrees: getDb().prepare('SELECT * FROM worktrees ORDER BY id').all(),
      tasks: getDb().prepare('SELECT * FROM tasks ORDER BY id').all(),
      workspaces: getDb().prepare('SELECT id, name, settings FROM workspaces').all()
    })
    const first = snapshot()
    closeDb()
    initDb(dir)
    expect(snapshot()).toEqual(first)
  })
})

describe('repositories', () => {
  let projectId: string

  beforeEach(() => {
    repo.setActiveWorkspaceId(repo.workspaces.list()[0].id)
    projectId = repo.projects.create({ name: 'p', repoPath: 'C:/p' }).id
  })

  it('creates a worktree with its first pane and a layout that covers it, atomically', () => {
    const w = repo.worktrees.create({ projectId, kind: 'root', name: 'main', path: 'C:/p', branch: 'main' })
    expect(w.panes.length).toBe(1)
    expect(w.layout).toEqual({ type: 'pane', paneId: w.panes[0].id })
    const stored = getDb().prepare('SELECT layout FROM worktrees WHERE id = ?').get(w.id) as { layout: string }
    expect(JSON.parse(stored.layout)).toEqual(w.layout)
  })

  it('rolls back everything a failing write transaction did', () => {
    expect(() =>
      writeTx(() => {
        repo.projects.create({ name: 'doomed', repoPath: 'C:/doomed' })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(repo.projects.list().map((p) => p.name)).toEqual(['p'])
  })

  it('numbers tasks monotonically and never reuses a deleted number', () => {
    const a = repo.tasks.create({ projectId, title: 'a' })
    const b = repo.tasks.create({ projectId, title: 'b' })
    expect([a.seq, b.seq]).toEqual([1, 2])
    repo.tasks.remove(b.id)
    expect(repo.tasks.create({ projectId, title: 'c' }).seq).toBe(3)
  })

  it('makes a new tab the active one in its pane and moves it with its activation', () => {
    const w = repo.worktrees.create({ projectId, kind: 'root', name: 'main', path: 'C:/p', branch: 'main' })
    const pane = w.panes[0].id
    const t1 = repo.tabs.create({ worktreeId: w.id, paneId: pane, type: 'terminal' })
    const t2 = repo.tabs.create({ worktreeId: w.id, paneId: pane, type: 'editor' })
    expect(repo.worktrees.get(w.id)!.panes[0].activeTabId).toBe(t2.id)
    const other = repo.panes.create(w.id)
    repo.tabs.move(t1.id, other.id)
    const panes = repo.worktrees.get(w.id)!.panes
    expect(panes.find((p) => p.id === other.id)!.activeTabId).toBe(t1.id)
    expect(panes.find((p) => p.id === pane)!.tabs.map((t) => t.id)).toEqual([t2.id])
  })
})
