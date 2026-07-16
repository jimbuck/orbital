import { randomUUID } from 'node:crypto'
import { getDb } from './database'
import {
  type Project,
  type Worktree,
  type Pane,
  type Tab,
  type Task,
  type AppState,
  type WorktreeKind,
  type TabType,
  type TabConfig,
  type TerminalStatus,
  type TaskStatus,
  type LayoutNode,
  type TaskPatch,
  type WorkspaceInfo,
  type WorkspaceSettings,
  aggregateStatus,
  isPtyTabType
} from '@shared/types'
import { leaf, defaultLayout, layoutCovers } from '../services/layout'

export const id = (): string => randomUUID()
const now = (): number => Date.now()

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
 * Workspaces
 * ========================================================================== */

/**
 * The workspace this INSTANCE is scoped to — set once at boot, before anything
 * reads state. Every project (and, through projects, every worktree and task)
 * the instance sees belongs to this workspace; the underlying DB is shared by
 * all workspaces and instances.
 */
let activeWorkspaceId: string | null = null

export function setActiveWorkspaceId(workspaceId: string): void {
  activeWorkspaceId = workspaceId
}

export function requireWorkspaceId(): string {
  if (!activeWorkspaceId) throw new Error('active workspace not set — boot resolution must run first')
  return activeWorkspaceId
}

function mapWorkspace(r: any): WorkspaceInfo {
  return { id: r.id, name: r.name, lastOpenedAt: r.last_opened_at, projectCount: r.project_count ?? 0 }
}

export const workspaces = {
  /** Every workspace, most recently opened first (the picker's list). */
  list(): WorkspaceInfo[] {
    return getDb()
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS project_count
         FROM workspaces w ORDER BY w.last_opened_at DESC, w.created_at`
      )
      .all()
      .map(mapWorkspace)
  },
  get(workspaceId: string): WorkspaceInfo | undefined {
    const r = getDb()
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS project_count
         FROM workspaces w WHERE w.id = ?`
      )
      .get(workspaceId)
    return r ? mapWorkspace(r) : undefined
  },
  /** The instance's own workspace. */
  active(): WorkspaceInfo {
    const ws = workspaces.get(requireWorkspaceId())
    if (!ws) throw new Error('active workspace row missing')
    return ws
  },
  /** The workspace a no-argument launch opens: the most recently used one. */
  mostRecentId(): string | undefined {
    const r = getDb()
      .prepare('SELECT id FROM workspaces ORDER BY last_opened_at DESC, created_at LIMIT 1')
      .get() as { id: string } | undefined
    return r?.id
  },
  create(name: string, settings: Partial<WorkspaceSettings> = {}): WorkspaceInfo {
    const wid = id()
    getDb()
      .prepare('INSERT INTO workspaces (id, name, settings, created_at, last_opened_at) VALUES (?, ?, ?, ?, 0)')
      .run(wid, name, JSON.stringify(settings), now())
    return workspaces.get(wid)!
  },
  rename(workspaceId: string, name: string): void {
    getDb().prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, workspaceId)
  },
  /** Delete a workspace; its projects (and their worktrees/tasks) cascade away. */
  remove(workspaceId: string): void {
    getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId)
  },
  touchOpened(workspaceId: string): void {
    getDb().prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(now(), workspaceId)
  },
  getSettings(workspaceId: string): Partial<WorkspaceSettings> {
    const r = getDb().prepare('SELECT settings FROM workspaces WHERE id = ?').get(workspaceId) as
      | { settings: string }
      | undefined
    if (!r) return {}
    try {
      const parsed = JSON.parse(r.settings)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  },
  updateSettings(workspaceId: string, settings: WorkspaceSettings): void {
    getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify(settings), workspaceId)
  }
}

/* ============================================================================
 * Projects (always scoped to the instance's active workspace)
 * ========================================================================== */

export const projects = {
  /** The active workspace's projects; pass `workspaceId` to read another's (export). */
  list(workspaceId?: string): Project[] {
    return getDb()
      .prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY added_at')
      .all(workspaceId ?? requireWorkspaceId())
      .map(mapProject)
  },
  get(pid: string): Project | undefined {
    const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(pid)
    return r ? mapProject(r) : undefined
  },
  getByPath(repoPath: string): Project | undefined {
    const r = getDb()
      .prepare('SELECT * FROM projects WHERE workspace_id = ? AND repo_path = ?')
      .get(requireWorkspaceId(), repoPath)
    return r ? mapProject(r) : undefined
  },
  create(input: { name: string; repoPath: string; workspaceId?: string }): Project {
    const pid = id()
    getDb()
      .prepare('INSERT INTO projects (id, workspace_id, name, repo_path, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(pid, input.workspaceId ?? requireWorkspaceId(), input.name, input.repoPath, now())
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
  /** Hydrate the active workspace's worktrees with batched queries (not one per worktree/pane). */
  list(): Worktree[] {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT w.* FROM worktrees w JOIN projects p ON p.id = w.project_id
         WHERE p.workspace_id = ? ORDER BY w.created_at`
      )
      .all(requireWorkspaceId()) as any[]
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
    return getDb()
      .prepare(
        `SELECT w.id, w.status FROM worktrees w JOIN projects p ON p.id = w.project_id WHERE p.workspace_id = ?`
      )
      .all(requireWorkspaceId()) as Pick<Worktree, 'id' | 'status'>[]
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
    return getDb()
      .prepare(
        `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE p.workspace_id = ? ORDER BY t.created_at, t.id`
      )
      .all(requireWorkspaceId())
      .map(mapTask)
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
 * Full hydrated state
 * ========================================================================== */

/**
 * Persisted DB state; the runtime layers settings (split across the global and
 * workspace stores), the workspace identity, and the in-memory `devServers` /
 * `settingUpWorktrees` registries on top.
 */
export function getAppState(): Omit<AppState, 'devServers' | 'settings' | 'workspace' | 'settingUpWorktrees'> {
  return {
    projects: projects.list(),
    worktrees: worktrees.list(),
    tasks: tasks.list()
  }
}
