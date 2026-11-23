import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DEFAULT_ENV_SYNC_PATTERNS } from '@shared/types'
import { closeDb, getDb, initDb, writeTx } from './database'
import * as tables from './repositories'

/**
 * The migrations and the repositories against a REAL SQLite file. better-sqlite3
 * is built for Electron's ABI, so this suite does not run under plain vitest:
 * `npm run test:db` runs it on Electron-as-Node (see scripts/test-db.mjs).
 *
 * What is pinned here is the highest-blast-radius code in the app — the
 * in-place rename of a pre-revamp database (the user's every repo, tab and
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

const tableNames = (): string[] =>
  (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))

const ALL_TABLES = [
  'panes',
  'rail_folders',
  'rail_positions',
  'repos',
  'settings',
  'tabs',
  'tasks',
  'workspaces',
  'worktrees'
]

describe('a fresh database', () => {
  it('creates the schema, WAL mode and exactly one Default workspace, and stays that way on reopen', () => {
    expect(tableNames()).toEqual(ALL_TABLES)
    expect(getDb().pragma('journal_mode', { simple: true })).toBe('wal')
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
    const first = tables.workspaces.list()
    expect(first.map((w) => w.name)).toEqual(['Default'])
    closeDb()
    initDb(dir)
    expect(tables.workspaces.list().map((w) => w.id)).toEqual(first.map((w) => w.id))
  })
})

describe('migrating a pre-revamp database', () => {
  it('renames tables and columns in place, keeping every row, and scopes repos to the Default workspace', () => {
    closeDb()
    writeLegacyDb(join(dir, 'orbital.db'))
    initDb(dir)
    const d = getDb()
    expect(tableNames()).toEqual(ALL_TABLES)

    const ws = tables.workspaces.list()
    expect(ws.map((w) => w.name)).toEqual(['Default'])
    const repo = d.prepare('SELECT * FROM repos').get() as Record<string, unknown>
    expect(repo.id).toBe('ws1')
    expect(repo.workspace_id).toBe(ws[0].id)
    expect(repo.repo_path).toBe('C:/repo')
    // The provider column was renamed, not dropped — the stored value rides through.
    expect(repo.default_agent_id).toBe('codex')
    expect(repo.agent_exec_path).toBe('C:/tools/codex.exe')

    const wts = d.prepare('SELECT id, repo_id, kind, path FROM worktrees ORDER BY created_at').all() as Record<
      string,
      unknown
    >[]
    expect(wts).toEqual([
      { id: 'f1', repo_id: 'ws1', kind: 'root', path: 'C:/repo' },
      { id: 'f2', repo_id: 'ws1', kind: 'linked', path: 'C:/repo/.orbital-worktrees/repo/feat' }
    ])
    expect(d.prepare('SELECT worktree_id FROM panes').get()).toEqual({ worktree_id: 'f1' })
    expect(d.prepare('SELECT worktree_id, pane_id FROM tabs').get()).toEqual({ worktree_id: 'f1', pane_id: 'p1' })

    // Tasks got numbers in creation order, kept their links, and grew the tags column.
    const tasks = d
      .prepare('SELECT id, seq, repo_id, worktree_id, tags FROM tasks ORDER BY seq')
      .all() as Record<string, unknown>[]
    expect(tasks).toEqual([
      { id: 't1', seq: 1, repo_id: 'ws1', worktree_id: 'f2', tags: '[]' },
      { id: 't2', seq: 2, repo_id: 'ws1', worktree_id: null, tags: '[]' }
    ])
    // ...and the archived_at column, NULL: every pre-existing task stays active.
    expect(d.prepare('SELECT archived_at FROM tasks').all()).toEqual([{ archived_at: null }, { archived_at: null }])
    // The repos' stored env patterns were folded into the settings blob
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
      tables: tableNames(),
      repos: getDb().prepare('SELECT * FROM repos ORDER BY id').all(),
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

describe('migrating a database from before the Project→Repo rename', () => {
  /**
   * Turn the fresh schema back into the v1.45 one (`projects`, `project_id`,
   * `project_folders`, `project_rail_positions`) and fill it with one of each
   * row, so the next boot has a real pre-rename database to upgrade.
   */
  function writePreRenameDb(): void {
    const workspaceId = tables.workspaces.list()[0].id
    closeDb()
    const d = new Database(join(dir, 'orbital.db'))
    d.exec(`
      ALTER TABLE repos RENAME TO projects;
      ALTER TABLE worktrees RENAME COLUMN repo_id TO project_id;
      ALTER TABLE tasks RENAME COLUMN repo_id TO project_id;
      ALTER TABLE rail_folders RENAME TO project_folders;
      ALTER TABLE rail_positions RENAME TO project_rail_positions;
      ALTER TABLE project_rail_positions RENAME COLUMN repo_id TO project_id;
    `)
    d.prepare('INSERT INTO projects (id, workspace_id, name, repo_path, added_at) VALUES (?, ?, ?, ?, 1)').run(
      'p1',
      workspaceId,
      'api',
      'C:/api'
    )
    d.prepare(
      "INSERT INTO worktrees (id, project_id, kind, name, path, branch, created_at) VALUES ('w1', 'p1', 'root', 'main', 'C:/api', 'main', 1)"
    ).run()
    d.prepare(
      "INSERT INTO tasks (id, seq, project_id, title, status, created_at, updated_at) VALUES ('t1', 1, 'p1', 'a', 'todo', 1, 1)"
    ).run()
    d.prepare(
      'INSERT INTO project_folders (id, workspace_id, name, position, created_at) VALUES (?, ?, ?, 0, 1)'
    ).run('f1', workspaceId, 'work')
    d.prepare("INSERT INTO project_rail_positions (project_id, folder_id, position) VALUES ('p1', 'f1', 0)").run()
    d.close()
  }

  it('renames the tables and columns in place, keeping every row and every link between them', () => {
    writePreRenameDb()
    initDb(dir)
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
    expect(tableNames()).toEqual(ALL_TABLES)
    expect(tables.repos.list().map((r) => [r.id, r.name, r.repoPath])).toEqual([['p1', 'api', 'C:/api']])
    expect(tables.worktrees.list().map((w) => [w.id, w.repoId])).toEqual([['w1', 'p1']])
    expect(tables.tasks.list().map((t) => [t.id, t.repoId])).toEqual([['t1', 'p1']])
    expect(tables.railFolders.list().map((f) => [f.id, f.repoIds])).toEqual([['f1', ['p1']]])
    // The FKs followed the rename: removing the repo still cascades to its rows.
    tables.repos.remove('p1')
    expect(tables.worktrees.list()).toEqual([])
    expect(tables.tasks.list()).toEqual([])
    expect(tables.railFolders.list().map((f) => f.repoIds)).toEqual([[]])
  })

  it('is idempotent, and a renamed database is never mistaken for a pre-revamp one', () => {
    writePreRenameDb()
    initDb(dir)
    const snapshot = (): unknown => ({
      tables: tableNames(),
      repos: getDb().prepare('SELECT * FROM repos ORDER BY id').all(),
      worktrees: getDb().prepare('SELECT * FROM worktrees ORDER BY id').all(),
      tasks: getDb().prepare('SELECT * FROM tasks ORDER BY id').all(),
      workspaces: getDb().prepare('SELECT id, name, settings FROM workspaces').all()
    })
    const first = snapshot()
    closeDb()
    // `workspaces` without `projects` is what a pre-revamp DB looks like; this
    // boot must not rename `workspaces` to `projects` again.
    initDb(dir)
    expect(snapshot()).toEqual(first)
  })
})

describe('repositories', () => {
  let repoId: string

  beforeEach(() => {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
    repoId = tables.repos.create({ name: 'p', repoPath: 'C:/p' }).id
  })

  it('creates a worktree with its first pane and a layout that covers it, atomically', () => {
    const w = tables.worktrees.create({ repoId, kind: 'root', name: 'main', path: 'C:/p', branch: 'main' })
    expect(w.panes.length).toBe(1)
    expect(w.layout).toEqual({ type: 'pane', paneId: w.panes[0].id })
    const stored = getDb().prepare('SELECT layout FROM worktrees WHERE id = ?').get(w.id) as { layout: string }
    expect(JSON.parse(stored.layout)).toEqual(w.layout)
  })

  it('rolls back everything a failing write transaction did', () => {
    expect(() =>
      writeTx(() => {
        tables.repos.create({ name: 'doomed', repoPath: 'C:/doomed' })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(tables.repos.list().map((p) => p.name)).toEqual(['p'])
  })

  it('numbers tasks monotonically and never reuses a deleted number', () => {
    const a = tables.tasks.create({ repoId, title: 'a', createdBy: 'user' })
    const b = tables.tasks.create({ repoId, title: 'b', createdBy: 'user' })
    expect([a.seq, b.seq]).toEqual([1, 2])
    // Only a repo removal still deletes task rows; simulate one going away.
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(b.id)
    expect(tables.tasks.create({ repoId, title: 'c', createdBy: 'user' }).seq).toBe(3)
  })

  it('archives a task instead of deleting it: hidden from list(), kept with its number, reversible', () => {
    const a = tables.tasks.create({ repoId, title: 'a', createdBy: 'user' })
    const b = tables.tasks.create({ repoId, title: 'b', createdBy: 'user' })
    expect(a.archivedAt).toBeNull()
    getDb().prepare('UPDATE tasks SET updated_at = 0 WHERE id = ?').run(b.id)

    tables.tasks.archive(b.id)
    const archived = tables.tasks.get(b.id)!
    expect(archived.archivedAt).toEqual(expect.any(Number))
    expect(archived.updatedAt).toBe(archived.archivedAt)
    expect(archived.seq).toBe(2)
    expect(tables.tasks.list().map((t) => t.id)).toEqual([a.id])
    expect(tables.tasks.list('archived').map((t) => t.id)).toEqual([b.id])
    expect(tables.tasks.list('all').map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    // Archiving does not free the number.
    expect(tables.tasks.create({ repoId, title: 'c', createdBy: 'user' }).seq).toBe(3)

    getDb().prepare('UPDATE tasks SET updated_at = 0 WHERE id = ?').run(b.id)
    tables.tasks.unarchive(b.id)
    const back = tables.tasks.get(b.id)!
    expect(back.archivedAt).toBeNull()
    expect(back.updatedAt).toBeGreaterThan(0)
    expect(tables.tasks.list('archived')).toEqual([])
  })

  it("still cascades a removed repo's tasks, archived ones included", () => {
    const t = tables.tasks.create({ repoId, title: 'a', createdBy: 'user' })
    tables.tasks.archive(t.id)
    tables.repos.remove(repoId)
    expect(tables.tasks.get(t.id)).toBeUndefined()
  })

  it('records who filed a task and when, and bumps updated_at on edits', () => {
    const before = Date.now()
    const t = tables.tasks.create({ repoId, title: 'from the cli', createdBy: 'agent' })
    expect(t.createdBy).toBe('agent')
    expect(t.createdAt).toBeGreaterThanOrEqual(before)
    expect(t.updatedAt).toBe(t.createdAt)
    // A row from before provenance tracking has no creator.
    getDb().prepare("UPDATE tasks SET created_by = '' WHERE id = ?").run(t.id)
    expect(tables.tasks.get(t.id)!.createdBy).toBeNull()
    getDb().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(t.createdAt - 60_000, t.id)
    const edited = tables.tasks.update(t.id, { title: 'renamed' })
    expect(edited.updatedAt).toBeGreaterThanOrEqual(t.createdAt)
    expect(edited.createdAt).toBe(t.createdAt)
  })

  it('links a task and the worktree started from it on both rows, and unlinks the task when the worktree goes', () => {
    const task = tables.tasks.create({ repoId, title: 'do it', createdBy: 'user' })
    const w = tables.worktrees.create({
      repoId,
      kind: 'linked',
      name: 'do it',
      path: 'C:/p-wt',
      branch: 'do-it',
      taskId: task.id
    })
    expect(w.taskId).toBe(task.id)
    expect(tables.tasks.get(task.id)!.worktreeId).toBe(w.id)

    tables.worktrees.remove(w.id)
    expect(tables.worktrees.get(w.id)).toBeUndefined()
    // No dangling link: the task is startable again.
    expect(tables.tasks.get(task.id)!.worktreeId).toBeNull()
  })

  it('links a task to a worktree that already exists', () => {
    const task = tables.tasks.create({ repoId, title: 'adopted', createdBy: 'user' })
    const w = tables.worktrees.create({ repoId, kind: 'linked', name: 'x', path: 'C:/p-x', branch: 'x' })
    tables.worktrees.linkTask(w.id, task.id)
    expect(tables.worktrees.get(w.id)!.taskId).toBe(task.id)
    expect(tables.tasks.get(task.id)!.worktreeId).toBe(w.id)
  })

  it('heals a task left pointing at a removed worktree by an older build, on the next boot', () => {
    const task = tables.tasks.create({ repoId, title: 'stranded', createdBy: 'user' })
    const kept = tables.tasks.create({ repoId, title: 'linked', createdBy: 'user' })
    const w = tables.worktrees.create({ repoId, kind: 'linked', name: 'y', path: 'C:/p-y', branch: 'y', taskId: kept.id })
    getDb().prepare('UPDATE tasks SET worktree_id = ? WHERE id = ?').run('gone-worktree', task.id)
    closeDb()
    initDb(dir)
    expect(tables.tasks.get(task.id)!.worktreeId).toBeNull()
    expect(tables.tasks.get(kept.id)!.worktreeId).toBe(w.id)
  })

  describe('rail folders', () => {
    const repoRow = (pid: string): unknown => getDb().prepare('SELECT * FROM repos WHERE id = ?').get(pid)
    const add = (name: string): string => tables.repos.create({ name, repoPath: `C:/${name}` }).id
    /**
     * The rail as it would be drawn, by name: a loose repo is its name, a
     * folder is `Name[its repos]`. Read through getAppState, so this is what
     * the renderer is sent.
     */
    const rail = (): string[] => {
      const state = tables.getAppState()
      const name = (pid: string): string => state.repos.find((p) => p.id === pid)?.name ?? '?'
      return state.railItems.map((item) => {
        if (item.kind === 'repo') return name(item.id)
        const folder = state.railFolders.find((f) => f.id === item.id)!
        return `${folder.name}[${folder.repoIds.map(name).join(' ')}]`
      })
    }

    it('files a repo without changing anything about the repo itself', () => {
      const before = repoRow(repoId)
      const stateBefore = tables.repos.get(repoId)
      const listBefore = tables.repos.list()
      const folder = tables.railFolders.create('Work')
      expect(folder).toEqual({ id: folder.id, name: 'Work', collapsed: false, repoIds: [] })

      tables.railFolders.placeRepo(repoId, folder.id, null)
      expect(tables.railFolders.get(folder.id)!.repoIds).toEqual([repoId])
      // Same row, byte for byte, and the same entity over the bridge: where the
      // repo sits is recorded beside it, never on it.
      expect(repoRow(repoId)).toEqual(before)
      expect(tables.repos.get(repoId)).toEqual(stateBefore)
      expect(tables.repos.list()).toEqual(listBefore)
      expect(tables.getAppState().railFolders).toEqual(tables.railFolders.list())
      expect(tables.getAppState().railItems).toEqual(tables.railFolders.rail())
    })

    it('lists repos nobody has arranged oldest first, with a new folder above them', () => {
      add('a')
      add('b')
      expect(rail()).toEqual(['p', 'a', 'b'])
      tables.railFolders.create('Work')
      expect(rail()).toEqual(['Work[]', 'p', 'a', 'b'])
      // A repo added afterwards still lands at the end.
      add('c')
      expect(rail()).toEqual(['Work[]', 'p', 'a', 'b', 'c'])
    })

    it('keeps a repo in one place: one folder, or the top level', () => {
      const a = tables.railFolders.create('A')
      const b = tables.railFolders.create('B')
      tables.railFolders.placeRepo(repoId, a.id, null)
      tables.railFolders.placeRepo(repoId, b.id, null)
      expect(rail()).toEqual(['B[p]', 'A[]'])

      tables.railFolders.placeRepo(repoId, null, a.id)
      expect(rail()).toEqual(['B[]', 'p', 'A[]'])
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM rail_positions').get()).toEqual({ n: 1 })
    })

    it('orders the top level by hand, with a folder anywhere among the repos', () => {
      const a = add('a')
      const b = add('b')
      const work = tables.railFolders.create('Work').id
      expect(rail()).toEqual(['Work[]', 'p', 'a', 'b'])

      // A folder between two repos, then last, then back before a repo.
      tables.railFolders.placeFolder(work, b)
      expect(rail()).toEqual(['p', 'a', 'Work[]', 'b'])
      tables.railFolders.placeFolder(work, null)
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[]'])
      tables.railFolders.placeFolder(work, a)
      expect(rail()).toEqual(['p', 'Work[]', 'a', 'b'])

      // A repo before a folder, before another repo, and last.
      tables.railFolders.placeRepo(b, null, work)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])
      tables.railFolders.placeRepo(a, null, repoId)
      expect(rail()).toEqual(['a', 'p', 'b', 'Work[]'])
      tables.railFolders.placeRepo(a, null, null)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])

      // Before itself changes nothing; before something that is not there goes last.
      tables.railFolders.placeFolder(work, work)
      tables.railFolders.placeRepo(b, null, b)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])
      tables.railFolders.placeFolder(work, 'missing')
      expect(rail()).toEqual(['p', 'b', 'a', 'Work[]'])

      // A second folder is its own row in the same order.
      const play = tables.railFolders.create('Play').id
      tables.railFolders.placeFolder(play, work)
      expect(rail()).toEqual(['p', 'b', 'a', 'Play[]', 'Work[]'])
      // A repo added once the rail is arranged still lands at the end.
      add('z')
      expect(rail()).toEqual(['p', 'b', 'a', 'Play[]', 'Work[]', 'z'])
    })

    it('orders the repos inside a folder by hand', () => {
      const a = add('a')
      const b = add('b')
      const work = tables.railFolders.create('Work').id
      for (const pid of [repoId, a, b]) tables.railFolders.placeRepo(pid, work, null)
      expect(rail()).toEqual(['Work[p a b]'])

      tables.railFolders.placeRepo(b, work, repoId)
      expect(rail()).toEqual(['Work[b p a]'])
      tables.railFolders.placeRepo(b, work, a)
      expect(rail()).toEqual(['Work[p b a]'])
      tables.railFolders.placeRepo(repoId, work, null)
      expect(rail()).toEqual(['Work[b a p]'])

      // Out to the top level and back in at a chosen place.
      tables.railFolders.placeRepo(a, null, work)
      expect(rail()).toEqual(['a', 'Work[b p]'])
      tables.railFolders.placeRepo(a, work, repoId)
      expect(rail()).toEqual(['Work[b a p]'])

      // From one folder straight into the middle of another.
      const play = tables.railFolders.create('Play').id
      tables.railFolders.placeRepo(a, play, null)
      tables.railFolders.placeRepo(b, play, a)
      expect(rail()).toEqual(['Play[b a]', 'Work[p]'])
    })

    it('puts a folder made for a repo where that repo was', () => {
      const a = add('a')
      add('b')
      tables.railFolders.create('Work', a)
      expect(rail()).toEqual(['p', 'Work[a]', 'b'])
      // Made for a repo that is already filed, it sits just below that folder.
      tables.railFolders.create('Other', a)
      expect(rail()).toEqual(['p', 'Work[]', 'Other[a]', 'b'])
    })

    it('deleting a folder only ungroups: its repos take its place, and nothing else goes', () => {
      const w = tables.worktrees.create({ repoId, kind: 'root', name: 'main', path: 'C:/p', branch: 'main' })
      const a = add('a')
      const b = add('b')
      const folder = tables.railFolders.create('Work')
      tables.railFolders.placeRepo(b, folder.id, null)
      tables.railFolders.placeRepo(repoId, folder.id, null)
      tables.railFolders.placeFolder(folder.id, null)
      tables.railFolders.placeRepo(a, null, null)
      expect(rail()).toEqual(['Work[b p]', 'a'])
      const rowsBefore = [repoId, a, b].map(repoRow)

      tables.railFolders.remove(folder.id)
      expect(tables.railFolders.list()).toEqual([])
      expect(rail()).toEqual(['b', 'p', 'a'])
      expect([repoId, a, b].map(repoRow)).toEqual(rowsBefore)
      expect(tables.worktrees.get(w.id)).toBeDefined()
    })

    it('removing a repo takes it out of the rail and leaves its folder', () => {
      const folder = tables.railFolders.create('Work')
      tables.railFolders.placeRepo(repoId, folder.id, null)
      tables.repos.remove(repoId)
      expect(tables.railFolders.list()).toEqual([{ ...folder, repoIds: [] }])
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM rail_positions').get()).toEqual({ n: 0 })
    })

    it('remembers names, collapsed folders and the whole arrangement across a reopen', () => {
      const a = add('a')
      const b = add('b')
      const folder = tables.railFolders.create('Work')
      tables.railFolders.rename(folder.id, 'Clients')
      tables.railFolders.setCollapsed(folder.id, true)
      tables.railFolders.placeRepo(b, folder.id, null)
      tables.railFolders.placeRepo(a, folder.id, b)
      tables.railFolders.placeFolder(folder.id, null)
      closeDb()
      initDb(dir)
      expect(tables.railFolders.list()).toEqual([
        { id: folder.id, name: 'Clients', collapsed: true, repoIds: [a, b] }
      ])
      expect(rail()).toEqual(['p', 'Clients[a b]'])
    })

    it('keeps folders and the rail order to their own workspace', () => {
      const here = tables.railFolders.create('Here')
      const other = tables.workspaces.create('Other')
      const foreign = tables.repos.create({ name: 'x', repoPath: 'C:/x', workspaceId: other.id })

      // A repo from another workspace cannot be placed in this one's rail,
      // and a move to a folder that is not there leaves a repo where it was.
      tables.railFolders.placeRepo(foreign.id, here.id, null)
      tables.railFolders.placeRepo(foreign.id, null, null)
      tables.railFolders.placeRepo(repoId, here.id, null)
      tables.railFolders.placeRepo(repoId, 'missing', null)
      expect(rail()).toEqual(['Here[p]'])

      const home = tables.workspaces.list().find((w) => w.id !== other.id)!.id
      tables.setActiveWorkspaceId(other.id)
      expect(rail()).toEqual(['x'])
      // Nor can that workspace move this one's folder.
      tables.railFolders.placeFolder(here.id, foreign.id)
      tables.setActiveWorkspaceId(home)
      expect(rail()).toEqual(['Here[p]'])

      // Deleting a workspace takes its folders with it.
      tables.workspaces.remove(other.id)
      expect(tables.railFolders.list().map((f) => f.name)).toEqual(['Here'])
    })
  })

  it('makes a new tab the active one in its pane and moves it with its activation', () => {
    const w = tables.worktrees.create({ repoId, kind: 'root', name: 'main', path: 'C:/p', branch: 'main' })
    const pane = w.panes[0].id
    const t1 = tables.tabs.create({ worktreeId: w.id, paneId: pane, type: 'terminal' })
    const t2 = tables.tabs.create({ worktreeId: w.id, paneId: pane, type: 'editor' })
    expect(tables.worktrees.get(w.id)!.panes[0].activeTabId).toBe(t2.id)
    const other = tables.panes.create(w.id)
    tables.tabs.move(t1.id, other.id)
    const panes = tables.worktrees.get(w.id)!.panes
    expect(panes.find((p) => p.id === other.id)!.activeTabId).toBe(t1.id)
    expect(panes.find((p) => p.id === pane)!.tabs.map((t) => t.id)).toEqual([t2.id])
  })
})
