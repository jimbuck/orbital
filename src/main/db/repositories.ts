import { randomUUID } from 'node:crypto'
import { getDb } from './database'
import {
  type Project,
  type Worktree,
  type Pane,
  type Tab,
  type Task,
  type Settings,
  type AppState,
  type WorktreeKind,
  type TabType,
  type TabConfig,
  type TerminalStatus,
  type TaskStatus,
  type LayoutNode,
  type TaskPatch,
  type WorkspaceProjectConfig,
  aggregateStatus,
  isPtyTabType,
  DEFAULT_ENV_SYNC_PATTERNS,
  SUPPORTED_AGENTS
} from '@shared/types'
import { leaf, defaultLayout, layoutCovers } from '../services/layout'

export const id = (): string => randomUUID()
const now = (): number => Date.now()

const DEFAULT_SETTINGS: Settings = {
  defaultShell: '',
  alerts: { indicator: true, sound: true, taskbarBadge: true },
  claudeHooksInstalled: false,
  envSyncPatterns: DEFAULT_ENV_SYNC_PATTERNS,
  periodicFetch: true,
  debugLogging: false,
  enabledAgents: SUPPORTED_AGENTS.map((a) => a.id),
  // Existing installs merge over this default, so they stay dark and keep the
  // current look; only an explicit change opts a user into light/system.
  theme: 'dark'
}

/* ---- row -> entity mappers --------------------------------------------- */

function mapProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    defaultAgentProvider: r.default_agent_provider || 'claude',
    agentExecPath: r.agent_exec_path || undefined,
    addedAt: r.added_at
  }
}

function mapTab(r: any): Tab {
  return {
    id: r.id,
    worktreeId: r.worktree_id,
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
    projectId: r.project_id,
    title: r.title,
    description: r.description ?? '',
    tags: JSON.parse(r.tags || '[]') as string[],
    status: r.status as TaskStatus,
    worktreeId: r.worktree_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/* ============================================================================
 * Projects
 * ========================================================================== */

export const projects = {
  list(): Project[] {
    return getDb().prepare('SELECT * FROM projects ORDER BY added_at').all().map(mapProject)
  },
  get(pid: string): Project | undefined {
    const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(pid)
    return r ? mapProject(r) : undefined
  },
  getByPath(repoPath: string): Project | undefined {
    const r = getDb().prepare('SELECT * FROM projects WHERE repo_path = ?').get(repoPath)
    return r ? mapProject(r) : undefined
  },
  create(input: { name: string; repoPath: string }): Project {
    const pid = id()
    getDb()
      .prepare('INSERT INTO projects (id, name, repo_path, added_at) VALUES (?, ?, ?, ?)')
      .run(pid, input.name, input.repoPath, now())
    return projects.get(pid)!
  },
  remove(pid: string): void {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(pid)
  },
  rename(pid: string, name: string): void {
    getDb().prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, pid)
  },
  updateAgent(pid: string, patch: { defaultAgentProvider?: string; agentExecPath?: string }): void {
    const cur = projects.get(pid)
    if (!cur) return
    getDb()
      .prepare('UPDATE projects SET default_agent_provider = ?, agent_exec_path = ? WHERE id = ?')
      .run(patch.defaultAgentProvider ?? cur.defaultAgentProvider, patch.agentExecPath ?? cur.agentExecPath ?? '', pid)
  },
  /**
   * Make the `projects` table match a workspace config's project list (the YAML
   * is the source of truth). Rows absent from the config are deleted — their
   * worktrees, panes, tabs and tasks cascade away — and each config entry is
   * upserted by its stable id, preserving `added_at` (hence list order) for rows
   * that already exist. Runs in one transaction so a mid-reconcile failure can't
   * leave the projection half-applied. Returns the ids that were deleted so the
   * caller can release any runtime resources (watchers, terminals) for them.
   */
  reconcile(configProjects: WorkspaceProjectConfig[]): { removed: string[] } {
    const db = getDb()
    const keep = new Set(configProjects.map((p) => p.id))
    const removed: string[] = []
    const tx = db.transaction(() => {
      for (const row of projects.list()) {
        if (!keep.has(row.id)) {
          projects.remove(row.id)
          removed.push(row.id)
        }
      }
      const upsert = db.prepare(
        `INSERT INTO projects (id, name, repo_path, default_agent_provider, agent_exec_path, added_at)
         VALUES (@id, @name, @repoPath, @provider, @execPath, @addedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           repo_path = excluded.repo_path,
           default_agent_provider = excluded.default_agent_provider,
           agent_exec_path = excluded.agent_exec_path`
      )
      let seq = now()
      for (const p of configProjects) {
        upsert.run({
          id: p.id,
          name: p.name,
          repoPath: p.path,
          provider: p.agentProvider || 'claude',
          execPath: p.agentExecPath ?? '',
          // New rows land after existing ones, in config order; existing rows
          // keep their stored added_at via the ON CONFLICT branch above.
          addedAt: seq++
        })
      }
    })
    tx()
    return { removed }
  }
}

/* ============================================================================
 * Worktrees, panes, tabs
 * ========================================================================== */

function buildPane(p: any, tabRows: any[]): Pane {
  const tabs = tabRows.map(mapTab)
  const activeRow = tabRows.find((t: any) => t.active === 1) as any
  return {
    id: p.id,
    worktreeId: p.worktree_id,
    activeTabId: activeRow?.id ?? tabs[0]?.id ?? null,
    tabs
  }
}

function buildWorktree(r: any, panes: Pane[]): Worktree {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as WorktreeKind,
    name: r.name,
    path: r.path,
    branch: r.branch,
    status: r.status as TerminalStatus,
    taskId: r.task_id ?? null,
    layout: resolveLayout(r.layout, panes.map((p) => p.id)),
    createdAt: r.created_at,
    panes
  }
}

function hydrateWorktree(r: any): Worktree {
  const db = getDb()
  const panes = db
    .prepare('SELECT * FROM panes WHERE worktree_id = ? ORDER BY position')
    .all(r.id)
    .map((p: any) => buildPane(p, db.prepare('SELECT * FROM tabs WHERE pane_id = ? ORDER BY position').all(p.id)))
  return buildWorktree(r, panes)
}

/**
 * Parse a Worktree's stored layout, rebuilding it if it no longer covers its panes.
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

export const worktrees = {
  /** Hydrate all worktrees with two batched queries (not one per worktree/pane). */
  list(): Worktree[] {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM worktrees ORDER BY created_at').all() as any[]
    if (rows.length === 0) return []

    const tabsByPane = new Map<string, any[]>()
    for (const t of db.prepare('SELECT * FROM tabs ORDER BY position').all() as any[]) {
      const list = tabsByPane.get(t.pane_id)
      if (list) list.push(t)
      else tabsByPane.set(t.pane_id, [t])
    }

    const panesByWorktree = new Map<string, Pane[]>()
    for (const p of db.prepare('SELECT * FROM panes ORDER BY position').all() as any[]) {
      const pane = buildPane(p, tabsByPane.get(p.id) ?? [])
      const list = panesByWorktree.get(p.worktree_id)
      if (list) list.push(pane)
      else panesByWorktree.set(p.worktree_id, [pane])
    }

    return rows.map((r) => buildWorktree(r, panesByWorktree.get(r.id) ?? []))
  },
  /** Lightweight id+status projection for alert badging — skips pane/tab hydration. */
  listStatuses(): Pick<Worktree, 'id' | 'status'>[] {
    return getDb().prepare('SELECT id, status FROM worktrees').all() as Pick<Worktree, 'id' | 'status'>[]
  },
  get(wid: string): Worktree | undefined {
    const r = getDb().prepare('SELECT * FROM worktrees WHERE id = ?').get(wid)
    return r ? hydrateWorktree(r) : undefined
  },
  create(input: {
    projectId: string
    kind: WorktreeKind
    name: string
    path: string
    branch: string
    taskId?: string | null
  }): Worktree {
    const wid = id()
    getDb()
      .prepare(
        `INSERT INTO worktrees (id, project_id, kind, name, path, branch, status, task_id, split_direction, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, 'row', ?)`
      )
      .run(wid, input.projectId, input.kind, input.name, input.path, input.branch, input.taskId ?? null, now())
    // Every Worktree starts with one empty pane (a single-leaf layout) for its first tab.
    const pane = panes.create(wid)
    worktrees.setLayout(wid, leaf(pane.id))
    return worktrees.get(wid)!
  },
  remove(wid: string): void {
    getDb().prepare('DELETE FROM worktrees WHERE id = ?').run(wid)
  },
  rename(wid: string, name: string): void {
    getDb().prepare('UPDATE worktrees SET name = ? WHERE id = ?').run(name, wid)
  },
  updateStatus(wid: string, status: TerminalStatus): void {
    getDb().prepare('UPDATE worktrees SET status = ? WHERE id = ?').run(status, wid)
  },
  /** Sync the stored branch for every worktree checked out at `path`; true if anything changed. */
  updateBranchByPath(path: string, branch: string): boolean {
    const r = getDb()
      .prepare('UPDATE worktrees SET branch = ? WHERE path = ? AND branch <> ?')
      .run(branch, path, branch)
    return r.changes > 0
  },
  setLayout(wid: string, layout: LayoutNode): void {
    getDb().prepare('UPDATE worktrees SET layout = ? WHERE id = ?').run(JSON.stringify(layout), wid)
  },
  /** Recompute and persist the aggregate status from a Worktree's terminal tabs. */
  recomputeStatus(wid: string): TerminalStatus {
    const statuses = getDb()
      .prepare("SELECT status FROM tabs WHERE worktree_id = ? AND type IN ('terminal', 'agent') AND status IS NOT NULL")
      .all(wid)
      .map((r: any) => r.status as TerminalStatus)
    const agg = aggregateStatus(statuses)
    worktrees.updateStatus(wid, agg)
    return agg
  }
}

export const panes = {
  create(worktreeId: string): Pane {
    const pid = id()
    const pos =
      (getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM panes WHERE worktree_id = ?').get(worktreeId) as any)
        .m + 1
    getDb().prepare('INSERT INTO panes (id, worktree_id, position, flex) VALUES (?, ?, ?, 1)').run(pid, worktreeId, pos)
    return { id: pid, worktreeId, activeTabId: null, tabs: [] }
  },
  remove(pid: string): void {
    getDb().prepare('DELETE FROM panes WHERE id = ?').run(pid)
  },
  firstPaneId(worktreeId: string): string | undefined {
    const r = getDb().prepare('SELECT id FROM panes WHERE worktree_id = ? ORDER BY position LIMIT 1').get(worktreeId) as any
    return r?.id
  }
}

export const tabs = {
  get(tid: string): Tab | undefined {
    const r = getDb().prepare('SELECT * FROM tabs WHERE id = ?').get(tid)
    return r ? mapTab(r) : undefined
  },
  create(input: {
    worktreeId: string
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
        'INSERT INTO tabs (id, worktree_id, pane_id, type, status, position, active, config) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
      )
      .run(tid, input.worktreeId, input.paneId, input.type, status, pos, JSON.stringify(input.config ?? {}))
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
    return getDb().prepare('SELECT * FROM tasks ORDER BY created_at, id').all().map(mapTask)
  },
  get(tid: string): Task | undefined {
    const r = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(tid)
    return r ? mapTask(r) : undefined
  },
  create(input: { projectId: string; title: string; description?: string; tags?: string[] }): Task {
    const tid = id()
    const t = now()
    getDb()
      .prepare(
        'INSERT INTO tasks (id, project_id, title, description, tags, status, worktree_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)'
      )
      .run(tid, input.projectId, input.title, input.description ?? '', JSON.stringify(input.tags ?? []), 'todo', t, t)
    return tasks.get(tid)!
  },
  update(tid: string, patch: TaskPatch): Task {
    const cur = tasks.get(tid)
    if (!cur) throw new Error(`task ${tid} not found`)
    getDb()
      .prepare(
        'UPDATE tasks SET title = ?, description = ?, tags = ?, status = ?, project_id = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        patch.title ?? cur.title,
        patch.description ?? cur.description,
        JSON.stringify(patch.tags ?? cur.tags),
        patch.status ?? cur.status,
        patch.projectId ?? cur.projectId,
        now(),
        tid
      )
    return tasks.get(tid)!
  },
  setWorktree(tid: string, worktreeId: string | null): void {
    getDb().prepare('UPDATE tasks SET worktree_id = ?, updated_at = ? WHERE id = ?').run(worktreeId, now(), tid)
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

/** Persisted state; the runtime layers its in-memory `devServers` / `settingUpWorktrees` on top. */
export function getAppState(): Omit<AppState, 'devServers' | 'settingUpWorktrees'> {
  return {
    projects: projects.list(),
    worktrees: worktrees.list(),
    tasks: tasks.list(),
    settings: settings.get()
  }
}
