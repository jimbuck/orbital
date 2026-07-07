import { randomUUID } from 'node:crypto'
import { getDb } from './database'
import {
  type Workspace,
  type Flight,
  type Pane,
  type Tab,
  type Task,
  type Settings,
  type AppState,
  type FlightKind,
  type TabType,
  type TabConfig,
  type TerminalStatus,
  type TaskStatus,
  type LayoutNode,
  type TaskPatch,
  aggregateStatus,
  isPtyTabType
} from '@shared/types'
import { leaf, defaultLayout, layoutCovers } from '../services/layout'

export const id = (): string => randomUUID()
const now = (): number => Date.now()

const DEFAULT_SETTINGS: Settings = {
  defaultShell: '',
  alerts: { indicator: true, sound: true, taskbarBadge: true },
  claudeHooksInstalled: false
}

/* ---- row -> entity mappers --------------------------------------------- */

function mapWorkspace(r: any): Workspace {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    envSyncPatterns: JSON.parse(r.env_sync_patterns || '[]'),
    defaultAgentProvider: r.default_agent_provider || 'claude',
    agentExecPath: r.agent_exec_path || undefined,
    addedAt: r.added_at
  }
}

function mapTab(r: any): Tab {
  return {
    id: r.id,
    flightId: r.flight_id,
    paneId: r.pane_id,
    type: r.type as TabType,
    status: (r.status as TerminalStatus | null) ?? null,
    position: r.position,
    config: JSON.parse(r.config || '{}') as TabConfig
  }
}

function mapTask(r: any): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    description: r.description ?? '',
    status: r.status as TaskStatus,
    flightId: r.flight_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/* ============================================================================
 * Workspaces
 * ========================================================================== */

export const workspaces = {
  list(): Workspace[] {
    return getDb().prepare('SELECT * FROM workspaces ORDER BY added_at').all().map(mapWorkspace)
  },
  get(wid: string): Workspace | undefined {
    const r = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(wid)
    return r ? mapWorkspace(r) : undefined
  },
  getByPath(repoPath: string): Workspace | undefined {
    const r = getDb().prepare('SELECT * FROM workspaces WHERE repo_path = ?').get(repoPath)
    return r ? mapWorkspace(r) : undefined
  },
  create(input: { name: string; repoPath: string; envSyncPatterns?: string[] }): Workspace {
    const wid = id()
    getDb()
      .prepare(
        'INSERT INTO workspaces (id, name, repo_path, env_sync_patterns, added_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(wid, input.name, input.repoPath, JSON.stringify(input.envSyncPatterns ?? ['.env', '.env.*']), now())
    return workspaces.get(wid)!
  },
  remove(wid: string): void {
    getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(wid)
  },
  rename(wid: string, name: string): void {
    getDb().prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, wid)
  },
  updateEnvPatterns(wid: string, patterns: string[]): void {
    getDb().prepare('UPDATE workspaces SET env_sync_patterns = ? WHERE id = ?').run(JSON.stringify(patterns), wid)
  },
  updateAgent(wid: string, patch: { defaultAgentProvider?: string; agentExecPath?: string }): void {
    const cur = workspaces.get(wid)
    if (!cur) return
    getDb()
      .prepare('UPDATE workspaces SET default_agent_provider = ?, agent_exec_path = ? WHERE id = ?')
      .run(patch.defaultAgentProvider ?? cur.defaultAgentProvider, patch.agentExecPath ?? cur.agentExecPath ?? '', wid)
  }
}

/* ============================================================================
 * Flights, panes, tabs
 * ========================================================================== */

function buildPane(p: any, tabRows: any[]): Pane {
  const tabs = tabRows.map(mapTab)
  const activeRow = tabRows.find((t: any) => t.active === 1) as any
  return {
    id: p.id,
    flightId: p.flight_id,
    activeTabId: activeRow?.id ?? tabs[0]?.id ?? null,
    tabs
  }
}

function buildFlight(r: any, panes: Pane[]): Flight {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as FlightKind,
    name: r.name,
    worktreePath: r.worktree_path,
    branch: r.branch,
    status: r.status as TerminalStatus,
    taskId: r.task_id ?? null,
    layout: resolveLayout(r.layout, panes.map((p) => p.id)),
    createdAt: r.created_at,
    panes
  }
}

function hydrateFlight(r: any): Flight {
  const db = getDb()
  const panes = db
    .prepare('SELECT * FROM panes WHERE flight_id = ? ORDER BY position')
    .all(r.id)
    .map((p: any) => buildPane(p, db.prepare('SELECT * FROM tabs WHERE pane_id = ? ORDER BY position').all(p.id)))
  return buildFlight(r, panes)
}

/**
 * Parse a Flight's stored layout, rebuilding it if it no longer covers its panes.
 * The rebuild is deterministic and NOT persisted here — hydration is a read path;
 * the next layout mutation (split/close/ratio) persists whatever it operates on.
 */
function resolveLayout(raw: string, paneIdList: string[]): LayoutNode {
  let parsed: LayoutNode | null = null
  try {
    parsed = raw ? (JSON.parse(raw) as LayoutNode) : null
  } catch {
    parsed = null
  }
  if (layoutCovers(parsed, paneIdList)) return parsed as LayoutNode
  return defaultLayout(paneIdList)
}

export const flights = {
  /** Hydrate all flights with two batched queries (not one per flight/pane). */
  list(): Flight[] {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM flights ORDER BY created_at').all() as any[]
    if (rows.length === 0) return []

    const tabsByPane = new Map<string, any[]>()
    for (const t of db.prepare('SELECT * FROM tabs ORDER BY position').all() as any[]) {
      const list = tabsByPane.get(t.pane_id)
      if (list) list.push(t)
      else tabsByPane.set(t.pane_id, [t])
    }

    const panesByFlight = new Map<string, Pane[]>()
    for (const p of db.prepare('SELECT * FROM panes ORDER BY position').all() as any[]) {
      const pane = buildPane(p, tabsByPane.get(p.id) ?? [])
      const list = panesByFlight.get(p.flight_id)
      if (list) list.push(pane)
      else panesByFlight.set(p.flight_id, [pane])
    }

    return rows.map((r) => buildFlight(r, panesByFlight.get(r.id) ?? []))
  },
  /** Lightweight id+status projection for alert badging — skips pane/tab hydration. */
  listStatuses(): Pick<Flight, 'id' | 'status'>[] {
    return getDb().prepare('SELECT id, status FROM flights').all() as Pick<Flight, 'id' | 'status'>[]
  },
  get(fid: string): Flight | undefined {
    const r = getDb().prepare('SELECT * FROM flights WHERE id = ?').get(fid)
    return r ? hydrateFlight(r) : undefined
  },
  create(input: {
    workspaceId: string
    kind: FlightKind
    name: string
    worktreePath: string
    branch: string
    taskId?: string | null
  }): Flight {
    const fid = id()
    getDb()
      .prepare(
        `INSERT INTO flights (id, workspace_id, kind, name, worktree_path, branch, status, task_id, split_direction, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, 'row', ?)`
      )
      .run(fid, input.workspaceId, input.kind, input.name, input.worktreePath, input.branch, input.taskId ?? null, now())
    // Every Flight starts with one empty pane (a single-leaf layout) for its first tab.
    const pane = panes.create(fid)
    flights.setLayout(fid, leaf(pane.id))
    return flights.get(fid)!
  },
  remove(fid: string): void {
    getDb().prepare('DELETE FROM flights WHERE id = ?').run(fid)
  },
  rename(fid: string, name: string): void {
    getDb().prepare('UPDATE flights SET name = ? WHERE id = ?').run(name, fid)
  },
  updateStatus(fid: string, status: TerminalStatus): void {
    getDb().prepare('UPDATE flights SET status = ? WHERE id = ?').run(status, fid)
  },
  /** Sync the stored branch for every flight checked out at `worktreePath`; true if anything changed. */
  updateBranchByWorktree(worktreePath: string, branch: string): boolean {
    const r = getDb()
      .prepare('UPDATE flights SET branch = ? WHERE worktree_path = ? AND branch <> ?')
      .run(branch, worktreePath, branch)
    return r.changes > 0
  },
  setLayout(fid: string, layout: LayoutNode): void {
    getDb().prepare('UPDATE flights SET layout = ? WHERE id = ?').run(JSON.stringify(layout), fid)
  },
  /** Recompute and persist the aggregate status from a Flight's terminal tabs. */
  recomputeStatus(fid: string): TerminalStatus {
    const statuses = getDb()
      .prepare("SELECT status FROM tabs WHERE flight_id = ? AND type IN ('terminal', 'agent') AND status IS NOT NULL")
      .all(fid)
      .map((r: any) => r.status as TerminalStatus)
    const agg = aggregateStatus(statuses)
    flights.updateStatus(fid, agg)
    return agg
  }
}

export const panes = {
  create(flightId: string): Pane {
    const pid = id()
    const pos =
      (getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM panes WHERE flight_id = ?').get(flightId) as any)
        .m + 1
    getDb().prepare('INSERT INTO panes (id, flight_id, position, flex) VALUES (?, ?, ?, 1)').run(pid, flightId, pos)
    return { id: pid, flightId, activeTabId: null, tabs: [] }
  },
  remove(pid: string): void {
    getDb().prepare('DELETE FROM panes WHERE id = ?').run(pid)
  },
  firstPaneId(flightId: string): string | undefined {
    const r = getDb().prepare('SELECT id FROM panes WHERE flight_id = ? ORDER BY position LIMIT 1').get(flightId) as any
    return r?.id
  }
}

export const tabs = {
  get(tid: string): Tab | undefined {
    const r = getDb().prepare('SELECT * FROM tabs WHERE id = ?').get(tid)
    return r ? mapTab(r) : undefined
  },
  create(input: {
    flightId: string
    paneId: string
    type: TabType
    status?: TerminalStatus | null
    config?: TabConfig
  }): Tab {
    const tid = id()
    const pos =
      (getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tabs WHERE pane_id = ?').get(input.paneId) as any)
        .m + 1
    const status = isPtyTabType(input.type) ? (input.status ?? 'idle') : null
    getDb()
      .prepare(
        'INSERT INTO tabs (id, flight_id, pane_id, type, status, position, active, config) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
      )
      .run(tid, input.flightId, input.paneId, input.type, status, pos, JSON.stringify(input.config ?? {}))
    tabs.setActive(input.paneId, tid)
    return tabs.get(tid)!
  },
  remove(tid: string): void {
    getDb().prepare('DELETE FROM tabs WHERE id = ?').run(tid)
  },
  setActive(paneId: string, tabId: string): void {
    const d = getDb()
    d.prepare('UPDATE tabs SET active = 0 WHERE pane_id = ?').run(paneId)
    d.prepare('UPDATE tabs SET active = 1 WHERE id = ?').run(tabId)
  },
  updateStatus(tid: string, status: TerminalStatus): void {
    getDb().prepare('UPDATE tabs SET status = ? WHERE id = ?').run(status, tid)
  },
  updateConfig(tid: string, config: TabConfig): void {
    getDb().prepare('UPDATE tabs SET config = ? WHERE id = ?').run(JSON.stringify(config), tid)
  },
  move(tid: string, targetPaneId: string): void {
    const pos =
      (getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tabs WHERE pane_id = ?').get(targetPaneId) as any)
        .m + 1
    getDb().prepare('UPDATE tabs SET pane_id = ?, position = ? WHERE id = ?').run(targetPaneId, pos, tid)
    tabs.setActive(targetPaneId, tid)
  },
  inPane(paneId: string): Tab[] {
    return getDb().prepare('SELECT * FROM tabs WHERE pane_id = ? ORDER BY position').all(paneId).map(mapTab)
  }
}

/* ============================================================================
 * Tasks
 * ========================================================================== */

export const tasks = {
  list(): Task[] {
    return getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(mapTask)
  },
  get(tid: string): Task | undefined {
    const r = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(tid)
    return r ? mapTask(r) : undefined
  },
  create(input: { workspaceId: string; title: string; description?: string }): Task {
    const tid = id()
    const t = now()
    getDb()
      .prepare(
        'INSERT INTO tasks (id, workspace_id, title, description, status, flight_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'
      )
      .run(tid, input.workspaceId, input.title, input.description ?? '', 'todo', t, t)
    return tasks.get(tid)!
  },
  update(tid: string, patch: TaskPatch): Task {
    const cur = tasks.get(tid)
    if (!cur) throw new Error(`task ${tid} not found`)
    getDb()
      .prepare('UPDATE tasks SET title = ?, description = ?, status = ?, workspace_id = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title ?? cur.title,
        patch.description ?? cur.description,
        patch.status ?? cur.status,
        patch.workspaceId ?? cur.workspaceId,
        now(),
        tid
      )
    return tasks.get(tid)!
  },
  setFlight(tid: string, flightId: string | null): void {
    getDb().prepare('UPDATE tasks SET flight_id = ?, updated_at = ? WHERE id = ?').run(flightId, now(), tid)
  },
  remove(tid: string): void {
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(tid)
  }
}

/* ============================================================================
 * Settings (single-row key/value store)
 * ========================================================================== */

export const settings = {
  get(): Settings {
    const r = getDb().prepare("SELECT value FROM settings WHERE key = 'app'").get() as any
    if (!r) return DEFAULT_SETTINGS
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(r.value) }
    } catch {
      return DEFAULT_SETTINGS
    }
  },
  set(s: Settings): Settings {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(s))
    return s
  }
}

/* ============================================================================
 * Full hydrated state
 * ========================================================================== */

/** Persisted state; the runtime layers its in-memory `devServers` on top. */
export function getAppState(): Omit<AppState, 'devServers'> {
  return {
    workspaces: workspaces.list(),
    flights: flights.list(),
    tasks: tasks.list(),
    settings: settings.get()
  }
}
