import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { DEFAULT_ENV_SYNC_PATTERNS } from '@shared/types'

let db: Database.Database | null = null

/**
 * Open (and migrate) the Orbital SQLite store. State lives in the app's
 * userData directory — never in a project repo (PRD §12, §15).
 */
export function getDb(): Database.Database {
  if (db) return db
  const file = join(app.getPath('userData'), 'orbital.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
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

  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      repo_path              TEXT NOT NULL UNIQUE,
      env_sync_patterns      TEXT NOT NULL DEFAULT '[]',
      default_agent_provider TEXT NOT NULL DEFAULT 'claude',
      agent_exec_path        TEXT NOT NULL DEFAULT '',
      added_at               INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);

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
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      tags         TEXT NOT NULL DEFAULT '[]',
      status       TEXT NOT NULL DEFAULT 'todo',
      worktree_id  TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Migrations for databases created before a column existed.
  addColumnIfMissing(d, 'worktrees', 'layout', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(d, 'projects', 'default_agent_provider', "TEXT NOT NULL DEFAULT 'claude'")
  addColumnIfMissing(d, 'projects', 'agent_exec_path', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(d, 'tasks', 'tags', "TEXT NOT NULL DEFAULT '[]'")
  migrateEnvPatternsToSettings(d)
  migrateEnvPatternsRecursive(d)
}

/**
 * The workspace→project / flight→worktree revamp renamed every core table and
 * FK column. Databases created before it hold `workspaces`/`flights` (with
 * `workspace_id`/`flight_id`/`worktree_path`). Rename them in place — SQLite's
 * modern `ALTER TABLE ... RENAME` updates the foreign-key references in child
 * tables automatically — so all existing projects, worktrees, tabs, layouts and
 * tasks survive the upgrade. Also remaps the `kind` value `'worktree'`→`'linked'`
 * to match the new WorktreeKind. Idempotent: no-op once `projects` exists.
 */
function renameLegacySchema(d: Database.Database): void {
  if (!tableExists(d, 'workspaces') || tableExists(d, 'projects')) return
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
  tx()
}

function tableExists(d: Database.Database, name: string): boolean {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/**
 * One-time move of env-sync patterns from per-project rows to the global
 * settings blob: when the settings JSON has no `envSyncPatterns` key yet, seed
 * it with the union of every project's stored patterns plus the current
 * defaults, so custom globs survive the switch. The legacy
 * `projects.env_sync_patterns` column is left in place but no longer read.
 */
function migrateEnvPatternsToSettings(d: Database.Database): void {
  const row = d.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
  if (!row) return // no settings row yet — the repository's defaults already include the key
  try {
    const parsed = JSON.parse(row.value)
    if (parsed && typeof parsed === 'object' && !('envSyncPatterns' in parsed)) {
      const union = new Set(DEFAULT_ENV_SYNC_PATTERNS)
      const rows = d.prepare('SELECT env_sync_patterns FROM projects').all() as Array<{
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
