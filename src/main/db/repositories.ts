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
  type SplitDirection,
  type TaskPatch
} from '@shared/types'

export const id = (): string => randomUUID()
const now = (): number => Date.now()

const DEFAULT_SETTINGS: Settings = {
  defaultShell: '',
  alerts: { indicator: true, sound: true, taskbarBadge: true }
}

/* ---- row -> entity mappers --------------------------------------------- */

function mapWorkspace(r: any): Workspace {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    envSyncPatterns: JSON.parse(r.env_sync_patterns || '[]'),
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
  updateEnvPatterns(wid: string, patterns: string[]): void {
    getDb().prepare('UPDATE workspaces SET env_sync_patterns = ? WHERE id = ?').run(JSON.stringify(patterns), wid)
  }
}

/* ============================================================================
 * Flights, panes, tabs
 * ========================================================================== */

function hydrateFlight(r: any): Flight {
  const paneRows = getDb().prepare('SELECT * FROM panes WHERE flight_id = ? ORDER BY position').all(r.id)
  const panes: Pane[] = paneRows.map((p: any) => {
    const tabRows = getDb().prepare('SELECT * FROM tabs WHERE pane_id = ? ORDER BY position').all(p.id)
    const tabs = tabRows.map(mapTab)
    const activeRow = tabRows.find((t: any) => t.active === 1) as any
    return {
      id: p.id,
      flightId: p.flight_id,
      position: p.position,
      flex: p.flex,
      activeTabId: activeRow?.id ?? tabs[0]?.id ?? null,
      tabs
    }
  })
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as FlightKind,
    name: r.name,
    worktreePath: r.worktree_path,
    branch: r.branch,
    status: r.status as TerminalStatus,
    taskId: r.task_id ?? null,
    splitDirection: r.split_direction as SplitDirection,
    createdAt: r.created_at,
    panes
  }
}

export const flights = {
  list(): Flight[] {
    return getDb().prepare('SELECT * FROM flights ORDER BY created_at').all().map(hydrateFlight)
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
    // Every Flight starts with one empty pane to host its first tab.
    panes.create(fid)
    return flights.get(fid)!
  },
  remove(fid: string): void {
    getDb().prepare('DELETE FROM flights WHERE id = ?').run(fid)
  },
  updateStatus(fid: string, status: TerminalStatus): void {
    getDb().prepare('UPDATE flights SET status = ? WHERE id = ?').run(status, fid)
  },
  updateSplitDirection(fid: string, dir: SplitDirection): void {
    getDb().prepare('UPDATE flights SET split_direction = ? WHERE id = ?').run(dir, fid)
  },
  /** Recompute and persist the aggregate status from a Flight's terminal tabs. */
  recomputeStatus(fid: string): TerminalStatus {
    const statuses = getDb()
      .prepare("SELECT status FROM tabs WHERE flight_id = ? AND type = 'terminal' AND status IS NOT NULL")
      .all(fid)
      .map((r: any) => r.status as TerminalStatus)
    // import-free aggregate to avoid a cycle: mirror STATUS_PRECEDENCE.
    const order: TerminalStatus[] = ['needs_attention', 'error', 'working', 'idle', 'done']
    let agg: TerminalStatus = 'idle'
    if (statuses.length > 0) {
      agg = order.find((s) => statuses.includes(s)) ?? 'idle'
    }
    flights.updateStatus(fid, agg)
    return agg
  }
}

export const panes = {
  create(flightId: string, flex = 1): Pane {
    const pid = id()
    const pos =
      (getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM panes WHERE flight_id = ?').get(flightId) as any)
        .m + 1
    getDb().prepare('INSERT INTO panes (id, flight_id, position, flex) VALUES (?, ?, ?, ?)').run(pid, flightId, pos, flex)
    return { id: pid, flightId, position: pos, flex, activeTabId: null, tabs: [] }
  },
  remove(pid: string): void {
    getDb().prepare('DELETE FROM panes WHERE id = ?').run(pid)
  },
  updateFlex(pid: string, flex: number): void {
    getDb().prepare('UPDATE panes SET flex = ? WHERE id = ?').run(flex, pid)
  },
  count(flightId: string): number {
    return (getDb().prepare('SELECT COUNT(*) AS c FROM panes WHERE flight_id = ?').get(flightId) as any).c
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
    const status = input.type === 'terminal' ? (input.status ?? 'idle') : null
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
  /** Terminal tabs across all flights — used to clean up PTYs on shutdown. */
  allTerminals(): Tab[] {
    return getDb().prepare("SELECT * FROM tabs WHERE type = 'terminal'").all().map(mapTab)
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
      .prepare('UPDATE tasks SET title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(patch.title ?? cur.title, patch.description ?? cur.description, patch.status ?? cur.status, now(), tid)
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

export function getAppState(): AppState {
  return {
    workspaces: workspaces.list(),
    flights: flights.list(),
    tasks: tasks.list(),
    settings: settings.get()
  }
}
