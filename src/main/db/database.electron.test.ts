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

const ALL_TABLES = [
  'panes',
  'project_folders',
  'project_rail_positions',
  'projects',
  'settings',
  'tabs',
  'tasks',
  'workspaces',
  'worktrees'
]

describe('a fresh database', () => {
  it('creates the schema, WAL mode and exactly one Default workspace, and stays that way on reopen', () => {
    expect(tables()).toEqual(ALL_TABLES)
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
    expect(tables()).toEqual(ALL_TABLES)

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
    // ...and the archived_at column, NULL: every pre-existing task stays active.
    expect(d.prepare('SELECT archived_at FROM tasks').all()).toEqual([{ archived_at: null }, { archived_at: null }])
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
    const a = repo.tasks.create({ projectId, title: 'a', createdBy: 'user' })
    const b = repo.tasks.create({ projectId, title: 'b', createdBy: 'user' })
    expect([a.seq, b.seq]).toEqual([1, 2])
    // Only a project removal still deletes task rows; simulate one going away.
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(b.id)
    expect(repo.tasks.create({ projectId, title: 'c', createdBy: 'user' }).seq).toBe(3)
  })

  it('archives a task instead of deleting it: hidden from list(), kept with its number, reversible', () => {
    const a = repo.tasks.create({ projectId, title: 'a', createdBy: 'user' })
    const b = repo.tasks.create({ projectId, title: 'b', createdBy: 'user' })
    expect(a.archivedAt).toBeNull()
    getDb().prepare('UPDATE tasks SET updated_at = 0 WHERE id = ?').run(b.id)

    repo.tasks.archive(b.id)
    const archived = repo.tasks.get(b.id)!
    expect(archived.archivedAt).toEqual(expect.any(Number))
    expect(archived.updatedAt).toBe(archived.archivedAt)
    expect(archived.seq).toBe(2)
    expect(repo.tasks.list().map((t) => t.id)).toEqual([a.id])
    expect(repo.tasks.list('archived').map((t) => t.id)).toEqual([b.id])
    expect(repo.tasks.list('all').map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    // Archiving does not free the number.
    expect(repo.tasks.create({ projectId, title: 'c', createdBy: 'user' }).seq).toBe(3)

    getDb().prepare('UPDATE tasks SET updated_at = 0 WHERE id = ?').run(b.id)
    repo.tasks.unarchive(b.id)
    const back = repo.tasks.get(b.id)!
    expect(back.archivedAt).toBeNull()
    expect(back.updatedAt).toBeGreaterThan(0)
    expect(repo.tasks.list('archived')).toEqual([])
  })

  it("still cascades a removed project's tasks, archived ones included", () => {
    const t = repo.tasks.create({ projectId, title: 'a', createdBy: 'user' })
    repo.tasks.archive(t.id)
    repo.projects.remove(projectId)
    expect(repo.tasks.get(t.id)).toBeUndefined()
  })

  it('records who filed a task and when, and bumps updated_at on edits', () => {
    const before = Date.now()
    const t = repo.tasks.create({ projectId, title: 'from the cli', createdBy: 'agent' })
    expect(t.createdBy).toBe('agent')
    expect(t.createdAt).toBeGreaterThanOrEqual(before)
    expect(t.updatedAt).toBe(t.createdAt)
    // A row from before provenance tracking has no creator.
    getDb().prepare("UPDATE tasks SET created_by = '' WHERE id = ?").run(t.id)
    expect(repo.tasks.get(t.id)!.createdBy).toBeNull()
    getDb().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(t.createdAt - 60_000, t.id)
    const edited = repo.tasks.update(t.id, { title: 'renamed' })
    expect(edited.updatedAt).toBeGreaterThanOrEqual(t.createdAt)
    expect(edited.createdAt).toBe(t.createdAt)
  })

  it('links a task and the worktree started from it on both rows, and unlinks the task when the worktree goes', () => {
    const task = repo.tasks.create({ projectId, title: 'do it', createdBy: 'user' })
    const w = repo.worktrees.create({
      projectId,
      kind: 'linked',
      name: 'do it',
      path: 'C:/p-wt',
      branch: 'do-it',
      taskId: task.id
    })
    expect(w.taskId).toBe(task.id)
    expect(repo.tasks.get(task.id)!.worktreeId).toBe(w.id)

    repo.worktrees.remove(w.id)
    expect(repo.worktrees.get(w.id)).toBeUndefined()
    // No dangling link: the task is startable again.
    expect(repo.tasks.get(task.id)!.worktreeId).toBeNull()
  })

  it('links a task to a worktree that already exists', () => {
    const task = repo.tasks.create({ projectId, title: 'adopted', createdBy: 'user' })
    const w = repo.worktrees.create({ projectId, kind: 'linked', name: 'x', path: 'C:/p-x', branch: 'x' })
    repo.worktrees.linkTask(w.id, task.id)
    expect(repo.worktrees.get(w.id)!.taskId).toBe(task.id)
    expect(repo.tasks.get(task.id)!.worktreeId).toBe(w.id)
  })

  it('heals a task left pointing at a removed worktree by an older build, on the next boot', () => {
    const task = repo.tasks.create({ projectId, title: 'stranded', createdBy: 'user' })
    const kept = repo.tasks.create({ projectId, title: 'linked', createdBy: 'user' })
    const w = repo.worktrees.create({ projectId, kind: 'linked', name: 'y', path: 'C:/p-y', branch: 'y', taskId: kept.id })
    getDb().prepare('UPDATE tasks SET worktree_id = ? WHERE id = ?').run('gone-worktree', task.id)
    closeDb()
    initDb(dir)
    expect(repo.tasks.get(task.id)!.worktreeId).toBeNull()
    expect(repo.tasks.get(kept.id)!.worktreeId).toBe(w.id)
  })

  describe('rail folders', () => {
    const projectRow = (pid: string): unknown => getDb().prepare('SELECT * FROM projects WHERE id = ?').get(pid)
    const add = (name: string): string => repo.projects.create({ name, repoPath: `C:/${name}` }).id
    /**
     * The rail as it would be drawn, by name: a loose project is its name, a
     * folder is `Name[its projects]`. Read through getAppState, so this is what
     * the renderer is sent.
     */
    const rail = (): string[] => {
      const state = repo.getAppState()
      const name = (pid: string): string => state.projects.find((p) => p.id === pid)?.name ?? '?'
      return state.projectRail.map((item) => {
        if (item.kind === 'project') return name(item.id)
        const folder = state.projectFolders.find((f) => f.id === item.id)!
        return `${folder.name}[${folder.projectIds.map(name).join(' ')}]`
      })
    }

    it('files a project without changing anything about the project itself', () => {
      const before = projectRow(projectId)
      const stateBefore = repo.projects.get(projectId)
      const listBefore = repo.projects.list()
      const folder = repo.projectFolders.create('Work')
      expect(folder).toEqual({ id: folder.id, name: 'Work', collapsed: false, projectIds: [] })

      repo.projectFolders.placeProject(projectId, folder.id, null)
      expect(repo.projectFolders.get(folder.id)!.projectIds).toEqual([projectId])
      // Same row, byte for byte, and the same entity over the bridge: where the
      // project sits is recorded beside it, never on it.
      expect(projectRow(projectId)).toEqual(before)
      expect(repo.projects.get(projectId)).toEqual(stateBefore)
      expect(repo.projects.list()).toEqual(listBefore)
      expect(repo.getAppState().projectFolders).toEqual(repo.projectFolders.list())
      expect(repo.getAppState().projectRail).toEqual(repo.projectFolders.rail())
    })

    it('lists projects nobody has arranged oldest first, with a new folder above them', () => {
      add('a')
      add('b')
      expect(rail()).toEqual(['p', 'a', 'b'])
      repo.projectFolders.create('Work')
      expect(rail()).toEqual(['Work[]', 'p', 'a', 'b'])
      // A project added afterwards still lands at the end.
      add('c')
      expect(rail()).toEqual(['Work[]', 'p', 'a', 'b', 'c'])
    })

    it('keeps a project in one place: one folder, or the top level', () => {
      const a = repo.projectFolders.create('A')
      const b = repo.projectFolders.create('B')
      repo.projectFolders.placeProject(projectId, a.id, null)
      repo.projectFolders.placeProject(projectId, b.id, null)
      expect(rail()).toEqual(['B[p]', 'A[]'])

      repo.projectFolders.placeProject(projectId, null, a.id)
      expect(rail()).toEqual(['B[]', 'p', 'A[]'])
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM project_rail_positions').get()).toEqual({ n: 1 })
    })

    it('orders the top level by hand, with a folder anywhere among the projects', () => {
      const a = add('a')
      const b = add('b')
      const work = repo.projectFolders.create('Work').id
      expect(rail()).toEqual(['Work[]', 'p', 'a', 'b'])

      // A folder between two projects, then last, then back before a project.
      repo.projectFolders.placeFolder(work, b)
      expect(rail()).toEqual(['p', 'a', 'Work[]', 'b'])
      repo.projectFolders.placeFolder(work, null)
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[]'])
      repo.projectFolders.placeFolder(work, a)
      expect(rail()).toEqual(['p', 'Work[]', 'a', 'b'])

      // A project before a folder, before another project, and last.
      repo.projectFolders.placeProject(b, null, work)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])
      repo.projectFolders.placeProject(a, null, projectId)
      expect(rail()).toEqual(['a', 'p', 'b', 'Work[]'])
      repo.projectFolders.placeProject(a, null, null)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])

      // Before itself changes nothing; before something that is not there goes last.
      repo.projectFolders.placeFolder(work, work)
      repo.projectFolders.placeProject(b, null, b)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])
      repo.projectFolders.placeFolder(work, 'missing')
      expect(rail()).toEqual(['p', 'b', 'a', 'Work[]'])

      // A second folder is its own row in the same order.
      const play = repo.projectFolders.create('Play').id
      repo.projectFolders.placeFolder(play, work)
      expect(rail()).toEqual(['p', 'b', 'a', 'Play[]', 'Work[]'])
      // A project added once the rail is arranged still lands at the end.
      add('z')
      expect(rail()).toEqual(['p', 'b', 'a', 'Play[]', 'Work[]', 'z'])
    })

    it('orders the projects inside a folder by hand', () => {
      const a = add('a')
      const b = add('b')
      const work = repo.projectFolders.create('Work').id
      for (const pid of [projectId, a, b]) repo.projectFolders.placeProject(pid, work, null)
      expect(rail()).toEqual(['Work[p a b]'])

      repo.projectFolders.placeProject(b, work, projectId)
      expect(rail()).toEqual(['Work[b p a]'])
      repo.projectFolders.placeProject(b, work, a)
      expect(rail()).toEqual(['Work[p b a]'])
      repo.projectFolders.placeProject(projectId, work, null)
      expect(rail()).toEqual(['Work[b a p]'])

      // Out to the top level and back in at a chosen place.
      repo.projectFolders.placeProject(a, null, work)
      expect(rail()).toEqual(['a', 'Work[b p]'])
      repo.projectFolders.placeProject(a, work, projectId)
      expect(rail()).toEqual(['Work[b a p]'])

      // From one folder straight into the middle of another.
      const play = repo.projectFolders.create('Play').id
      repo.projectFolders.placeProject(a, play, null)
      repo.projectFolders.placeProject(b, play, a)
      expect(rail()).toEqual(['Play[b a]', 'Work[p]'])
    })

    it('puts a folder made for a project where that project was', () => {
      const a = add('a')
      add('b')
      repo.projectFolders.create('Work', a)
      expect(rail()).toEqual(['p', 'Work[a]', 'b'])
      // Made for a project that is already filed, it sits just below that folder.
      repo.projectFolders.create('Other', a)
      expect(rail()).toEqual(['p', 'Work[]', 'Other[a]', 'b'])
    })

    it('deleting a folder only ungroups: its projects take its place, and nothing else goes', () => {
      const w = repo.worktrees.create({ projectId, kind: 'root', name: 'main', path: 'C:/p', branch: 'main' })
      const a = add('a')
      const b = add('b')
      const folder = repo.projectFolders.create('Work')
      repo.projectFolders.placeProject(b, folder.id, null)
      repo.projectFolders.placeProject(projectId, folder.id, null)
      repo.projectFolders.placeFolder(folder.id, null)
      repo.projectFolders.placeProject(a, null, null)
      expect(rail()).toEqual(['Work[b p]', 'a'])
      const rowsBefore = [projectId, a, b].map(projectRow)

      repo.projectFolders.remove(folder.id)
      expect(repo.projectFolders.list()).toEqual([])
      expect(rail()).toEqual(['b', 'p', 'a'])
      expect([projectId, a, b].map(projectRow)).toEqual(rowsBefore)
      expect(repo.worktrees.get(w.id)).toBeDefined()
    })

    it('removing a project takes it out of the rail and leaves its folder', () => {
      const folder = repo.projectFolders.create('Work')
      repo.projectFolders.placeProject(projectId, folder.id, null)
      repo.projects.remove(projectId)
      expect(repo.projectFolders.list()).toEqual([{ ...folder, projectIds: [] }])
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM project_rail_positions').get()).toEqual({ n: 0 })
    })

    it('remembers names, collapsed folders and the whole arrangement across a reopen', () => {
      const a = add('a')
      const b = add('b')
      const folder = repo.projectFolders.create('Work')
      repo.projectFolders.rename(folder.id, 'Clients')
      repo.projectFolders.setCollapsed(folder.id, true)
      repo.projectFolders.placeProject(b, folder.id, null)
      repo.projectFolders.placeProject(a, folder.id, b)
      repo.projectFolders.placeFolder(folder.id, null)
      closeDb()
      initDb(dir)
      expect(repo.projectFolders.list()).toEqual([
        { id: folder.id, name: 'Clients', collapsed: true, projectIds: [a, b] }
      ])
      expect(rail()).toEqual(['p', 'Clients[a b]'])
    })

    it('keeps folders and the rail order to their own workspace', () => {
      const here = repo.projectFolders.create('Here')
      const other = repo.workspaces.create('Other')
      const foreign = repo.projects.create({ name: 'x', repoPath: 'C:/x', workspaceId: other.id })

      // A project from another workspace cannot be placed in this one's rail,
      // and a move to a folder that is not there leaves a project where it was.
      repo.projectFolders.placeProject(foreign.id, here.id, null)
      repo.projectFolders.placeProject(foreign.id, null, null)
      repo.projectFolders.placeProject(projectId, here.id, null)
      repo.projectFolders.placeProject(projectId, 'missing', null)
      expect(rail()).toEqual(['Here[p]'])

      const home = repo.workspaces.list().find((w) => w.id !== other.id)!.id
      repo.setActiveWorkspaceId(other.id)
      expect(rail()).toEqual(['x'])
      // Nor can that workspace move this one's folder.
      repo.projectFolders.placeFolder(here.id, foreign.id)
      repo.setActiveWorkspaceId(home)
      expect(rail()).toEqual(['Here[p]'])

      // Deleting a workspace takes its folders with it.
      repo.workspaces.remove(other.id)
      expect(repo.projectFolders.list().map((f) => f.name)).toEqual(['Here'])
    })
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
