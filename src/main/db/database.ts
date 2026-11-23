import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { logger } from '../services/logger'
import { DEFAULT_ENV_SYNC_PATTERNS } from '@shared/types'
import { WORKSPACE_SETTING_KEYS } from '@shared/settings'

let db: Database.Database | null = null
let dbDir: string | null = null

/**
 * Point the store at the GLOBAL app-storage root. One DB serves every
 * workspace and every running instance (WAL + busy timeout make cross-process
 * access safe); instances differ only in which workspace they scope to and in
 * their Chromium profile dir. Must be called once, before the first getDb().
 */
export function initDb(dir: string): void {
  dbDir = dir
}

/**
 * Open (and migrate) the Orbital SQLite store — the single global DB under the
 * app-storage root, never in a project repo (PRD §12, §15).
 */
export function getDb(): Database.Database {
  if (db) return db
  if (!dbDir) throw new Error('database not initialized — call initDb(dir) first')
  mkdirSync(dbDir, { recursive: true })
  db = new Database(join(dbDir, 'orbital.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Several instances (one per workspace) share this DB — wait out, rather than
  // throw on, another process's in-flight write.
  db.pragma('busy_timeout = 5000')
  // With WAL, NORMAL still survives an app crash (the WAL is fsynced at
  // checkpoint); only a power loss can lose the last few commits. It halves
  // the fsyncs per hook event (two autocommits each), which matters on slow
  // or encrypted volumes.
  db.pragma('synchronous = NORMAL')
  migrate(db)
  return db
}

/**
 * Run `fn` as one IMMEDIATE write transaction. Every repository mutation that
 * issues more than one statement goes through here, so a crash between them
 * can no longer leave (say) a worktree without its first pane. IMMEDIATE takes
 * the write lock up front: with several instances on this DB, a transaction
 * that reads before it writes then waits its turn (busy_timeout) instead of
 * failing at once with SQLITE_BUSY_SNAPSHOT because another process wrote in
 * between. Nesting inside an outer transaction becomes a savepoint.
 */
export function writeTx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate()
}

/**
 * Run a DB write that nothing awaits and nothing can show — a terminal-exit
 * handler, the git watcher, boot-time resume. A throw there (SQLITE_BUSY once
 * busy_timeout runs out while another instance migrates, a checkpoint stall)
 * would otherwise surface as an uncaughtException, which exits the whole app.
 * Log it and carry on: the next event re-derives the same state. Returns
 * whether `fn` completed.
 */
export function safeWrite(label: string, fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (err) {
    const e = err as Error & { code?: string }
    logger.error(`db write failed: ${label}`, { code: e.code, message: e.message })
    console.error(`[db] ${label} failed:`, e.message)
    return false
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

function migrate(d: Database.Database): void {
  // Rename the pre-revamp schema (workspaces/flights) to the current vocabulary
  // (projects/worktrees) in place, preserving all data, BEFORE the CREATE
  // IF NOT EXISTS below (which would otherwise create empty new-named tables
  // alongside the populated legacy ones).
  renameLegacySchema(d)
  // Before any CREATE/ADD COLUMN below can introduce the new name alongside the
  // old one (which would strand the stored value in a column nothing reads).
  renameAgentColumn(d)
  // Then the Project→Repo rename, so everything below sees today's names.
  renameProjectsToRepos(d)

  d.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      settings       TEXT NOT NULL DEFAULT '{}',
      created_at     INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL DEFAULT 0
    );

    -- A project: a root folder and the repos that belong together under it.
    -- Every repo is in exactly one (repos.project_id). home_repo_id is one of
    -- its members or NULL; removing that repo clears it.
    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      root_path     TEXT NOT NULL,
      home_repo_id  TEXT REFERENCES repos(id) ON DELETE SET NULL,
      managed_block INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

    -- project_id is nullable here only because ALTER TABLE ADD COLUMN cannot
    -- add a NOT NULL reference to an existing table, and both shapes must end
    -- up alike. The repositories never write NULL, and groupReposIntoProjects
    -- heals any row that has one on every boot. project_position orders a
    -- project's repos by hand.
    CREATE TABLE IF NOT EXISTS repos (
      id                     TEXT PRIMARY KEY,
      workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name                   TEXT NOT NULL,
      repo_path              TEXT NOT NULL,
      env_sync_patterns      TEXT NOT NULL DEFAULT '[]',
      default_agent_id       TEXT NOT NULL DEFAULT 'claude',
      agent_exec_path        TEXT NOT NULL DEFAULT '',
      added_at               INTEGER NOT NULL,
      project_id             TEXT REFERENCES projects(id) ON DELETE CASCADE,
      project_position       INTEGER
    );

    -- Rail folders: how the rail is arranged, and nothing more. Kept in tables
    -- of their own so filing a project never touches its row.
    CREATE TABLE IF NOT EXISTS rail_folders (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      position     INTEGER NOT NULL,
      collapsed    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rail_folders_workspace ON rail_folders(workspace_id);

    -- Where a project sits in the rail: in which folder (NULL = the top level,
    -- where it shares rail_folders.position's order with the folders) and how
    -- far down. project_id is the key, so a project is in one place. A project
    -- with no row has never been arranged and is listed last. (Before projects
    -- existed this was keyed by repo_id; groupReposIntoProjects rebuilds it.)
    CREATE TABLE IF NOT EXISTS rail_positions (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      folder_id  TEXT REFERENCES rail_folders(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rail_positions_folder ON rail_positions(folder_id);

    CREATE TABLE IF NOT EXISTS worktrees (
      id              TEXT PRIMARY KEY,
      repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      path            TEXT NOT NULL,
      branch          TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'idle',
      task_id         TEXT,
      split_direction TEXT NOT NULL DEFAULT 'row',
      layout          TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_id);

    CREATE TABLE IF NOT EXISTS panes (
      id          TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      flex        REAL NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_panes_worktree ON panes(worktree_id);

    CREATE TABLE IF NOT EXISTS tabs (
      id          TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      pane_id     TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      status      TEXT,
      position    INTEGER NOT NULL,
      active      INTEGER NOT NULL DEFAULT 0,
      config      TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_tabs_worktree ON tabs(worktree_id);
    CREATE INDEX IF NOT EXISTS idx_tabs_pane ON tabs(pane_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT PRIMARY KEY,
      seq          INTEGER,
      repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      tags         TEXT NOT NULL DEFAULT '[]',
      status       TEXT NOT NULL DEFAULT 'todo',
      worktree_id  TEXT,
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      archived_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Migrations for databases created before a column existed.
  addColumnIfMissing(d, 'worktrees', 'layout', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(d, 'repos', 'default_agent_id', "TEXT NOT NULL DEFAULT 'claude'")
  addColumnIfMissing(d, 'repos', 'agent_exec_path', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(d, 'tasks', 'tags', "TEXT NOT NULL DEFAULT '[]'")
  addColumnIfMissing(d, 'tasks', 'seq', 'INTEGER')
  // '' (not NULL) so the column can be NOT NULL; mapTask reads it back as null:
  // tasks from before provenance tracking have no known creator.
  addColumnIfMissing(d, 'tasks', 'created_by', "TEXT NOT NULL DEFAULT ''")
  // NULL = active; a timestamp = archived (hidden from the default views).
  addColumnIfMissing(d, 'tasks', 'archived_at', 'INTEGER')
  backfillTaskSeqs(d)
  unlinkTasksFromMissingWorktrees(d)
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(seq)')
  const defaultWorkspaceId = ensureDefaultWorkspace(d)
  scopeReposToWorkspaces(d, defaultWorkspaceId)
  // Only after scoping — a pre-workspaces `repos` table lacks the column
  // these reference until the rebuild above has run.
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_repos_workspace ON repos(workspace_id);
    -- The same repo may be in several workspaces, but only once each.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_ws_path ON repos(workspace_id, repo_path);
  `)
  // Also only after scoping: its rebuild keeps the columns it lists, and these
  // two are not among them.
  addColumnIfMissing(d, 'repos', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE CASCADE')
  addColumnIfMissing(d, 'repos', 'project_position', 'INTEGER')
  d.exec('CREATE INDEX IF NOT EXISTS idx_repos_project ON repos(project_id)')
  groupReposIntoProjects(d)
  migrateEnvPatternsToSettings(d)
  migrateEnvPatternsRecursive(d)
}

/**
 * Guarantee at least one workspace exists (every repo row must belong to
 * one). The first-ever workspace is "Default", seeded with the workspace-scoped
 * slice of the legacy settings blob so custom env-sync patterns survive the
 * move into per-workspace settings. Returns the oldest workspace's id.
 */
function ensureDefaultWorkspace(d: Database.Database): string {
  const existing = d.prepare('SELECT id FROM workspaces ORDER BY created_at LIMIT 1').get() as
    | { id: string }
    | undefined
  if (existing) return existing.id
  let wsSettings: Record<string, unknown> = {}
  try {
    const row = d.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
    if (row) {
      const blob = JSON.parse(row.value) as Record<string, unknown>
      for (const key of WORKSPACE_SETTING_KEYS) {
        if (blob[key] !== undefined) wsSettings[key] = blob[key]
      }
    }
  } catch {
    wsSettings = {} // unparseable blob — the workspace starts from defaults
  }
  const id = randomUUID()
  const now = Date.now()
  d.prepare('INSERT INTO workspaces (id, name, settings, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'Default',
    JSON.stringify(wsSettings),
    now,
    now
  )
  return id
}

/**
 * Move a pre-workspaces `repos` table under workspace scoping: add the
 * `workspace_id` column (all existing repos join the default workspace) and
 * swap the global `repo_path` UNIQUE for a per-workspace one — the same repo
 * may be in several workspaces. SQLite can't alter constraints in
 * place, so this is the standard rebuild-and-rename, done once (keyed on the
 * column's absence). Child tables reference repos by name, so they survive
 * the rename untouched (FK enforcement is suspended for the swap).
 */
function scopeReposToWorkspaces(d: Database.Database, defaultWorkspaceId: string): void {
  const cols = (d.prepare('PRAGMA table_info(repos)').all() as Array<{ name: string }>).map((r) => r.name)
  if (cols.includes('workspace_id')) return
  d.pragma('foreign_keys = OFF')
  const tx = d.transaction(() => {
    d.exec(`
      CREATE TABLE repos_new (
        id                     TEXT PRIMARY KEY,
        workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                   TEXT NOT NULL,
        repo_path              TEXT NOT NULL,
        env_sync_patterns      TEXT NOT NULL DEFAULT '[]',
        default_agent_id       TEXT NOT NULL DEFAULT 'claude',
        agent_exec_path        TEXT NOT NULL DEFAULT '',
        added_at               INTEGER NOT NULL
      );
    `)
    d.prepare(
      `INSERT INTO repos_new (id, workspace_id, name, repo_path, env_sync_patterns, default_agent_id, agent_exec_path, added_at)
       SELECT id, ?, name, repo_path, env_sync_patterns, default_agent_id, agent_exec_path, added_at FROM repos`
    ).run(defaultWorkspaceId)
    d.exec(`
      DROP TABLE repos;
      ALTER TABLE repos_new RENAME TO repos;
      CREATE INDEX IF NOT EXISTS idx_repos_workspace ON repos(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_ws_path ON repos(workspace_id, repo_path);
    `)
  })
  try {
    tx.immediate()
  } finally {
    d.pragma('foreign_keys = ON')
  }
}

/**
 * The workspace→project / flight→worktree revamp renamed every core table and
 * FK column. Databases created before it hold `workspaces`/`flights` (with
 * `workspace_id`/`flight_id`/`worktree_path`). Rename them in place — SQLite's
 * modern `ALTER TABLE ... RENAME` updates the foreign-key references in child
 * tables automatically — so all existing projects, worktrees, tabs, layouts and
 * tasks survive the upgrade. Also remaps the `kind` value `'worktree'`→`'linked'`
 * to match the new WorktreeKind. Idempotent: no-op once `projects` exists, or
 * `repos` (what `projects` was renamed to next). The second check matters: after
 * that rename a modern DB has `workspaces` and no `projects`, which is exactly
 * what a pre-revamp DB looks like.
 */
function renameLegacySchema(d: Database.Database): void {
  if (!tableExists(d, 'workspaces') || tableExists(d, 'projects') || tableExists(d, 'repos')) return
  const tx = d.transaction(() => {
    d.exec('ALTER TABLE workspaces RENAME TO projects')

    d.exec('ALTER TABLE flights RENAME TO worktrees')
    d.exec('ALTER TABLE worktrees RENAME COLUMN workspace_id TO project_id')
    d.exec('ALTER TABLE worktrees RENAME COLUMN worktree_path TO path')

    d.exec('ALTER TABLE panes RENAME COLUMN flight_id TO worktree_id')

    d.exec('ALTER TABLE tabs RENAME COLUMN flight_id TO worktree_id')

    d.exec('ALTER TABLE tasks RENAME COLUMN workspace_id TO project_id')
    d.exec('ALTER TABLE tasks RENAME COLUMN flight_id TO worktree_id')

    // Legacy indexes reference the old names; drop them so the CREATE INDEX
    // IF NOT EXISTS above installs the renamed ones cleanly.
    d.exec('DROP INDEX IF EXISTS idx_flights_workspace')
    d.exec('DROP INDEX IF EXISTS idx_panes_flight')
    d.exec('DROP INDEX IF EXISTS idx_tabs_flight')
    d.exec('DROP INDEX IF EXISTS idx_tasks_workspace')

    // WorktreeKind: 'root' | 'linked' (was 'root' | 'worktree').
    d.exec("UPDATE worktrees SET kind = 'linked' WHERE kind = 'worktree'")
  })
  tx.immediate()
}

/**
 * A project's default agent used to name a PROVIDER (`default_agent_provider`);
 * it now names one of the workspace's configured agent profiles. Rename the
 * column in place — the stored provider ids still resolve, since the default
 * lineup gives each provider a profile of the same id (see findAgentConfig).
 * Idempotent: no-op once the column is already renamed (or the table is new).
 */
function renameAgentColumn(d: Database.Database): void {
  if (!tableExists(d, 'projects')) return
  const cols = (d.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((r) => r.name)
  if (!cols.includes('default_agent_provider') || cols.includes('default_agent_id')) return
  d.exec('ALTER TABLE projects RENAME COLUMN default_agent_provider TO default_agent_id')
}

/**
 * What the app called a project is a single git repo, and "project" now names
 * a group of repos. Rename the table, its FK columns and the rail tables in
 * place. ALTER TABLE ... RENAME rewrites the FK references in child tables, so
 * worktrees, tasks and rail positions keep pointing at the same rows. The old
 * indexes are dropped so the CREATE INDEX IF NOT EXISTS calls in migrate()
 * install them under the new names. Idempotent: runs only while `projects`
 * exists and `repos` does not. That guard is also what keeps it off the NEW
 * `projects` table (groups of repos, see groupReposIntoProjects): wherever
 * that table exists, `repos` exists beside it.
 */
function renameProjectsToRepos(d: Database.Database): void {
  if (!tableExists(d, 'projects') || tableExists(d, 'repos')) return
  const tx = d.transaction(() => {
    d.exec('ALTER TABLE projects RENAME TO repos')
    if (tableExists(d, 'worktrees')) d.exec('ALTER TABLE worktrees RENAME COLUMN project_id TO repo_id')
    if (tableExists(d, 'tasks')) d.exec('ALTER TABLE tasks RENAME COLUMN project_id TO repo_id')
    if (tableExists(d, 'project_folders')) d.exec('ALTER TABLE project_folders RENAME TO rail_folders')
    if (tableExists(d, 'project_rail_positions')) {
      d.exec('ALTER TABLE project_rail_positions RENAME TO rail_positions')
      d.exec('ALTER TABLE rail_positions RENAME COLUMN project_id TO repo_id')
    }
    for (const index of [
      'idx_projects_workspace',
      'idx_projects_ws_path',
      'idx_worktrees_project',
      'idx_tasks_project',
      'idx_project_folders_workspace',
      'idx_project_rail_positions_folder'
    ]) {
      d.exec(`DROP INDEX IF EXISTS ${index}`)
    }
  })
  tx.immediate()
}

/**
 * Put every repo in a project. Projects arrived after repos: a database from
 * before them has repos with no `project_id` and a rail keyed by repo. Each
 * such repo gets a project of its own, named after it and rooted at its path
 * (what the rail draws as a plain repo row), dated by the repo's `added_at` so
 * the unarranged end of the rail keeps its order. Then `rail_positions` is
 * rebuilt keyed by project, each row taking over its repo's folder and
 * position, so the rail looks exactly as it did.
 *
 * It is also the heal for what SQL cannot hold: a repo with no project (the
 * column is nullable, see the CREATE in migrate) gets one, and a home that is
 * not a member of its project is cleared. Runs on every boot; with nothing to
 * mend it is two reads and an update that matches no rows.
 *
 * The boot orders it has to survive, given that `projects` once named what is
 * now `repos`: renameProjectsToRepos runs first and only while `repos` is
 * absent, so by the time this runs `projects` is always the new table (made by
 * the CREATE in migrate wherever it was missing) — on a fresh database, a
 * pre-revamp one, a v1.45 one, one from before projects, or one already
 * grouped.
 */
function groupReposIntoProjects(d: Database.Database): void {
  const tx = d.transaction(() => {
    // Read under the write lock: another instance may be booting too.
    const orphans = d
      .prepare(
        `SELECT id, workspace_id, name, repo_path, added_at FROM repos
         WHERE project_id IS NULL OR project_id NOT IN (SELECT id FROM projects)
         ORDER BY added_at, rowid`
      )
      .all() as Array<{ id: string; workspace_id: string; name: string; repo_path: string; added_at: number }>
    const insert = d.prepare(
      'INSERT INTO projects (id, workspace_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    const join = d.prepare('UPDATE repos SET project_id = ?, project_position = 0 WHERE id = ?')
    for (const r of orphans) {
      const pid = randomUUID()
      insert.run(pid, r.workspace_id, r.name, r.repo_path, r.added_at)
      join.run(pid, r.id)
    }

    const railCols = (d.prepare('PRAGMA table_info(rail_positions)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    if (railCols.includes('repo_id')) {
      d.exec(`
        CREATE TABLE rail_positions_new (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          folder_id  TEXT REFERENCES rail_folders(id) ON DELETE CASCADE,
          position   INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO rail_positions_new (project_id, folder_id, position)
          SELECT r.project_id, s.folder_id, s.position
          FROM rail_positions s JOIN repos r ON r.id = s.repo_id
          ORDER BY s.position;
        DROP TABLE rail_positions;
        ALTER TABLE rail_positions_new RENAME TO rail_positions;
        CREATE INDEX IF NOT EXISTS idx_rail_positions_folder ON rail_positions(folder_id);
      `)
    }

    d.exec(
      `UPDATE projects SET home_repo_id = NULL
       WHERE home_repo_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM repos r WHERE r.id = projects.home_repo_id AND r.project_id = projects.id)`
    )
  })
  tx.immediate()
}

/**
 * Number tasks that predate the `seq` column: creation order, continuing after
 * the highest number already assigned. `seq` is the human-facing task number —
 * globally unique across all workspaces (the DB is global) and never reused;
 * allocation for new tasks lives in the tasks repository. Idempotent: once no
 * NULL rows remain this is a no-op.
 */
function backfillTaskSeqs(d: Database.Database): void {
  const rows = d.prepare('SELECT id FROM tasks WHERE seq IS NULL ORDER BY created_at, id').all() as Array<{
    id: string
  }>
  if (rows.length === 0) return
  const tx = d.transaction(() => {
    let next = (d.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM tasks').get() as { m: number }).m + 1
    const update = d.prepare('UPDATE tasks SET seq = ? WHERE id = ?')
    for (const r of rows) update.run(next++, r.id)
  })
  tx.immediate()
}

/**
 * Clear `tasks.worktree_id` where the Worktree it names is gone. Removing a
 * Worktree used to leave its task pointing at the deleted row (the column has
 * no foreign key), and such a task shows on the board as neither linked nor
 * startable. New removals unlink in the repository; this heals the rows left
 * behind by older builds. Idempotent: a no-op once nothing dangles.
 */
function unlinkTasksFromMissingWorktrees(d: Database.Database): void {
  d.exec(
    `UPDATE tasks SET worktree_id = NULL
     WHERE worktree_id IS NOT NULL AND worktree_id NOT IN (SELECT id FROM worktrees)`
  )
}

function tableExists(d: Database.Database, name: string): boolean {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/**
 * One-time move of env-sync patterns from per-repo rows to the global
 * settings blob: when the settings JSON has no `envSyncPatterns` key yet, seed
 * it with the union of every repo's stored patterns plus the current
 * defaults, so custom globs survive the switch. The legacy
 * `repos.env_sync_patterns` column is left in place but no longer read.
 */
function migrateEnvPatternsToSettings(d: Database.Database): void {
  const row = d.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
  if (!row) return // no settings row yet — the repository's defaults already include the key
  try {
    const parsed = JSON.parse(row.value)
    if (parsed && typeof parsed === 'object' && !('envSyncPatterns' in parsed)) {
      const union = new Set(DEFAULT_ENV_SYNC_PATTERNS)
      const rows = d.prepare('SELECT env_sync_patterns FROM repos').all() as Array<{
        env_sync_patterns: string
      }>
      for (const r of rows) {
        try {
          for (const p of JSON.parse(r.env_sync_patterns || '[]')) if (typeof p === 'string') union.add(p)
        } catch {
          // Skip unparseable per-workspace patterns.
        }
      }
      parsed.envSyncPatterns = [...union]
      d.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(parsed))
    }
  } catch {
    // Unparseable settings blob — the repository layer falls back to defaults.
  }
}

/**
 * Upgrade stored env-sync patterns from the old root-only default globs to
 * their recursive forms (prefixing `.env` and `.env.*` with a `**` glob), so
 * users who saved settings before the defaults went recursive still pick up
 * nested env files (the stored `envSyncPatterns` list fully shadows the
 * defaults). Only the exact legacy default spellings are rewritten; custom
 * globs are left untouched. Effectively one-shot: after the rewrite no legacy
 * spellings remain, so later runs no-op.
 */
function migrateEnvPatternsRecursive(d: Database.Database): void {
  const RECURSIVE = new Map([
    ['.env', '**/.env'],
    ['.env.*', '**/.env.*']
  ])
  const row = d.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
  if (!row) return // no settings row yet — the repository's defaults are already recursive
  try {
    const parsed = JSON.parse(row.value)
    const patterns = parsed?.envSyncPatterns
    if (!Array.isArray(patterns) || !patterns.some((p) => RECURSIVE.has(p))) return
    const upgraded: string[] = []
    for (const p of patterns) {
      const next = typeof p === 'string' ? (RECURSIVE.get(p) ?? p) : p
      if (!upgraded.includes(next)) upgraded.push(next)
    }
    parsed.envSyncPatterns = upgraded
    d.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(parsed))
  } catch {
    // Unparseable settings blob — the repository layer falls back to defaults.
  }
}

function addColumnIfMissing(d: Database.Database, table: string, column: string, def: string): void {
  const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  if (!cols.includes(column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
  }
}
