import { randomUUID } from 'node:crypto'
import { getDb, writeTx } from './database'
import {
  type Project,
  type ProjectFolder,
  type RailItem,
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
  type TaskCreator,
  type LayoutNode,
  type TaskPatch,
  type WorkspaceInfo,
  type WorkspaceSettings,
  aggregateStatus,
  isPtyTabType
} from '@shared/types'
import { leaf, defaultLayout, layoutCovers } from '../services/layout'
import { placeTab } from '@shared/tabOrder'

export const id = (): string => randomUUID()
const now = (): number => Date.now()

/* ---- row -> entity mappers --------------------------------------------- */

function mapProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    defaultAgentId: r.default_agent_id || 'claude',
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
    seq: r.seq,
    projectId: r.project_id,
    title: r.title,
    description: r.description ?? '',
    tags: JSON.parse(r.tags || '[]') as string[],
    status: r.status as TaskStatus,
    worktreeId: r.worktree_id ?? null,
    createdBy: r.created_by === 'user' || r.created_by === 'agent' ? (r.created_by as TaskCreator) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? null
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

/** Non-throwing form, for callers that have a sane answer before boot resolution. */
export function hasActiveWorkspace(): boolean {
  return activeWorkspaceId !== null
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
  /**
   * Replace the workspace's stored settings blob. Partial because callers patch
   * it — the settings facade merges the keys it is changing over what
   * {@link getSettings} just returned, and an untouched key simply stays absent
   * rather than being written back as an assumed value.
   */
  updateSettings(workspaceId: string, settings: Partial<WorkspaceSettings>): void {
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
  updateAgent(pid: string, patch: { defaultAgentId?: string; agentExecPath?: string }): void {
    writeTx(() => {
      const cur = projects.get(pid)
      if (!cur) return
      getDb()
        .prepare('UPDATE projects SET default_agent_id = ?, agent_exec_path = ? WHERE id = ?')
        .run(patch.defaultAgentId ?? cur.defaultAgentId, patch.agentExecPath ?? cur.agentExecPath ?? '', pid)
    })
  }
}

/* ============================================================================
 * Project folders and the rail's order (scoped to the active workspace)
 *
 * Nothing here writes to `projects`. A folder is a row of its own, and where a
 * project sits (which folder, how far down) is a row in
 * `project_rail_positions`, so filing, reordering and unfiling a project leave
 * the project exactly as it was.
 *
 * The top level is one order shared by folders (`project_folders.position`)
 * and loose projects (their `project_rail_positions.position`). Every write
 * renumbers the whole list it touched, so the two never collide. A project
 * that has never been arranged has no row and is listed last, oldest first.
 * ========================================================================== */

interface RailLayout {
  /** Folders in top-level order, each with its projects in order. */
  folders: ProjectFolder[]
  /** The top level: folders and loose projects, interleaved. */
  rail: RailItem[]
}

function readRailLayout(): RailLayout {
  const db = getDb()
  const workspaceId = requireWorkspaceId()
  const folderRows = db
    .prepare('SELECT * FROM project_folders WHERE workspace_id = ? ORDER BY position, created_at, id')
    .all(workspaceId) as Array<{ id: string; name: string; collapsed: number; position: number }>
  // Arranged projects first, by position; the rest (no row) after, oldest
  // first, with rowid settling a tie the way insertion order would.
  const projectRows = db
    .prepare(
      `SELECT p.id, s.folder_id, s.position FROM projects p
       LEFT JOIN project_rail_positions s ON s.project_id = p.id
       WHERE p.workspace_id = ? ORDER BY s.position IS NULL, s.position, p.added_at, p.rowid`
    )
    .all(workspaceId) as Array<{ id: string; folder_id: string | null; position: number | null }>

  const members = new Map<string, string[]>(folderRows.map((f) => [f.id, []]))
  const top: Array<{ item: RailItem; position: number }> = folderRows.map((f) => ({
    item: { kind: 'folder', id: f.id },
    position: f.position
  }))
  for (const p of projectRows) {
    const filed = p.folder_id === null ? undefined : members.get(p.folder_id)
    if (filed) filed.push(p.id)
    else top.push({ item: { kind: 'project', id: p.id }, position: p.position ?? Number.POSITIVE_INFINITY })
  }
  // A stable sort: where positions tie, folders (pushed first) stay ahead of
  // projects and each kind keeps the order it was read in.
  top.sort((a, b) => (a.position === b.position ? 0 : a.position < b.position ? -1 : 1))

  return {
    folders: folderRows.map((f) => ({
      id: f.id,
      name: f.name,
      collapsed: f.collapsed === 1,
      projectIds: members.get(f.id) ?? []
    })),
    rail: top.map((t) => t.item)
  }
}

function setRailPosition(pid: string, folderId: string | null, position: number): void {
  getDb()
    .prepare(
      `INSERT INTO project_rail_positions (project_id, folder_id, position) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET folder_id = excluded.folder_id, position = excluded.position`
    )
    .run(pid, folderId, position)
}

/** Record `rail` as the top-level order. A project in it is, by that, in no folder. */
function writeRail(rail: RailItem[]): void {
  const setFolder = getDb().prepare('UPDATE project_folders SET position = ? WHERE id = ?')
  rail.forEach((item, i) => {
    if (item.kind === 'folder') setFolder.run(i, item.id)
    else setRailPosition(item.id, null, i)
  })
}

/** Record `projectIds` as the folder's projects, in that order. */
function writeFolderProjects(fid: string, projectIds: string[]): void {
  projectIds.forEach((pid, i) => setRailPosition(pid, fid, i))
}

/** Insert `item` just before the entry `isBefore` matches, or last when none does. */
function insertBefore<T>(list: T[], item: T, isBefore: (entry: T) => boolean): void {
  const at = list.findIndex(isBefore)
  list.splice(at === -1 ? list.length : at, 0, item)
}

export const projectFolders = {
  /** The active workspace's folders, each with its projects in rail order. */
  list(): ProjectFolder[] {
    return readRailLayout().folders
  },
  /** The rail's top level in order: folders and the projects in none of them. */
  rail(): RailItem[] {
    return readRailLayout().rail
  },
  get(fid: string): ProjectFolder | undefined {
    return projectFolders.list().find((f) => f.id === fid)
  },
  /**
   * A new, expanded folder. Given a project it is made to hold, it takes that
   * project's place in the rail (or sits just below the folder the project was
   * in); otherwise it goes at the top, where a folder nobody has placed yet is
   * sure to be seen.
   */
  create(name: string, forProjectId?: string): ProjectFolder {
    const fid = id()
    writeTx(() => {
      const { folders, rail } = readRailLayout()
      getDb()
        .prepare('INSERT INTO project_folders (id, workspace_id, name, position, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(fid, requireWorkspaceId(), name, now())
      const entry: RailItem = { kind: 'folder', id: fid }
      const loose = rail.findIndex((item) => item.kind === 'project' && item.id === forProjectId)
      const holder = folders.find((f) => forProjectId !== undefined && f.projectIds.includes(forProjectId))
      if (loose !== -1) {
        rail.splice(loose, 1, entry)
      } else if (holder) {
        rail.splice(rail.findIndex((item) => item.kind === 'folder' && item.id === holder.id) + 1, 0, entry)
      } else {
        rail.unshift(entry)
      }
      // Members before the top level, so the project is filed by the time
      // writeRail (which no longer lists it) runs.
      if (forProjectId !== undefined && (loose !== -1 || holder)) writeFolderProjects(fid, [forProjectId])
      writeRail(rail)
    })
    return projectFolders.get(fid)!
  },
  rename(fid: string, name: string): void {
    getDb().prepare('UPDATE project_folders SET name = ? WHERE id = ?').run(name, fid)
  },
  /**
   * Delete a folder. Its projects are not deleted: they take the folder's
   * place at the top level, in the order they had inside it.
   */
  remove(fid: string): void {
    writeTx(() => {
      const { folders, rail } = readRailLayout()
      const folder = folders.find((f) => f.id === fid)
      if (!folder) return
      const at = rail.findIndex((item) => item.kind === 'folder' && item.id === fid)
      rail.splice(at, 1, ...folder.projectIds.map((pid): RailItem => ({ kind: 'project', id: pid })))
      // Before the delete: the rows now say "top level", so the cascade from
      // the folder finds none of them.
      writeRail(rail)
      getDb().prepare('DELETE FROM project_folders WHERE id = ?').run(fid)
    })
  },
  setCollapsed(fid: string, collapsed: boolean): void {
    getDb().prepare('UPDATE project_folders SET collapsed = ? WHERE id = ?').run(collapsed ? 1 : 0, fid)
  },
  /**
   * Put a project in `folderId` (null = the top level), just before `beforeId`
   * or last when that is null or names nothing there. `beforeId` is a project
   * in that folder or, at the top level, a folder or a loose project.
   *
   * A project or folder that is gone, or belongs to another workspace, is not
   * in this workspace's layout, so the call does nothing.
   */
  placeProject(pid: string, folderId: string | null, beforeId: string | null): void {
    if (beforeId === pid) return
    writeTx(() => {
      const { folders, rail } = readRailLayout()
      const known =
        rail.some((item) => item.kind === 'project' && item.id === pid) ||
        folders.some((f) => f.projectIds.includes(pid))
      if (!known) return
      const top = rail.filter((item) => !(item.kind === 'project' && item.id === pid))
      if (folderId === null) {
        insertBefore(top, { kind: 'project', id: pid }, (item) => item.id === beforeId)
      } else {
        const folder = folders.find((f) => f.id === folderId)
        if (!folder) return
        const filed = folder.projectIds.filter((x) => x !== pid)
        insertBefore(filed, pid, (x) => x === beforeId)
        writeFolderProjects(folderId, filed)
      }
      writeRail(top)
    })
  },
  /** Put a folder just before the top-level row `beforeId` (a folder or a loose project), or last when null or unknown. */
  placeFolder(fid: string, beforeId: string | null): void {
    if (beforeId === fid) return
    writeTx(() => {
      const { rail } = readRailLayout()
      const entry = rail.find((item) => item.kind === 'folder' && item.id === fid)
      if (!entry) return
      const top = rail.filter((item) => item !== entry)
      insertBefore(top, entry, (item) => item.id === beforeId)
      writeRail(top)
    })
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
  /**
   * Lightweight id+path projection for the palette's file search — it runs on
   * every keystroke and wants only somewhere to point `git ls-files`, not the
   * pane/tab hydration a full list() does.
   */
  listPaths(): Pick<Worktree, 'id' | 'path' | 'projectId'>[] {
    return getDb()
      .prepare(
        `SELECT w.id, w.path, w.project_id AS projectId FROM worktrees w
         JOIN projects p ON p.id = w.project_id WHERE p.workspace_id = ?`
      )
      .all(requireWorkspaceId()) as Pick<Worktree, 'id' | 'path' | 'projectId'>[]
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
    // One transaction: a worktree row without its first pane would hydrate to
    // a layout leaf pointing at a pane that does not exist.
    return writeTx(() => {
      getDb()
        .prepare(
          `INSERT INTO worktrees (id, project_id, kind, name, path, branch, status, task_id, split_direction, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, 'row', ?)`
        )
        .run(wid, input.projectId, input.kind, input.name, input.path, input.branch, null, now())
      // Every Worktree starts with one empty pane (a single-leaf layout) for its first tab.
      const pane = panes.create(wid)
      worktrees.setLayout(wid, leaf(pane.id))
      if (input.taskId) worktrees.linkTask(wid, input.taskId)
      return worktrees.get(wid)!
    })
  },
  /**
   * Delete a Worktree row (panes and tabs cascade) and unlink any task that
   * was started in it. `tasks.worktree_id` has no foreign key, so without the
   * unlink the task would keep pointing at a Worktree that no longer exists:
   * the board would show it as neither linked nor startable.
   */
  remove(wid: string): void {
    writeTx(() => {
      getDb().prepare('UPDATE tasks SET worktree_id = NULL, updated_at = ? WHERE worktree_id = ?').run(now(), wid)
      getDb().prepare('DELETE FROM worktrees WHERE id = ?').run(wid)
    })
  },
  rename(wid: string, name: string): void {
    getDb().prepare('UPDATE worktrees SET name = ? WHERE id = ?').run(name, wid)
  },
  /**
   * Link a Worktree and the task it was started from. The link is stored on
   * both rows (`worktrees.task_id`, `tasks.worktree_id`); they are written
   * together so neither side can point at the other alone.
   */
  linkTask(wid: string, taskId: string): void {
    writeTx(() => {
      getDb().prepare('UPDATE worktrees SET task_id = ? WHERE id = ?').run(taskId, wid)
      getDb().prepare('UPDATE tasks SET worktree_id = ?, updated_at = ? WHERE id = ?').run(wid, now(), taskId)
    })
  },
  updateStatus(wid: string, status: TerminalStatus): void {
    getDb().prepare('UPDATE worktrees SET status = ? WHERE id = ?').run(status, wid)
  },
  /** Sync the stored branch for every worktree checked out at `path`; true if anything changed. */
  /** Ids of this workspace's worktrees whose checkout is `path` (normally one; zero if unknown). */
  idsByPath(path: string): string[] {
    const rows = getDb()
      .prepare(
        `SELECT w.id FROM worktrees w JOIN projects p ON p.id = w.project_id
         WHERE p.workspace_id = ? AND w.path = ?`
      )
      .all(requireWorkspaceId(), path) as { id: string }[]
    return rows.map((r) => r.id)
  },
  /** Ids of every worktree of a project (they share the repo's refs, so a fetch touches all). */
  idsByProject(projectId: string): string[] {
    const rows = getDb().prepare('SELECT id FROM worktrees WHERE project_id = ?').all(projectId) as { id: string }[]
    return rows.map((r) => r.id)
  },
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
    return writeTx(() => {
      const statuses = getDb()
        .prepare(
          "SELECT status FROM tabs WHERE worktree_id = ? AND type IN ('terminal', 'agent') AND status IS NOT NULL"
        )
        .all(wid)
        .map((r: any) => r.status as TerminalStatus)
      const agg = aggregateStatus(statuses)
      worktrees.updateStatus(wid, agg)
      return agg
    })
  }
}

export const panes = {
  create(worktreeId: string): Pane {
    const pid = id()
    writeTx(() => {
      const pos =
        (
          getDb()
            .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM panes WHERE worktree_id = ?')
            .get(worktreeId) as any
        ).m + 1
      getDb().prepare('INSERT INTO panes (id, worktree_id, position, flex) VALUES (?, ?, ?, 1)').run(pid, worktreeId, pos)
    })
    return { id: pid, worktreeId, activeTabId: null, tabs: [] }
  },
  remove(pid: string): void {
    getDb().prepare('DELETE FROM panes WHERE id = ?').run(pid)
  },
  firstPaneId(worktreeId: string): string | undefined {
    const r = getDb().prepare('SELECT id FROM panes WHERE worktree_id = ? ORDER BY position LIMIT 1').get(worktreeId) as any
    return r?.id
  },
  /** The worktree a pane belongs to, or undefined for an unknown pane. */
  worktreeIdOf(pid: string): string | undefined {
    const r = getDb().prepare('SELECT worktree_id FROM panes WHERE id = ?').get(pid) as any
    return r?.worktree_id
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
    return writeTx(() => {
      const pos =
        (
          getDb()
            .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tabs WHERE pane_id = ?')
            .get(input.paneId) as any
        ).m + 1
      const status = isPtyTabType(input.type) ? (input.status ?? 'idle') : null
      getDb()
        .prepare(
          'INSERT INTO tabs (id, worktree_id, pane_id, type, status, position, active, config) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
        )
        .run(tid, input.worktreeId, input.paneId, input.type, status, pos, JSON.stringify(input.config ?? {}))
      tabs.setActive(input.paneId, tid)
      return tabs.get(tid)!
    })
  },
  remove(tid: string): void {
    getDb().prepare('DELETE FROM tabs WHERE id = ?').run(tid)
  },
  setActive(paneId: string, tabId: string): void {
    writeTx(() => {
      const d = getDb()
      d.prepare('UPDATE tabs SET active = 0 WHERE pane_id = ?').run(paneId)
      d.prepare('UPDATE tabs SET active = 1 WHERE id = ?').run(tabId)
    })
  },
  updateStatus(tid: string, status: TerminalStatus): void {
    getDb().prepare('UPDATE tabs SET status = ? WHERE id = ?').run(status, tid)
  },
  updateConfig(tid: string, config: TabConfig): void {
    getDb().prepare('UPDATE tabs SET config = ? WHERE id = ?').run(JSON.stringify(config), tid)
  },
  /**
   * Move a tab into `targetPaneId` (which may be its own pane, to reorder).
   * `slot` is an insertion point in the target's current order (see
   * shared/tabOrder); omitted, the tab goes last. The target's positions are
   * renumbered so the order survives a relaunch.
   */
  move(tid: string, targetPaneId: string, slot?: number): void {
    writeTx(() => {
      const d = getDb()
      const ids = (d.prepare('SELECT id FROM tabs WHERE pane_id = ? ORDER BY position, rowid').all(targetPaneId) as any[]).map(
        (r) => r.id as string
      )
      const order = placeTab(ids, tid, slot ?? ids.length)
      d.prepare('UPDATE tabs SET pane_id = ? WHERE id = ?').run(targetPaneId, tid)
      const set = d.prepare('UPDATE tabs SET position = ? WHERE id = ?')
      order.forEach((tabId, i) => set.run(i, tabId))
      tabs.setActive(targetPaneId, tid)
    })
  },
  inPane(paneId: string): Tab[] {
    return getDb().prepare('SELECT * FROM tabs WHERE pane_id = ? ORDER BY position').all(paneId).map(mapTab)
  }
}

/* ============================================================================
 * Tasks
 * ========================================================================== */

/**
 * Allocate the next human-facing task number: a monotonic counter (settings key
 * 'taskSeq') floored by MAX(seq), so numbers stay globally unique across every
 * workspace, never reuse a deleted task's, and self-heal if the counter row is
 * missing (pre-migration DBs). Must run inside the caller's write transaction.
 */
function nextTaskSeq(db: ReturnType<typeof getDb>): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'taskSeq'").get() as { value: string } | undefined
  const counter = row ? Number.parseInt(row.value, 10) || 0 : 0
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM tasks').get() as { m: number }).m
  const seq = Math.max(counter, maxSeq) + 1
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('taskSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(seq))
  return seq
}

/**
 * Which tasks `tasks.list()` returns: active only (the default — the board,
 * the side panel and `task list`), archived only, or both.
 */
export type TaskArchiveFilter = 'active' | 'archived' | 'all'

export const tasks = {
  list(filter: TaskArchiveFilter = 'active'): Task[] {
    const archived =
      filter === 'active' ? ' AND t.archived_at IS NULL' : filter === 'archived' ? ' AND t.archived_at IS NOT NULL' : ''
    return getDb()
      .prepare(
        `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE p.workspace_id = ?${archived} ORDER BY t.created_at, t.id`
      )
      .all(requireWorkspaceId())
      .map(mapTask)
  },
  get(tid: string): Task | undefined {
    const r = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(tid)
    return r ? mapTask(r) : undefined
  },
  create(input: {
    projectId: string
    title: string
    description?: string
    tags?: string[]
    /** Who is filing it — the cockpit UI or an agent on the CLI. */
    createdBy: TaskCreator
  }): Task {
    const tid = id()
    const t = now()
    const db = getDb()
    // BEGIN IMMEDIATE so the counter read and insert are atomic across the
    // several instances sharing this DB — a deferred transaction could hand two
    // processes the same number.
    db.transaction(() => {
      db.prepare(
        'INSERT INTO tasks (id, seq, project_id, title, description, tags, status, worktree_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)'
      ).run(
        tid,
        nextTaskSeq(db),
        input.projectId,
        input.title,
        input.description ?? '',
        JSON.stringify(input.tags ?? []),
        'todo',
        input.createdBy,
        t,
        t
      )
    }).immediate()
    return tasks.get(tid)!
  },
  update(tid: string, patch: TaskPatch): Task {
    // Read-modify-write under the write lock, so two instances patching
    // different fields of one task cannot lose each other's change.
    return writeTx(() => {
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
    })
  },
  /**
   * Tasks are archived, never deleted: the row (and its number) stays, it just
   * drops out of the default views. Only removing its project deletes it.
   */
  archive(tid: string): void {
    const t = now()
    getDb().prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?').run(t, t, tid)
  },
  unarchive(tid: string): void {
    getDb().prepare('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), tid)
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
  const rail = readRailLayout()
  return {
    projects: projects.list(),
    projectFolders: rail.folders,
    projectRail: rail.rail,
    worktrees: worktrees.list(),
    tasks: tasks.list()
  }
}
