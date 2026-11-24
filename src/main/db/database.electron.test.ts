import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DEFAULT_ENV_SYNC_PATTERNS, type Project, type RailItem, type Repo } from '@shared/types'
import { closeDb, getDb, initDb, writeTx } from './database'
import * as tables from './repositories'
import { exportWorkspaceToFile, importWorkspaceFromFile } from '../services/workspaces'
import { writeWorkspaceYaml } from '../services/workspace-yaml'

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
  'projects',
  'rail_folders',
  'rail_positions',
  'rail_repo_positions',
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

    const wts = d
      .prepare('SELECT id, repo_id, project_id, kind, path FROM worktrees ORDER BY created_at')
      .all() as Record<string, unknown>[]
    // The legacy `flights.workspace_id` became `repo_id`; the project-session
    // `project_id` added after it is a new, empty column, never the old one.
    expect(wts).toEqual([
      { id: 'f1', repo_id: 'ws1', project_id: null, kind: 'root', path: 'C:/repo' },
      { id: 'f2', repo_id: 'ws1', project_id: null, kind: 'linked', path: 'C:/repo/.orbital-worktrees/repo/feat' }
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

/**
 * A database from before projects, written by hand with one of each row and
 * an arranged rail: `docs` loose at the top, then a collapsed folder `Work`
 * holding `web` then `api`, then `loose`, which was never arranged.
 *
 * `v145` spells it as v1.45 did, before the Project→Repo rename (`projects`,
 * `project_id`, `project_folders`, `project_rail_positions` and their index
 * names); otherwise as that rename left it (`repos`, `repo_id`, a rail keyed
 * by repo). Either way the next boot has to end up with the same projects.
 */
function writePreProjectsDb(v145: boolean): void {
  const repo = v145 ? 'projects' : 'repos'
  const fk = v145 ? 'project_id' : 'repo_id'
  const folders = v145 ? 'project_folders' : 'rail_folders'
  const positions = v145 ? 'project_rail_positions' : 'rail_positions'
  const d = new Database(join(dir, 'orbital.db'))
  d.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, last_opened_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ${repo} (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, repo_path TEXT NOT NULL, env_sync_patterns TEXT NOT NULL DEFAULT '[]',
      default_agent_id TEXT NOT NULL DEFAULT 'claude', agent_exec_path TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL
    );
    CREATE INDEX idx_${repo}_workspace ON ${repo}(workspace_id);
    CREATE UNIQUE INDEX idx_${repo}_ws_path ON ${repo}(workspace_id, repo_path);
    CREATE TABLE ${folders} (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_${folders}_workspace ON ${folders}(workspace_id);
    CREATE TABLE ${positions} (
      ${fk} TEXT PRIMARY KEY REFERENCES ${repo}(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES ${folders}(id) ON DELETE CASCADE, position INTEGER NOT NULL
    );
    CREATE INDEX idx_${positions}_folder ON ${positions}(folder_id);
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY, ${fk} TEXT NOT NULL REFERENCES ${repo}(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle', task_id TEXT, split_direction TEXT NOT NULL DEFAULT 'row',
      layout TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_worktrees_${v145 ? 'project' : 'repo'} ON worktrees(${fk});
    CREATE TABLE panes (
      id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, flex REAL NOT NULL DEFAULT 1
    );
    CREATE TABLE tabs (
      id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      pane_id TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE, type TEXT NOT NULL, status TEXT,
      position INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, seq INTEGER, ${fk} TEXT NOT NULL REFERENCES ${repo}(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'todo', worktree_id TEXT, created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
    );
    CREATE INDEX idx_tasks_${v145 ? 'project' : 'repo'} ON tasks(${fk});
    CREATE UNIQUE INDEX idx_tasks_seq ON tasks(seq);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    INSERT INTO workspaces VALUES ('ws', 'Default', '{}', 1, 1);
    INSERT INTO ${repo} (id, workspace_id, name, repo_path, added_at) VALUES
      ('r-api', 'ws', 'api', 'C:/src/acme/api', 1),
      ('r-web', 'ws', 'web', 'C:/src/acme/web', 2),
      ('r-docs', 'ws', 'docs', 'C:/docs', 3),
      ('r-loose', 'ws', 'loose', 'C:/loose', 4);
    INSERT INTO ${folders} VALUES ('f-work', 'ws', 'Work', 1, 1, 1);
    INSERT INTO ${positions} (${fk}, folder_id, position) VALUES
      ('r-docs', NULL, 0), ('r-web', 'f-work', 0), ('r-api', 'f-work', 1);
    INSERT INTO worktrees (id, ${fk}, kind, name, path, branch, created_at)
      VALUES ('w1', 'r-api', 'root', 'main', 'C:/src/acme/api', 'main', 1);
    INSERT INTO tasks (id, seq, ${fk}, title, status, created_at, updated_at)
      VALUES ('t1', 1, 'r-api', 'a', 'todo', 1, 1);
  `)
  d.close()
}

/** A list of rail rows by name: a project or a repo is its name, a folder `Name[its rows]`, nested as it nests. */
function rowsByName(items: RailItem[]): string[] {
  const state = tables.getAppState()
  const one = (item: RailItem): string => {
    if (item.kind === 'project') return state.projects.find((p) => p.id === item.id)?.name ?? '?'
    if (item.kind === 'repo') return state.repos.find((r) => r.id === item.id)?.name ?? '?'
    const folder = state.railFolders.find((f) => f.id === item.id)!
    return `${folder.name}[${folder.items.map(one).join(' ')}]`
  }
  return items.map(one)
}

/** The rail as drawn, through getAppState, so this is what the renderer is sent. */
function railByName(): string[] {
  return rowsByName(tables.getAppState().railItems)
}

/** A project's own list as the rail arranges it: its repos (the home too) and its folders. */
function membersByName(pid: string): string[] {
  const state = tables.getAppState()
  // A project with no folders is not sent a list: its repos read as repoIds has them.
  return rowsByName(state.railProjectItems[pid] ?? state.projects.find((p) => p.id === pid)!.repoIds.map((id) => ({ kind: 'repo', id })))
}

const columns = (table: string): string[] =>
  (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

describe.each([
  ['from before the Project→Repo rename (v1.45)', true],
  ['from after the rename but before projects', false]
])('migrating a database %s', (_label, v145) => {
  it('gives every repo a project of its own and keeps the rail, every row and every link', () => {
    writePreProjectsDb(v145)
    tables.setActiveWorkspaceId('ws')
    expect(tableNames()).toEqual(ALL_TABLES)
    expect(columns('rail_positions')).toEqual(['project_id', 'folder_id', 'position'])

    const repos = tables.repos.list()
    expect(repos.map((r) => [r.id, r.name, r.repoPath])).toEqual([
      ['r-api', 'api', 'C:/src/acme/api'],
      ['r-web', 'web', 'C:/src/acme/web'],
      ['r-docs', 'docs', 'C:/docs'],
      ['r-loose', 'loose', 'C:/loose']
    ])
    // One project per repo, named after it and rooted at it, in repo order.
    const projects = tables.projects.list()
    expect(
      projects.map((p) => [p.name, p.rootPath, p.repoIds, p.homeRepoId, p.managedBlock, p.codeWorkspace])
    ).toEqual([
      ['api', 'C:/src/acme/api', ['r-api'], null, true, false],
      ['web', 'C:/src/acme/web', ['r-web'], null, true, false],
      ['docs', 'C:/docs', ['r-docs'], null, true, false],
      ['loose', 'C:/loose', ['r-loose'], null, true, false]
    ])
    for (const r of repos) expect(projects.find((p) => p.id === r.projectId)!.repoIds).toEqual([r.id])

    // The rail is the same rail, folder, order and collapsed state included.
    expect(railByName()).toEqual(['docs', 'Work[web api]', 'loose'])
    expect(tables.railFolders.list().map((f) => [f.id, f.collapsed])).toEqual([['f-work', true]])

    expect(tables.worktrees.list().map((w) => [w.id, w.repoId])).toEqual([['w1', 'r-api']])
    expect(tables.tasks.list().map((t) => [t.id, t.repoId])).toEqual([['t1', 'r-api']])
    // The FKs followed both migrations: removing the repo still cascades to its
    // rows, and takes its now-empty project and that project's rail row along.
    tables.repos.remove('r-api')
    expect(tables.worktrees.list()).toEqual([])
    expect(tables.tasks.list()).toEqual([])
    expect(tables.projects.list().map((p) => p.name)).toEqual(['web', 'docs', 'loose'])
    expect(railByName()).toEqual(['docs', 'Work[web]', 'loose'])
  })

  it('is idempotent, and a migrated database is never mistaken for an older one', () => {
    writePreProjectsDb(v145)
    const snapshot = (): unknown => ({
      tables: tableNames(),
      repos: getDb().prepare('SELECT * FROM repos ORDER BY id').all(),
      projects: getDb().prepare('SELECT * FROM projects ORDER BY id').all(),
      rail: getDb().prepare('SELECT * FROM rail_positions ORDER BY project_id').all(),
      folders: getDb().prepare('SELECT * FROM rail_folders ORDER BY id').all(),
      worktrees: getDb().prepare('SELECT * FROM worktrees ORDER BY id').all(),
      tasks: getDb().prepare('SELECT * FROM tasks ORDER BY id').all(),
      workspaces: getDb().prepare('SELECT id, name, settings FROM workspaces').all()
    })
    const first = snapshot()
    closeDb()
    // `projects` beside `repos` is the new table, not the old name for repos;
    // and `workspaces` without the old `projects` must not read as pre-revamp.
    initDb(dir)
    expect(snapshot()).toEqual(first)
  })
})

describe('giving worktrees project sessions', () => {
  /** `worktrees` as PRAGMA reports it: column name → NOT NULL. */
  const worktreeShape = (): Record<string, number> =>
    Object.fromEntries(
      (getDb().prepare('PRAGMA table_info(worktrees)').all() as Array<{ name: string; notnull: number }>).map((c) => [
        c.name,
        c.notnull
      ])
    )
  const indexes = (): string[] =>
    (
      getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'worktrees'").all() as Array<{
        name: string
      }>
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'))
      .sort()

  it('makes a fresh database with the shape already', () => {
    expect(worktreeShape()).toMatchObject({ repo_id: 0, project_id: 0, kind: 1 })
    expect(indexes()).toEqual(['idx_worktrees_project', 'idx_worktrees_repo'])
  })

  it.each([
    ['from before projects', false],
    ['from v1.45', true]
  ])(
    'rebuilds an older worktrees table %s, keeping every row and every link to it',
    (_label, v145) => {
      closeDb()
      writePreProjectsDb(v145)
      // A pane and a tab hang off the worktree by table name; the rebuild must not strand them.
      const raw = new Database(join(dir, 'orbital.db'))
      raw.exec(`
        INSERT INTO panes (id, worktree_id, position) VALUES ('p1', 'w1', 0);
        INSERT INTO tabs (id, worktree_id, pane_id, type, position) VALUES ('tab1', 'w1', 'p1', 'terminal', 0);
        UPDATE tasks SET worktree_id = 'w1';
      `)
      raw.close()
      initDb(dir)
      tables.setActiveWorkspaceId('ws')

      expect(worktreeShape()).toMatchObject({ repo_id: 0, project_id: 0 })
      expect(indexes()).toEqual(['idx_worktrees_project', 'idx_worktrees_repo'])
      const row = getDb().prepare('SELECT * FROM worktrees').get() as Record<string, unknown>
      expect(row).toMatchObject({ id: 'w1', repo_id: 'r-api', project_id: null, kind: 'root', path: 'C:/src/acme/api' })
      expect(getDb().pragma('foreign_key_check')).toEqual([])
      expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)

      // Hydrated, the repo worktree reports its repo's project.
      const api = tables.repos.get('r-api')!
      expect(tables.worktrees.get('w1')).toMatchObject({ repoId: 'r-api', projectId: api.projectId })
      expect(tables.worktrees.get('w1')!.panes[0].tabs.map((t) => t.id)).toEqual(['tab1'])
      expect(tables.tasks.get('t1')?.worktreeId).toBe('w1')

      // The cascades still run through the rebuilt table, both ways down.
      tables.worktrees.remove('w1')
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM panes').get()).toEqual({ n: 0 })
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM tabs').get()).toEqual({ n: 0 })
    }
  )

  it('is idempotent: a second boot leaves the rebuilt table alone', () => {
    closeDb()
    writePreProjectsDb(false)
    initDb(dir)
    const snapshot = (): unknown => ({
      sql: getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'worktrees'").get(),
      rows: getDb().prepare('SELECT * FROM worktrees ORDER BY id').all()
    })
    const first = snapshot()
    closeDb()
    initDb(dir)
    expect(snapshot()).toEqual(first)
  })

  it('stores a folder session with no repo, in its project\'s workspace, cascading with the project', () => {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
    const project = tables.projects.create({ name: 'Platform', rootPath: 'C:/platform' })
    const folder = tables.worktrees.create({
      repoId: null,
      projectId: project.id,
      kind: 'folder',
      name: 'Platform',
      path: 'C:/platform',
      branch: ''
    })
    expect(folder).toMatchObject({ repoId: null, projectId: project.id, kind: 'folder' })
    expect(tables.worktrees.list().map((w) => w.id)).toEqual([folder.id])
    expect(tables.worktrees.listStatuses().map((w) => w.id)).toEqual([folder.id])
    expect(tables.worktrees.listPaths()).toEqual([
      { id: folder.id, path: 'C:/platform', repoId: null, projectId: project.id, kind: 'folder' }
    ])
    expect(tables.worktrees.idsByPath('C:/platform')).toEqual([folder.id])
    expect(tables.worktrees.folderOf(project.id)?.id).toBe(folder.id)
    // A branch sync at its path (a repo checked out at the root too) leaves it branchless.
    tables.worktrees.updateBranchByPath('C:/platform', 'main')
    expect(tables.worktrees.get(folder.id)?.branch).toBe('')

    // Another workspace does not see it.
    const other = tables.workspaces.create('Other')
    tables.setActiveWorkspaceId(other.id)
    expect(tables.worktrees.list()).toEqual([])
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)

    tables.projects.remove(project.id)
    expect(tables.worktrees.get(folder.id)).toBeUndefined()
  })

  it('keeps a project workspace-file flag, off by default', () => {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
    const project = tables.projects.create({ name: 'Platform', rootPath: 'C:/platform' })
    expect(project.codeWorkspace).toBe(false)
    tables.projects.setCodeWorkspace(project.id, true)
    expect(tables.projects.get(project.id)?.codeWorkspace).toBe(true)
    tables.projects.setCodeWorkspace(project.id, false)
    expect(tables.projects.get(project.id)?.codeWorkspace).toBe(false)
  })
})

describe('the boot-time project heal', () => {
  beforeEach(() => {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
  })

  it('gives a repo with no project one of its own, at the end of the rail', () => {
    const a = tables.repos.create({ name: 'a', repoPath: 'C:/a' })
    const b = tables.repos.create({ name: 'b', repoPath: 'C:/b' })
    tables.railFolders.placeProject(b.projectId, null, a.projectId)
    // SQL cannot stop this (the column is nullable), so the boot mends it.
    getDb().pragma('foreign_keys = OFF')
    getDb().prepare('UPDATE repos SET project_id = NULL WHERE id = ?').run(a.id)
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(a.projectId)
    getDb().pragma('foreign_keys = ON')
    closeDb()
    initDb(dir)
    const healed = tables.repos.get(a.id)!
    expect(healed.projectId).not.toBe('')
    expect(healed.projectId).not.toBe(a.projectId)
    expect(tables.projects.get(healed.projectId)).toMatchObject({ name: 'a', rootPath: 'C:/a', repoIds: [a.id] })
    expect(railByName()).toEqual(['b', 'a'])
  })

  it('clears a home that is not one of its project repos', () => {
    const a = tables.repos.create({ name: 'a', repoPath: 'C:/a' })
    const b = tables.repos.create({ name: 'b', repoPath: 'C:/b' })
    getDb().prepare('UPDATE projects SET home_repo_id = ? WHERE id = ?').run(b.id, a.projectId)
    closeDb()
    initDb(dir)
    expect(tables.projects.get(a.projectId)!.homeRepoId).toBeNull()
  })
})

describe('repositories', () => {
  let repoId: string
  let projectId: string

  beforeEach(() => {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
    const repo = tables.repos.create({ name: 'p', repoPath: 'C:/p' })
    repoId = repo.id
    projectId = repo.projectId
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
    const a = tables.tasks.create({ projectId, repoId, title: 'a', createdBy: 'user' })
    const b = tables.tasks.create({ projectId, repoId, title: 'b', createdBy: 'user' })
    expect([a.seq, b.seq]).toEqual([1, 2])
    // Only a project removal deletes task rows; simulate one going away.
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(b.id)
    expect(tables.tasks.create({ projectId, repoId, title: 'c', createdBy: 'user' }).seq).toBe(3)
  })

  it('archives a task instead of deleting it: hidden from list(), kept with its number, reversible', () => {
    const a = tables.tasks.create({ projectId, repoId, title: 'a', createdBy: 'user' })
    const b = tables.tasks.create({ projectId, repoId, title: 'b', createdBy: 'user' })
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
    expect(tables.tasks.create({ projectId, repoId, title: 'c', createdBy: 'user' }).seq).toBe(3)

    getDb().prepare('UPDATE tasks SET updated_at = 0 WHERE id = ?').run(b.id)
    tables.tasks.unarchive(b.id)
    const back = tables.tasks.get(b.id)!
    expect(back.archivedAt).toBeNull()
    expect(back.updatedAt).toBeGreaterThan(0)
    expect(tables.tasks.list('archived')).toEqual([])
  })

  it("removing a project's last repo still takes its tasks, archived ones included, with the project", () => {
    const t = tables.tasks.create({ projectId, repoId, title: 'a', createdBy: 'user' })
    tables.tasks.archive(t.id)
    tables.repos.remove(repoId)
    expect(tables.tasks.get(t.id)).toBeUndefined()
  })

  it('records who filed a task and when, and bumps updated_at on edits', () => {
    const before = Date.now()
    const t = tables.tasks.create({ projectId, repoId, title: 'from the cli', createdBy: 'agent' })
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
    const task = tables.tasks.create({ projectId, repoId, title: 'do it', createdBy: 'user' })
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
    const task = tables.tasks.create({ projectId, repoId, title: 'adopted', createdBy: 'user' })
    const w = tables.worktrees.create({ repoId, kind: 'linked', name: 'x', path: 'C:/p-x', branch: 'x' })
    tables.worktrees.linkTask(w.id, task.id)
    expect(tables.worktrees.get(w.id)!.taskId).toBe(task.id)
    expect(tables.tasks.get(task.id)!.worktreeId).toBe(w.id)
  })

  it('heals a task left pointing at a removed worktree by an older build, on the next boot', () => {
    const task = tables.tasks.create({ projectId, repoId, title: 'stranded', createdBy: 'user' })
    const kept = tables.tasks.create({ projectId, repoId, title: 'linked', createdBy: 'user' })
    const w = tables.worktrees.create({ repoId, kind: 'linked', name: 'y', path: 'C:/p-y', branch: 'y', taskId: kept.id })
    getDb().prepare('UPDATE tasks SET worktree_id = ? WHERE id = ?').run('gone-worktree', task.id)
    closeDb()
    initDb(dir)
    expect(tables.tasks.get(task.id)!.worktreeId).toBeNull()
    expect(tables.tasks.get(kept.id)!.worktreeId).toBe(w.id)
  })

  describe('rail folders', () => {
    const projectRow = (pid: string): unknown => getDb().prepare('SELECT * FROM projects WHERE id = ?').get(pid)
    const repoRow = (rid: string): unknown => getDb().prepare('SELECT * FROM repos WHERE id = ?').get(rid)
    /** Add a repo (and with it a project of its own); returns the PROJECT id, which is what the rail arranges. */
    const add = (name: string): string => tables.repos.create({ name, repoPath: `C:/${name}` }).projectId
    /** Through getAppState, so this is what the renderer is sent. */
    const rail = railByName
    let p: string

    beforeEach(() => {
      p = tables.repos.get(repoId)!.projectId
    })

    it('files a project without changing anything about the project or its repo', () => {
      const before = [projectRow(p), repoRow(repoId)]
      const stateBefore = tables.projects.get(p)
      const listBefore = tables.repos.list()
      const folder = tables.railFolders.create('Work')
      expect(folder).toEqual({
        id: folder.id,
        name: 'Work',
        collapsed: false,
        projectId: null,
        parentId: null,
        items: []
      })

      tables.railFolders.placeProject(p, folder.id, null)
      expect(tables.railFolders.get(folder.id)!.items).toEqual([{ kind: 'project', id: p }])
      // Same rows, byte for byte, and the same entities over the bridge: where
      // the project sits is recorded beside it, never on it.
      expect([projectRow(p), repoRow(repoId)]).toEqual(before)
      expect(tables.projects.get(p)).toEqual(stateBefore)
      expect(tables.repos.list()).toEqual(listBefore)
      expect(tables.getAppState().railFolders).toEqual(tables.railFolders.list())
      expect(tables.getAppState().railItems).toEqual(tables.railFolders.rail())
      // No project has folders among its repos, so none is sent a list of its own.
      expect(tables.getAppState().railProjectItems).toEqual({})
    })

    it('lists projects nobody has arranged oldest first, with a new folder after them', () => {
      add('a')
      add('b')
      expect(rail()).toEqual(['p', 'a', 'b'])
      tables.railFolders.create('Work')
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[]'])
      // A project added afterwards lands at the end too, and so does the next folder.
      add('c')
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[]', 'c'])
      tables.railFolders.create('Play')
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[]', 'c', 'Play[]'])
    })

    it('keeps a project in one place: one folder, or the top level', () => {
      const a = tables.railFolders.create('A')
      const b = tables.railFolders.create('B')
      tables.railFolders.placeProject(p, a.id, null)
      tables.railFolders.placeProject(p, b.id, null)
      expect(rail()).toEqual(['A[]', 'B[p]'])

      tables.railFolders.placeProject(p, null, b.id)
      expect(rail()).toEqual(['A[]', 'p', 'B[]'])
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM rail_positions').get()).toEqual({ n: 1 })
    })

    it('orders the top level by hand, with a folder anywhere among the projects', () => {
      const a = add('a')
      const b = add('b')
      const work = tables.railFolders.create('Work').id
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[]'])

      // A folder between two projects, then last, then back before a project.
      tables.railFolders.placeFolder(work, null, b)
      expect(rail()).toEqual(['p', 'a', 'Work[]', 'b'])
      tables.railFolders.placeFolder(work, null, null)
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[]'])
      tables.railFolders.placeFolder(work, null, a)
      expect(rail()).toEqual(['p', 'Work[]', 'a', 'b'])

      // A project before a folder, before another project, and last.
      tables.railFolders.placeProject(b, null, work)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])
      tables.railFolders.placeProject(a, null, p)
      expect(rail()).toEqual(['a', 'p', 'b', 'Work[]'])
      tables.railFolders.placeProject(a, null, null)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])

      // Before itself changes nothing; before something that is not there goes last.
      tables.railFolders.placeFolder(work, null, work)
      tables.railFolders.placeProject(b, null, b)
      expect(rail()).toEqual(['p', 'b', 'Work[]', 'a'])
      tables.railFolders.placeFolder(work, null, 'missing')
      expect(rail()).toEqual(['p', 'b', 'a', 'Work[]'])

      // A second folder is its own row in the same order.
      const play = tables.railFolders.create('Play').id
      tables.railFolders.placeFolder(play, null, work)
      expect(rail()).toEqual(['p', 'b', 'a', 'Play[]', 'Work[]'])
      // A project added once the rail is arranged still lands at the end.
      add('z')
      expect(rail()).toEqual(['p', 'b', 'a', 'Play[]', 'Work[]', 'z'])
    })

    it('orders the projects inside a folder by hand', () => {
      const a = add('a')
      const b = add('b')
      const work = tables.railFolders.create('Work').id
      for (const pid of [p, a, b]) tables.railFolders.placeProject(pid, work, null)
      expect(rail()).toEqual(['Work[p a b]'])

      tables.railFolders.placeProject(b, work, p)
      expect(rail()).toEqual(['Work[b p a]'])
      tables.railFolders.placeProject(b, work, a)
      expect(rail()).toEqual(['Work[p b a]'])
      tables.railFolders.placeProject(p, work, null)
      expect(rail()).toEqual(['Work[b a p]'])

      // Out to the top level and back in at a chosen place.
      tables.railFolders.placeProject(a, null, work)
      expect(rail()).toEqual(['a', 'Work[b p]'])
      tables.railFolders.placeProject(a, work, p)
      expect(rail()).toEqual(['Work[b a p]'])

      // From one folder straight into the middle of another.
      const play = tables.railFolders.create('Play').id
      tables.railFolders.placeProject(a, play, null)
      tables.railFolders.placeProject(b, play, a)
      expect(rail()).toEqual(['Work[p]', 'Play[b a]'])
    })

    it('puts a folder made for a project where that project was', () => {
      const a = add('a')
      add('b')
      tables.railFolders.create('Work', { holding: { kind: 'project', id: a } })
      expect(rail()).toEqual(['p', 'Work[a]', 'b'])
      // Made for a project that is already filed, it takes the project's place inside that folder.
      tables.railFolders.create('Other', { holding: { kind: 'project', id: a } })
      expect(rail()).toEqual(['p', 'Work[Other[a]]', 'b'])
      // A spot that names nothing is a plain new folder, last in the rail.
      tables.railFolders.create('Lost', { holding: { kind: 'project', id: 'gone' } })
      tables.railFolders.create('Nowhere', { parentId: 'gone' })
      expect(rail()).toEqual(['p', 'Work[Other[a]]', 'b', 'Lost[]', 'Nowhere[]'])
    })

    it('nests folders: one inside another, moved in and out, and never inside itself', () => {
      const a = add('a')
      const b = add('b')
      const work = tables.railFolders.create('Work').id
      const client = tables.railFolders.create('Client', { parentId: work })
      expect(client).toMatchObject({ projectId: null, parentId: work, items: [] })
      expect(rail()).toEqual(['p', 'a', 'b', 'Work[Client[]]'])

      // A project goes into a nested folder like any other, and before a row of it.
      tables.railFolders.placeProject(a, client.id, null)
      tables.railFolders.placeProject(b, client.id, a)
      tables.railFolders.placeProject(p, work, client.id)
      expect(rail()).toEqual(['Work[p Client[b a]]'])

      // A new folder goes last in its parent, and opens a parent that was shut.
      tables.railFolders.setCollapsed(work, true)
      const later = tables.railFolders.create('Later', { parentId: work }).id
      expect(tables.railFolders.get(work)!.collapsed).toBe(false)
      expect(rail()).toEqual(['Work[p Client[b a] Later[]]'])

      // Folders move between lists: into another, out to the top, and to a place among the rows there.
      tables.railFolders.placeFolder(later, client.id, a)
      expect(rail()).toEqual(['Work[p Client[b Later[] a]]'])
      expect(tables.railFolders.get(later)!.parentId).toBe(client.id)
      tables.railFolders.placeFolder(client.id, null, work)
      expect(rail()).toEqual(['Client[b Later[] a]', 'Work[p]'])

      // Never inside itself, at any depth; a parent that is not there changes nothing.
      tables.railFolders.placeFolder(client.id, client.id, null)
      tables.railFolders.placeFolder(client.id, later, null)
      tables.railFolders.placeFolder(client.id, 'missing', null)
      expect(rail()).toEqual(['Client[b Later[] a]', 'Work[p]'])

      // Deleting a folder leaves everything in it, folders included, where it was.
      tables.railFolders.placeFolder(client.id, work, null)
      expect(rail()).toEqual(['Work[p Client[b Later[] a]]'])
      tables.railFolders.remove(client.id)
      expect(rail()).toEqual(['Work[p b Later[] a]'])
      expect(tables.railFolders.get(later)!.parentId).toBe(work)

      closeDb()
      initDb(dir)
      expect(rail()).toEqual(['Work[p b Later[] a]'])
    })

    it('survives folders whose parents loop: each is still listed once', () => {
      const one = tables.railFolders.create('One').id
      const two = tables.railFolders.create('Two', { parentId: one }).id
      tables.railFolders.placeProject(p, two, null)
      // No write here makes this; it is what a damaged file could hold.
      getDb().prepare('UPDATE rail_folders SET parent_id = ? WHERE id = ?').run(two, one)
      // Which of the two ends up outermost is not promised; that the read
      // ends, and lists each folder and the project once, is.
      const drawn = rail().join(' ')
      expect(['One[Two[p]]', 'Two[One[] p]']).toContain(drawn)
      expect(tables.railFolders.list().filter((f) => f.parentId === null)).toHaveLength(1)
      // And the next writes put the rows right.
      tables.railFolders.placeFolder(one, null, null)
      tables.railFolders.placeFolder(two, null, one)
      expect(rail()).toEqual(['Two[p]', 'One[]'])
    })

    it('deleting a folder only ungroups: its projects take its place, and nothing else goes', () => {
      const w = tables.worktrees.create({ repoId, kind: 'root', name: 'main', path: 'C:/p', branch: 'main' })
      const a = add('a')
      const b = add('b')
      const folder = tables.railFolders.create('Work')
      tables.railFolders.placeProject(b, folder.id, null)
      tables.railFolders.placeProject(p, folder.id, null)
      tables.railFolders.placeFolder(folder.id, null, null)
      tables.railFolders.placeProject(a, null, null)
      expect(rail()).toEqual(['Work[b p]', 'a'])
      const rowsBefore = [p, a, b].map(projectRow)
      const reposBefore = getDb().prepare('SELECT * FROM repos ORDER BY id').all()

      tables.railFolders.remove(folder.id)
      expect(tables.railFolders.list()).toEqual([])
      expect(rail()).toEqual(['b', 'p', 'a'])
      expect([p, a, b].map(projectRow)).toEqual(rowsBefore)
      expect(getDb().prepare('SELECT * FROM repos ORDER BY id').all()).toEqual(reposBefore)
      expect(tables.worktrees.get(w.id)).toBeDefined()
    })

    it("removing a project's last repo takes the project out of the rail and leaves its folder", () => {
      const folder = tables.railFolders.create('Work')
      tables.railFolders.placeProject(p, folder.id, null)
      tables.repos.remove(repoId)
      expect(tables.projects.get(p)).toBeUndefined()
      expect(tables.railFolders.list()).toEqual([{ ...folder, items: [] }])
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM rail_positions').get()).toEqual({ n: 0 })
    })

    it('remembers names, collapsed folders and the whole arrangement across a reopen', () => {
      const a = add('a')
      const b = add('b')
      const folder = tables.railFolders.create('Work')
      tables.railFolders.rename(folder.id, 'Clients')
      tables.railFolders.setCollapsed(folder.id, true)
      tables.railFolders.placeProject(b, folder.id, null)
      tables.railFolders.placeProject(a, folder.id, b)
      tables.railFolders.placeFolder(folder.id, null, null)
      closeDb()
      initDb(dir)
      expect(tables.railFolders.list()).toEqual([
        {
          id: folder.id,
          name: 'Clients',
          collapsed: true,
          projectId: null,
          parentId: null,
          items: [
            { kind: 'project', id: a },
            { kind: 'project', id: b }
          ]
        }
      ])
      expect(rail()).toEqual(['p', 'Clients[a b]'])
    })

    it('keeps folders and the rail order to their own workspace', () => {
      const here = tables.railFolders.create('Here')
      const other = tables.workspaces.create('Other')
      const foreign = tables.repos.create({ name: 'x', repoPath: 'C:/x', workspaceId: other.id }).projectId

      // A project from another workspace cannot be placed in this one's rail,
      // and a move to a folder that is not there leaves a project where it was.
      tables.railFolders.placeProject(foreign, here.id, null)
      tables.railFolders.placeProject(foreign, null, null)
      tables.railFolders.placeProject(p, here.id, null)
      tables.railFolders.placeProject(p, 'missing', null)
      expect(rail()).toEqual(['Here[p]'])

      const home = tables.workspaces.list().find((w) => w.id !== other.id)!.id
      tables.setActiveWorkspaceId(other.id)
      expect(rail()).toEqual(['x'])
      // Nor can that workspace move this one's folder.
      tables.railFolders.placeFolder(here.id, null, foreign)
      tables.setActiveWorkspaceId(home)
      expect(rail()).toEqual(['Here[p]'])

      // Deleting a workspace takes its folders and projects with it.
      tables.workspaces.remove(other.id)
      expect(tables.railFolders.list().map((f) => f.name)).toEqual(['Here'])
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(foreign)).toEqual({ n: 0 })
    })
  })

  describe('projects', () => {
    /** Add a repo at C:/src/<path> in a project of its own; returns the repo. */
    const add = (name: string, path = `C:/src/${name}`): Repo => tables.repos.create({ name, repoPath: path })
    const project = (pid: string): Project => tables.projects.get(pid)!
    const gone = (pid: string): boolean => tables.projects.get(pid) === undefined

    it('gives a new repo a project of its own, or joins the one it is given', () => {
      const a = add('a')
      expect(project(a.projectId)).toMatchObject({ name: 'a', rootPath: 'C:/src/a', homeRepoId: null, repoIds: [a.id] })
      const b = tables.repos.create({ name: 'b', repoPath: 'C:/src/b', projectId: a.projectId })
      expect(b.projectId).toBe(a.projectId)
      // Joining a flat project promotes it, as a move would.
      expect(project(a.projectId)).toMatchObject({ name: 'src', rootPath: 'C:/src', repoIds: [a.id, b.id] })
      expect(tables.getAppState().projects.map((x) => x.id)).toContain(a.projectId)
    })

    it('promotes a flat project that gains a second repo: re-rooted and renamed after the shared folder', () => {
      const api = add('api', 'C:/Work/Acme/api')
      const web = add('web', 'c:/work/acme/web')
      tables.projects.addRepo(api.projectId, web.id, null)
      expect(project(api.projectId)).toMatchObject({
        name: 'Acme',
        rootPath: 'C:/Work/Acme',
        homeRepoId: null,
        repoIds: [api.id, web.id]
      })
      // The project web left was its alone, so it is gone, rail row and all.
      expect(gone(web.projectId)).toBe(true)
      expect(tables.repos.get(web.id)!.projectId).toBe(api.projectId)
      expect(railByName()).toEqual(['p', 'Acme'])
    })

    it('keeps a name the user gave, and falls back to the first repo parent across drives', () => {
      const a = add('a', 'C:/one/a')
      const b = add('b', 'D:/two/b')
      tables.projects.rename(a.projectId, 'Mine')
      tables.projects.addRepo(a.projectId, b.id, null)
      expect(project(a.projectId)).toMatchObject({ name: 'Mine', rootPath: 'C:/one' })
    })

    it('orders repos inside a project by hand, and only promotes on the first join', () => {
      const a = add('a')
      const b = add('b')
      const c = add('c')
      tables.projects.addRepo(a.projectId, b.id, null)
      tables.projects.rename(a.projectId, 'Group')
      tables.projects.setRoot(a.projectId, 'C:/elsewhere')
      tables.projects.addRepo(a.projectId, c.id, a.id)
      expect(project(a.projectId)).toMatchObject({ name: 'Group', rootPath: 'C:/elsewhere', repoIds: [c.id, a.id, b.id] })
      // Same project: a reorder, nothing else.
      tables.projects.addRepo(a.projectId, c.id, null)
      expect(project(a.projectId).repoIds).toEqual([a.id, b.id, c.id])
      tables.projects.addRepo(a.projectId, b.id, a.id)
      expect(project(a.projectId).repoIds).toEqual([b.id, a.id, c.id])
      tables.projects.addRepo(a.projectId, b.id, b.id)
      expect(project(a.projectId).repoIds).toEqual([b.id, a.id, c.id])
    })

    it('demotes a group left with one repo and no home, and deletes one left empty', () => {
      const a = add('a')
      const b = add('b')
      const c = add('c')
      tables.projects.addRepo(a.projectId, b.id, null)
      expect(project(a.projectId).name).toBe('src')
      // b moves on to c's (flat) project: a's group is down to a alone.
      tables.projects.addRepo(c.projectId, b.id, null)
      expect(project(a.projectId)).toMatchObject({ name: 'a', rootPath: 'C:/src/a', repoIds: [a.id] })
      expect(project(c.projectId)).toMatchObject({ name: 'src', repoIds: [c.id, b.id] })
      // Removing a repo demotes too.
      tables.repos.remove(c.id)
      expect(project(c.projectId)).toMatchObject({ name: 'b', rootPath: 'C:/src/b', repoIds: [b.id] })
      tables.repos.remove(b.id)
      expect(gone(c.projectId)).toBe(true)
    })

    it('takes a home only from its own repos, clears it when the home leaves, and SET NULLs it on removal', () => {
      const a = add('a')
      const b = add('b')
      const c = add('c')
      tables.projects.addRepo(a.projectId, b.id, null)
      tables.projects.addRepo(a.projectId, c.id, null)
      expect(() => tables.projects.setHome(a.projectId, repoId)).toThrow(/not in project/)
      tables.projects.setHome(a.projectId, b.id)
      expect(project(a.projectId).homeRepoId).toBe(b.id)

      // Moving the home out clears it; a project with a home is not flat, so no promote/demote on it.
      tables.projects.setHome(a.projectId, c.id)
      tables.projects.detachRepo(c.id, null, null)
      expect(project(a.projectId)).toMatchObject({ homeRepoId: null, name: 'src', repoIds: [a.id, b.id] })

      // The home's removal goes through the FK: ON DELETE SET NULL.
      tables.projects.addRepo(a.projectId, c.id, null)
      tables.projects.setHome(a.projectId, c.id)
      tables.repos.remove(c.id)
      expect(project(a.projectId).homeRepoId).toBeNull()
      expect(project(a.projectId).repoIds).toEqual([a.id, b.id])
    })

    it('a home keeps a one-repo project from being flat until it is cleared', () => {
      const a = add('a')
      const b = add('b')
      tables.projects.addRepo(a.projectId, b.id, null)
      tables.projects.setHome(a.projectId, a.id)
      tables.repos.remove(b.id)
      // One repo but a home: still a group, still named and rooted as one.
      expect(project(a.projectId)).toMatchObject({ name: 'src', rootPath: 'C:/src', homeRepoId: a.id })
      tables.projects.setHome(a.projectId, null)
      expect(project(a.projectId)).toMatchObject({ name: 'a', rootPath: 'C:/src/a', homeRepoId: null })
    })

    it('detaches a repo into a project of its own, placed in the rail', () => {
      const a = add('a')
      const b = add('b')
      const c = add('c')
      tables.projects.addRepo(a.projectId, b.id, null)
      tables.projects.addRepo(a.projectId, c.id, null)
      const folder = tables.railFolders.create('Work')
      tables.railFolders.placeProject(a.projectId, folder.id, null)
      expect(railByName()).toEqual(['p', 'Work[src]'])

      const detached = tables.projects.detachRepo(b.id, folder.id, a.projectId)!
      expect(detached).toMatchObject({ name: 'b', rootPath: 'C:/src/b', homeRepoId: null, repoIds: [b.id] })
      expect(tables.repos.get(b.id)!.projectId).toBe(detached.id)
      expect(railByName()).toEqual(['p', 'Work[b src]'])
      expect(project(a.projectId).repoIds).toEqual([a.id, c.id])

      // Detaching a repo already alone in a flat project only places that project.
      expect(tables.projects.detachRepo(b.id, null, null)!.id).toBe(detached.id)
      expect(railByName()).toEqual(['p', 'Work[src]', 'b'])
    })

    it('ungroups in place: every repo its own flat project where the group was', () => {
      const a = add('a')
      const b = add('b')
      const c = add('c')
      tables.projects.addRepo(a.projectId, b.id, null)
      tables.projects.addRepo(a.projectId, c.id, null)
      tables.projects.setHome(a.projectId, b.id)
      tables.railFolders.placeProject(a.projectId, null, null)
      expect(railByName()).toEqual(['p', 'src'])

      tables.projects.ungroup(a.projectId)
      expect(railByName()).toEqual(['p', 'a', 'b', 'c'])
      for (const r of [a, b, c]) {
        const own = project(tables.repos.get(r.id)!.projectId)
        expect(own).toMatchObject({ name: r.name, rootPath: r.repoPath, homeRepoId: null, repoIds: [r.id] })
      }
      // The last repo kept the group's project.
      expect(tables.repos.get(c.id)!.projectId).toBe(a.projectId)
    })

    it('removing a project cascades to its repos, their worktrees and tasks, and its rail row', () => {
      const a = add('a')
      const b = add('b')
      tables.projects.addRepo(a.projectId, b.id, null)
      tables.projects.setHome(a.projectId, a.id)
      const w = tables.worktrees.create({ repoId: b.id, kind: 'root', name: 'main', path: 'C:/src/b', branch: 'main' })
      const t = tables.tasks.create({ projectId: a.projectId, repoId: a.id, title: 't', createdBy: 'user' })
      tables.railFolders.placeProject(a.projectId, null, null)

      tables.projects.remove(a.projectId)
      expect(gone(a.projectId)).toBe(true)
      expect(tables.repos.get(a.id)).toBeUndefined()
      expect(tables.repos.get(b.id)).toBeUndefined()
      expect(tables.worktrees.get(w.id)).toBeUndefined()
      expect(tables.tasks.get(t.id)).toBeUndefined()
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM rail_positions WHERE project_id = ?').get(a.projectId)).toEqual({
        n: 0
      })
      expect(railByName()).toEqual(['p'])
    })

    describe('folders among a project\'s repos', () => {
      /** A group "src" of a (the home), b, c and d, in that order. */
      const group = (): { pid: string; a: Repo; b: Repo; c: Repo; d: Repo } => {
        const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => add(name))
        for (const r of [b, c, d]) tables.projects.addRepo(a.projectId, r.id, null)
        tables.projects.setHome(a.projectId, a.id)
        return { pid: a.projectId, a, b, c, d }
      }
      const names = (pid: string): string[] =>
        project(pid).repoIds.map((rid) => tables.repos.get(rid)!.name)

      it('files repos in a folder of the project, and keeps the flat order reading top to bottom', () => {
        const { pid, a, b, c, d } = group()
        const before = [b, c, d].map((r) => ({ ...tables.repos.get(r.id)! }))
        const apps = tables.railFolders.create('Apps', { projectId: pid })
        expect(apps).toMatchObject({ projectId: pid, parentId: null, items: [] })
        // It is one of the project's rows, not one of the rail's.
        expect(railByName()).toEqual(['p', 'src'])
        expect(membersByName(pid)).toEqual(['a', 'b', 'c', 'd', 'Apps[]'])

        tables.projects.addRepo(pid, d.id, null, apps.id)
        tables.projects.addRepo(pid, b.id, d.id, apps.id)
        expect(membersByName(pid)).toEqual(['a', 'c', 'Apps[b d]'])
        // The one flat order follows the arrangement; nothing else about a repo moved.
        expect(names(pid)).toEqual(['a', 'c', 'b', 'd'])
        expect([b, c, d].map((r) => tables.repos.get(r.id))).toEqual(before)
        expect(project(pid)).toMatchObject({ name: 'src', rootPath: 'C:/src', homeRepoId: a.id })

        // Back out to a place among the rows at the top, a folder being one of them.
        tables.projects.addRepo(pid, d.id, apps.id)
        expect(membersByName(pid)).toEqual(['a', 'c', 'd', 'Apps[b]'])
        tables.projects.addRepo(pid, b.id, null)
        expect(membersByName(pid)).toEqual(['a', 'c', 'd', 'Apps[]', 'b'])
        expect(names(pid)).toEqual(['a', 'c', 'd', 'b'])
      })

      it('makes a folder for a repo where the repo was, and nests and moves folders within the project', () => {
        const { pid, b, c, d } = group()
        const apps = tables.railFolders.create('Apps', { holding: { kind: 'repo', id: c.id } })
        expect(apps.projectId).toBe(pid)
        expect(membersByName(pid)).toEqual(['a', 'b', 'Apps[c]', 'd'])

        const web = tables.railFolders.create('Web', { parentId: apps.id })
        expect(web).toMatchObject({ projectId: pid, parentId: apps.id })
        tables.projects.addRepo(pid, d.id, null, web.id)
        expect(membersByName(pid)).toEqual(['a', 'b', 'Apps[c Web[d]]'])
        expect(names(pid)).toEqual(['a', 'b', 'c', 'd'])

        tables.railFolders.placeFolder(web.id, null, b.id)
        expect(membersByName(pid)).toEqual(['a', 'Web[d]', 'b', 'Apps[c]'])
        expect(names(pid)).toEqual(['a', 'd', 'b', 'c'])
        tables.railFolders.placeFolder(apps.id, web.id, null)
        expect(membersByName(pid)).toEqual(['a', 'Web[d Apps[c]]', 'b'])

        // Deleting one leaves its rows where it was.
        tables.railFolders.remove(web.id)
        expect(membersByName(pid)).toEqual(['a', 'd', 'Apps[c]', 'b'])
        expect(names(pid)).toEqual(['a', 'd', 'c', 'b'])

        closeDb()
        initDb(dir)
        expect(membersByName(pid)).toEqual(['a', 'd', 'Apps[c]', 'b'])
      })

      it('keeps the two kinds of folder, and each project\'s folders, apart', () => {
        const { pid, b } = group()
        const other = add('x', 'C:/other/x')
        const y = add('y', 'C:/other/y')
        tables.projects.addRepo(other.projectId, y.id, null)
        const apps = tables.railFolders.create('Apps', { projectId: pid })
        const theirs = tables.railFolders.create('Theirs', { projectId: other.projectId })
        const work = tables.railFolders.create('Work')

        // A project is not filed in a folder of repos, nor a repo in a folder of projects or of another project.
        tables.railFolders.placeProject(other.projectId, apps.id, null)
        tables.projects.addRepo(pid, b.id, null, work.id)
        tables.projects.addRepo(pid, b.id, null, theirs.id)
        // Nor does a folder cross over.
        tables.railFolders.placeFolder(apps.id, work.id, null)
        tables.railFolders.placeFolder(apps.id, theirs.id, null)
        tables.railFolders.placeFolder(work.id, apps.id, null)
        expect(railByName()).toEqual(['p', 'src', 'other', 'Work[]'])
        expect(membersByName(pid)).toEqual(['a', 'b', 'c', 'd', 'Apps[]'])
        expect(membersByName(other.projectId)).toEqual(['x', 'y', 'Theirs[]'])
      })

      it('moves a repo into another project\'s folder, and settles the project it left', () => {
        const { pid, b } = group()
        const x = add('x', 'C:/other/x')
        const y = add('y', 'C:/other/y')
        tables.projects.addRepo(x.projectId, y.id, null)
        const kept = tables.railFolders.create('Kept', { projectId: x.projectId })
        tables.projects.addRepo(x.projectId, y.id, null, kept.id)
        const apps = tables.railFolders.create('Apps', { projectId: pid })

        tables.projects.addRepo(pid, y.id, null, apps.id)
        expect(tables.repos.get(y.id)!.projectId).toBe(pid)
        expect(membersByName(pid)).toEqual(['a', 'b', 'c', 'd', 'Apps[y]'])
        // The project y left is a plain repo row again, and a plain row has no folders.
        expect(project(x.projectId)).toMatchObject({ name: 'x', repoIds: [x.id] })
        expect(tables.railFolders.get(kept.id)).toBeUndefined()

        // Taken out of its project altogether, the repo forgets the folder it was in.
        tables.projects.addRepo(pid, b.id, null, apps.id)
        tables.projects.detachRepo(b.id, null, null)
        expect(membersByName(pid)).toEqual(['a', 'c', 'd', 'Apps[y]'])
        expect(getDb().prepare('SELECT folder_id FROM rail_repo_positions WHERE repo_id = ?').get(b.id)).toEqual({
          folder_id: null
        })
      })

      it('lists a repo added later after the arranged ones, and goes with its project', () => {
        const { pid } = group()
        const apps = tables.railFolders.create('Apps', { projectId: pid })
        const late = tables.repos.create({ name: 'late', repoPath: 'C:/src/late', projectId: pid })
        expect(membersByName(pid)).toEqual(['a', 'b', 'c', 'd', 'Apps[]', 'late'])
        expect(names(pid)).toEqual(['a', 'b', 'c', 'd', 'late'])

        tables.projects.addRepo(pid, late.id, null, apps.id)
        tables.projects.remove(pid)
        expect(tables.railFolders.list()).toEqual([])
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM rail_repo_positions').get()).toEqual({ n: 0 })
      })
    })

    it('never mixes workspaces', () => {
      const other = tables.workspaces.create('Other')
      const x = tables.repos.create({ name: 'x', repoPath: 'C:/x', workspaceId: other.id })
      const pid = tables.repos.get(repoId)!.projectId
      tables.projects.addRepo(pid, x.id, null)
      expect(tables.repos.get(x.id)!.projectId).toBe(x.projectId)
      expect(() => tables.repos.create({ name: 'y', repoPath: 'C:/y', projectId: x.projectId })).toThrow()
      expect(tables.projects.list().map((p) => p.id)).toEqual([pid])
      expect(tables.projects.list(other.id).map((p) => p.id)).toEqual([x.projectId])
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

describe('workspace export and import', () => {
  beforeEach(() => {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
  })

  it('round-trips the grouping: names, roots, homes and member order', () => {
    const ws = tables.workspaces.list()[0].id
    const api = tables.repos.create({ name: 'api', repoPath: 'C:/src/acme/api' })
    const web = tables.repos.create({ name: 'web', repoPath: 'C:/src/acme/web' })
    const docs = tables.repos.create({ name: 'docs', repoPath: 'C:/docs' })
    tables.projects.addRepo(api.projectId, web.id, api.id)
    tables.projects.setHome(api.projectId, api.id)
    const file = join(dir, 'export.yaml')
    exportWorkspaceToFile(ws, file)

    const imported = importWorkspaceFromFile(file)
    // Every id was taken (same DB), so the copy has fresh ones; map back by name.
    const repos = tables.repos.list(imported.id)
    const byName = new Map(repos.map((r) => [r.name, r]))
    const projects = tables.projects.list(imported.id)
    expect(projects.map((p) => [p.name, p.rootPath, p.repoIds.map((rid) => repos.find((r) => r.id === rid)!.name)])).toEqual([
      ['acme', 'C:/src/acme', ['web', 'api']],
      ['docs', 'C:/docs', ['docs']]
    ])
    expect(projects[0].homeRepoId).toBe(byName.get('api')!.id)
    for (const r of repos) expect(projects.some((p) => p.id === r.projectId && p.repoIds.includes(r.id))).toBe(true)
    expect(docs.projectId).not.toBe(projects[1].id)
  })

  it('gives every repo a project of its own from a file without projects', () => {
    const file = join(dir, 'old.yaml')
    writeWorkspaceYaml(file, {
      version: 1,
      id: 'imported-ws',
      name: 'Old',
      repos: [
        { id: 'ra', name: 'a', path: 'C:/a' },
        { id: 'rb', name: 'b', path: 'C:/b' }
      ]
    })
    const imported = importWorkspaceFromFile(file)
    expect(tables.projects.list(imported.id).map((p) => [p.name, p.rootPath, p.repoIds])).toEqual([
      ['a', 'C:/a', ['ra']],
      ['b', 'C:/b', ['rb']]
    ])
  })
})

describe('moving tasks from repos to projects', () => {
  /** `tasks` as PRAGMA reports it: column name → NOT NULL. */
  const taskShape = (): Record<string, number> =>
    Object.fromEntries(
      (getDb().prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string; notnull: number }>).map((c) => [
        c.name,
        c.notnull
      ])
    )
  const taskIndexes = (): string[] =>
    (
      getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'").all() as Array<{
        name: string
      }>
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'))
      .sort()
  const TASK_INDEXES = ['idx_tasks_project', 'idx_tasks_repo', 'idx_tasks_seq']
  /** Every stored column but project_id, so a migrated row can be compared with its original. */
  const rowsWithoutProject = (): Record<string, unknown>[] =>
    (getDb().prepare('SELECT * FROM tasks ORDER BY seq').all() as Record<string, unknown>[]).map((r) => {
      const rest = { ...r }
      delete rest.project_id
      return rest
    })
  const foreignKeys = (): Array<{ from: string; table: string; on_delete: string }> =>
    getDb().prepare('PRAGMA foreign_key_list(tasks)').all() as Array<{ from: string; table: string; on_delete: string }>

  /**
   * Put `tasks` (and, unless `folderSessions`, `worktrees`) back the way a
   * database from after projects but before this change had them: tasks owned
   * by a repo, and (before folder sessions) worktrees with no project_id.
   */
  function downgrade(folderSessions: boolean): void {
    const d = getDb()
    d.pragma('foreign_keys = OFF')
    d.exec(`
      CREATE TABLE tasks_old (
        id TEXT PRIMARY KEY, seq INTEGER, repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'todo', worktree_id TEXT, created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
      );
      INSERT INTO tasks_old SELECT id, seq, repo_id, title, description, tags, status, worktree_id, created_by,
        created_at, updated_at, archived_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_old RENAME TO tasks;
      CREATE INDEX idx_tasks_repo ON tasks(repo_id);
      CREATE UNIQUE INDEX idx_tasks_seq ON tasks(seq);
    `)
    if (!folderSessions) {
      d.exec(`
        CREATE TABLE worktrees_old (
          id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle', task_id TEXT, split_direction TEXT NOT NULL DEFAULT 'row',
          layout TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
        );
        INSERT INTO worktrees_old SELECT id, repo_id, kind, name, path, branch, status, task_id, split_direction,
          layout, created_at FROM worktrees;
        DROP TABLE worktrees;
        ALTER TABLE worktrees_old RENAME TO worktrees;
        CREATE INDEX idx_worktrees_repo ON worktrees(repo_id);
      `)
    }
    d.pragma('foreign_keys = ON')
  }

  /** A grouped project (api, web; home api) and a flat one (docs), with tasks of every kind. */
  function seedGrouped() {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
    const api = tables.repos.create({ name: 'api', repoPath: 'C:/acme/api' })
    const web = tables.repos.create({ name: 'web', repoPath: 'C:/acme/web' })
    const docs = tables.repos.create({ name: 'docs', repoPath: 'C:/docs' })
    tables.projects.addRepo(api.projectId, web.id, null)
    tables.projects.setHome(api.projectId, api.id)
    const wt = tables.worktrees.create({ repoId: web.id, kind: 'linked', name: 'feat', path: 'C:/acme/wt', branch: 'feat' })
    const t1 = tables.tasks.create({ projectId: api.projectId, repoId: api.id, title: 'one', tags: ['x'], createdBy: 'agent' })
    const t2 = tables.tasks.create({ projectId: api.projectId, repoId: web.id, title: 'two', description: 'd', createdBy: 'user' })
    const t3 = tables.tasks.create({ projectId: docs.projectId, repoId: docs.id, title: 'three', createdBy: 'user' })
    tables.worktrees.linkTask(wt.id, t2.id)
    tables.tasks.update(t2.id, { status: 'in_progress' })
    tables.tasks.archive(t3.id)
    return { api, web, docs, wt, t1, t2, t3 }
  }

  it('makes a fresh database with the shape already: a required project, an optional repo', () => {
    expect(taskShape()).toMatchObject({ project_id: 1, repo_id: 0 })
    expect(taskIndexes()).toEqual(TASK_INDEXES)
    expect(foreignKeys().map((k) => [k.from, k.table, k.on_delete]).sort()).toEqual([
      ['project_id', 'projects', 'CASCADE'],
      ['repo_id', 'repos', 'SET NULL']
    ])
  })

  it("moves a pre-revamp database's tasks into the project their repo got", () => {
    closeDb()
    writeLegacyDb(join(dir, 'orbital.db'))
    initDb(dir)
    expect(taskShape()).toMatchObject({ project_id: 1, repo_id: 0 })
    const project = (getDb().prepare("SELECT project_id FROM repos WHERE id = 'ws1'").get() as { project_id: string }).project_id
    expect(getDb().prepare('SELECT id, seq, project_id, repo_id, worktree_id FROM tasks ORDER BY seq').all()).toEqual([
      { id: 't1', seq: 1, project_id: project, repo_id: 'ws1', worktree_id: 'f2' },
      { id: 't2', seq: 2, project_id: project, repo_id: 'ws1', worktree_id: null }
    ])
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })

  it.each([
    ['from v1.45', true],
    ['from after the rename but before projects', false]
  ])('moves the tasks of a database %s, every column as it was', (_label, v145) => {
    closeDb()
    writePreProjectsDb(v145)
    const raw = new Database(join(dir, 'orbital.db'))
    const fk = v145 ? 'project_id' : 'repo_id'
    raw.exec(`
      INSERT INTO worktrees (id, ${fk}, kind, name, path, branch, created_at)
        VALUES ('w2', 'r-web', 'linked', 'feat', 'C:/src/acme/wt', 'feat', 2);
      INSERT INTO tasks (id, seq, ${fk}, title, description, tags, status, worktree_id, created_by, created_at, updated_at, archived_at)
        VALUES ('t2', 7, 'r-web', 'b', 'desc', '["ui"]', 'done', 'w2', 'agent', 2, 3, 4);
    `)
    raw.close()
    initDb(dir)
    tables.setActiveWorkspaceId('ws')
    expect(taskShape()).toMatchObject({ project_id: 1, repo_id: 0 })
    expect(taskIndexes()).toEqual(TASK_INDEXES)
    const t2 = getDb().prepare("SELECT * FROM tasks WHERE id = 't2'").get()
    expect(t2).toEqual({
      id: 't2',
      seq: 7,
      project_id: tables.repos.get('r-web')!.projectId,
      repo_id: 'r-web',
      title: 'b',
      description: 'desc',
      tags: '["ui"]',
      status: 'done',
      worktree_id: 'w2',
      created_by: 'agent',
      created_at: 2,
      updated_at: 3,
      archived_at: 4
    })
    expect(tables.tasks.get('t1')).toMatchObject({ projectId: tables.repos.get('r-api')!.projectId, repoId: 'r-api' })
    expect(getDb().pragma('foreign_key_check')).toEqual([])
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it.each([
    ['from after projects, before folder sessions', false],
    ['from after folder sessions', true]
  ])('rebuilds the tasks of a database %s, keeping every row byte for byte', (_label, folderSessions) => {
    const { api, web, docs, wt, t1, t2, t3 } = seedGrouped()
    const before = rowsWithoutProject()
    downgrade(folderSessions)
    expect(taskShape()).not.toHaveProperty('project_id')
    closeDb()
    initDb(dir)
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)

    expect(taskShape()).toMatchObject({ project_id: 1, repo_id: 0 })
    expect(taskIndexes()).toEqual(TASK_INDEXES)
    expect(rowsWithoutProject()).toEqual(before)
    expect(tables.tasks.get(t1.id)).toMatchObject({ projectId: api.projectId, repoId: api.id, tags: ['x'], createdBy: 'agent' })
    expect(tables.tasks.get(t2.id)).toMatchObject({ projectId: api.projectId, repoId: web.id, worktreeId: wt.id })
    expect(tables.tasks.get(t3.id)).toMatchObject({ projectId: docs.projectId, archivedAt: expect.any(Number) })
    expect(tables.worktrees.get(wt.id)).toMatchObject({ taskId: t2.id, projectId: api.projectId })
    // Numbering carries on after the migrated ones.
    expect(tables.tasks.create({ projectId: api.projectId, title: 'next', createdBy: 'user' }).seq).toBe(t3.seq + 1)
    expect(getDb().pragma('foreign_key_check')).toEqual([])
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('drops a task whose repo is already gone, which no project can take', () => {
    const { t1 } = seedGrouped()
    downgrade(true)
    getDb().pragma('foreign_keys = OFF')
    getDb().prepare('UPDATE tasks SET repo_id = ? WHERE id = ?').run('vanished', t1.id)
    getDb().pragma('foreign_keys = ON')
    closeDb()
    initDb(dir)
    expect(tables.tasks.get(t1.id)).toBeUndefined()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 2 })
  })

  it('is idempotent: a second boot leaves the rebuilt table and its rows alone', () => {
    seedGrouped()
    downgrade(true)
    closeDb()
    initDb(dir)
    const snapshot = (): unknown => ({
      sql: getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get(),
      indexes: taskIndexes(),
      rows: getDb().prepare('SELECT * FROM tasks ORDER BY id').all()
    })
    const first = snapshot()
    closeDb()
    initDb(dir)
    expect(snapshot()).toEqual(first)
  })

  it('heals a tagged task left in a project its repo has left, on the next boot', () => {
    const { docs, t1 } = seedGrouped()
    getDb().prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(docs.projectId, t1.id)
    closeDb()
    initDb(dir)
    expect(tables.tasks.get(t1.id)!.projectId).toBe(tables.repos.get(t1.repoId!)!.projectId)
  })
})

describe('tasks in projects', () => {
  beforeEach(() => {
    tables.setActiveWorkspaceId(tables.workspaces.list()[0].id)
  })

  /** Acme: api (home), web and cli; plus a flat `docs`. One task under each repo and one with none. */
  function acme() {
    const api = tables.repos.create({ name: 'api', repoPath: 'C:/acme/api' })
    const pid = api.projectId
    const web = tables.repos.create({ name: 'web', repoPath: 'C:/acme/web', projectId: pid })
    const cli = tables.repos.create({ name: 'cli', repoPath: 'C:/acme/cli', projectId: pid })
    tables.projects.setHome(pid, api.id)
    const docs = tables.repos.create({ name: 'docs', repoPath: 'C:/docs' })
    const task = (repoId: string | null, title: string) =>
      tables.tasks.create({ projectId: pid, repoId, title, createdBy: 'user' })
    return {
      pid,
      api,
      web,
      cli,
      docs,
      tApi: task(api.id, 'api work'),
      tWeb: task(web.id, 'web work'),
      tCli: task(cli.id, 'cli work'),
      tNone: task(null, 'spans')
    }
  }
  const projectOf = (tid: string): string | undefined => tables.tasks.get(tid)?.projectId

  it('files a task under one of its project repos or none, and refuses a repo of another project', () => {
    const { pid, docs, tNone, tApi } = acme()
    expect(tNone).toMatchObject({ projectId: pid, repoId: null })
    expect(() => tables.tasks.create({ projectId: pid, repoId: docs.id, title: 'x', createdBy: 'user' })).toThrow(
      /repo docs is not in this task's project/
    )
    expect(() => tables.tasks.update(tApi.id, { repoId: docs.id })).toThrow(/not in this task's project/)
    expect(tables.tasks.list().filter((t) => t.projectId === pid).map((t) => t.title).sort()).toEqual([
      'api work',
      'cli work',
      'spans',
      'web work'
    ])
  })

  it('retags and clears with a patch, and leaves the repo alone when the patch does not name it', () => {
    const { web, tApi } = acme()
    expect(tables.tasks.update(tApi.id, { repoId: web.id }).repoId).toBe(web.id)
    expect(tables.tasks.update(tApi.id, { title: 'renamed' }).repoId).toBe(web.id)
    expect(tables.tasks.update(tApi.id, { repoId: null }).repoId).toBeNull()
  })

  it('locks the repo of a task with a live worktree, and frees it when the worktree goes', () => {
    const { api, web, tApi } = acme()
    const wt = tables.worktrees.create({
      repoId: api.id,
      kind: 'linked',
      name: 'f',
      path: 'C:/acme/wt-f',
      branch: 'f',
      taskId: tApi.id
    })
    expect(() => tables.tasks.update(tApi.id, { repoId: web.id })).toThrow(
      `task #${tApi.seq} has a worktree in api; its repo follows that worktree`
    )
    expect(() => tables.tasks.update(tApi.id, { repoId: null })).toThrow(/has a worktree in api/)
    // Other edits, and naming the repo it already has, still go through.
    expect(tables.tasks.update(tApi.id, { repoId: api.id, status: 'ready_for_review' }).status).toBe('ready_for_review')
    tables.worktrees.remove(wt.id)
    expect(tables.tasks.update(tApi.id, { repoId: web.id }).repoId).toBe(web.id)
  })

  it('a repo moving to another project takes its tagged tasks; the untagged ones stay', () => {
    const { pid, web, docs, tWeb, tNone, tApi } = acme()
    tables.projects.addRepo(docs.projectId, web.id, null)
    expect(projectOf(tWeb.id)).toBe(docs.projectId)
    expect(tables.tasks.get(tWeb.id)!.repoId).toBe(web.id)
    expect(projectOf(tNone.id)).toBe(pid)
    expect(projectOf(tApi.id)).toBe(pid)
  })

  it('so does a repo detached into a project of its own, and every repo of an ungrouped project', () => {
    const { pid, api, cli, web, tCli, tWeb, tApi, tNone } = acme()
    const own = tables.projects.detachRepo(cli.id, null, null)!
    expect(projectOf(tCli.id)).toBe(own.id)
    tables.projects.ungroup(pid)
    expect(projectOf(tApi.id)).toBe(tables.repos.get(api.id)!.projectId)
    expect(projectOf(tApi.id)).not.toBe(pid)
    // The last repo keeps the group's project, and with it the untagged work.
    expect(tables.repos.get(web.id)!.projectId).toBe(pid)
    expect(projectOf(tWeb.id)).toBe(pid)
    expect(projectOf(tNone.id)).toBe(pid)
  })

  it("a repo's tasks follow it into a new project made from it", () => {
    const { web, tWeb } = acme()
    const made = tables.projects.create({ name: 'Web', rootPath: 'C:/acme/web', repoIds: [web.id] })
    expect(projectOf(tWeb.id)).toBe(made.id)
  })

  it('the untagged tasks of a project whose last repo moves away go with that repo, not down with the project', () => {
    const { docs } = acme()
    const solo = tables.repos.create({ name: 'solo', repoPath: 'C:/solo' })
    const loose = tables.tasks.create({ projectId: solo.projectId, title: 'loose', createdBy: 'user' })
    tables.projects.addRepo(docs.projectId, solo.id, null)
    expect(projectOf(loose.id)).toBe(docs.projectId)
  })

  it('removing a repo keeps its tasks in the project with the repo cleared and the worktree link dropped', () => {
    const { pid, web, tWeb } = acme()
    const wt = tables.worktrees.create({
      repoId: web.id,
      kind: 'linked',
      name: 'w',
      path: 'C:/acme/wt-w',
      branch: 'w',
      taskId: tWeb.id
    })
    tables.repos.remove(web.id)
    expect(tables.worktrees.get(wt.id)).toBeUndefined()
    expect(tables.tasks.get(tWeb.id)).toMatchObject({ projectId: pid, repoId: null, worktreeId: null })
  })

  it("removing a project's last repo, or the project, still deletes its tasks", () => {
    const { pid, tApi, tNone } = acme()
    const solo = tables.repos.create({ name: 'solo', repoPath: 'C:/solo' })
    const t = tables.tasks.create({ projectId: solo.projectId, title: 'x', createdBy: 'user' })
    tables.repos.remove(solo.id)
    expect(tables.tasks.get(t.id)).toBeUndefined()
    tables.projects.remove(pid)
    expect(tables.tasks.get(tApi.id)).toBeUndefined()
    expect(tables.tasks.get(tNone.id)).toBeUndefined()
  })

  it("lists only this workspace's tasks, untagged ones included", () => {
    const { tNone } = acme()
    expect(tables.tasks.list().some((t) => t.id === tNone.id)).toBe(true)
    const other = tables.workspaces.create('Other')
    tables.setActiveWorkspaceId(other.id)
    expect(tables.tasks.list()).toEqual([])
  })
})
