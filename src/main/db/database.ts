import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'

let db: Database.Database | null = null

/**
 * Open (and migrate) the Orbital SQLite store. State lives in the app's
 * userData directory — never in a workspace repo (PRD §12, §15).
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
  d.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      repo_path              TEXT NOT NULL UNIQUE,
      env_sync_patterns      TEXT NOT NULL DEFAULT '[]',
      default_agent_provider TEXT NOT NULL DEFAULT 'claude',
      agent_exec_path        TEXT NOT NULL DEFAULT '',
      added_at               INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS flights (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      worktree_path   TEXT NOT NULL,
      branch          TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'idle',
      task_id         TEXT,
      split_direction TEXT NOT NULL DEFAULT 'row',
      layout          TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flights_workspace ON flights(workspace_id);

    CREATE TABLE IF NOT EXISTS panes (
      id         TEXT PRIMARY KEY,
      flight_id  TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      flex       REAL NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_panes_flight ON panes(flight_id);

    CREATE TABLE IF NOT EXISTS tabs (
      id         TEXT PRIMARY KEY,
      flight_id  TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
      pane_id    TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      status     TEXT,
      position   INTEGER NOT NULL,
      active     INTEGER NOT NULL DEFAULT 0,
      config     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_tabs_flight ON tabs(flight_id);
    CREATE INDEX IF NOT EXISTS idx_tabs_pane ON tabs(pane_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'todo',
      flight_id    TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Migrations for databases created before a column existed.
  addColumnIfMissing(d, 'flights', 'layout', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(d, 'workspaces', 'default_agent_provider', "TEXT NOT NULL DEFAULT 'claude'")
  addColumnIfMissing(d, 'workspaces', 'agent_exec_path', "TEXT NOT NULL DEFAULT ''")
}

function addColumnIfMissing(d: Database.Database, table: string, column: string, def: string): void {
  const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  if (!cols.includes(column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
  }
}
