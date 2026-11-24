import { randomUUID } from 'node:crypto'
import { getDb, writeTx } from './database'
import {
  type Repo,
  type Project,
  type RailFolder,
  type RailFolderSpot,
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
import { baseName, projectRootFor } from '../services/project-root'

export const id = (): string => randomUUID()
const now = (): number => Date.now()

/* ---- row -> entity mappers --------------------------------------------- */

function mapRepo(r: any): Repo {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    defaultAgentId: r.default_agent_id || 'claude',
    agentExecPath: r.agent_exec_path || undefined,
    addedAt: r.added_at,
    // Never NULL once the boot heal has run (groupReposIntoProjects).
    projectId: r.project_id ?? ''
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
    config: readTabConfig(r.config)
  }
}

/**
 * Parse a stored tab config. Search tabs saved before the Project→Repo rename
 * hold the scope `'project'`, which meant what `'repo'` means now.
 */
function readTabConfig(raw: string | null): TabConfig {
  const config = JSON.parse(raw || '{}') as TabConfig
  if (config.search && (config.search.scope as string | undefined) === 'project') {
    config.search = { ...config.search, scope: 'repo' }
  }
  return config
}

function mapTask(r: any): Task {
  return {
    id: r.id,
    seq: r.seq,
    projectId: r.project_id,
    repoId: r.repo_id ?? null,
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
 * reads state. Every repo (and, through repos, every worktree and task)
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
  return { id: r.id, name: r.name, lastOpenedAt: r.last_opened_at, repoCount: r.repo_count ?? 0 }
}

export const workspaces = {
  /** Every workspace, most recently opened first (the picker's list). */
  list(): WorkspaceInfo[] {
    return getDb()
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM repos p WHERE p.workspace_id = w.id) AS repo_count
         FROM workspaces w ORDER BY w.last_opened_at DESC, w.created_at`
      )
      .all()
      .map(mapWorkspace)
  },
  get(workspaceId: string): WorkspaceInfo | undefined {
    const r = getDb()
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM repos p WHERE p.workspace_id = w.id) AS repo_count
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
  /** Delete a workspace; its repos (and their worktrees/tasks) cascade away. */
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
 * Repos (always scoped to the instance's active workspace)
 * ========================================================================== */

export const repos = {
  /** The active workspace's repos; pass `workspaceId` to read another's (export). */
  list(workspaceId?: string): Repo[] {
    return getDb()
      .prepare('SELECT * FROM repos WHERE workspace_id = ? ORDER BY added_at')
      .all(workspaceId ?? requireWorkspaceId())
      .map(mapRepo)
  },
  get(rid: string): Repo | undefined {
    const r = getDb().prepare('SELECT * FROM repos WHERE id = ?').get(rid)
    return r ? mapRepo(r) : undefined
  },
  getByPath(repoPath: string): Repo | undefined {
    const r = getDb()
      .prepare('SELECT * FROM repos WHERE workspace_id = ? AND repo_path = ?')
      .get(requireWorkspaceId(), repoPath)
    return r ? mapRepo(r) : undefined
  },
  /**
   * Add a repo. Every repo is in a project: given `projectId` it joins that
   * one, last among its repos (with the same promote rule as
   * {@link projects.addRepo}); otherwise it gets a project of its own, named
   * after it and rooted at its path, which the rail draws as a plain repo row.
   */
  create(input: { name: string; repoPath: string; workspaceId?: string; projectId?: string }): Repo {
    const rid = id()
    writeTx(() => {
      const workspaceId = input.workspaceId ?? requireWorkspaceId()
      const target = input.projectId ? projectRow(input.projectId) : undefined
      if (input.projectId && target?.workspace_id !== workspaceId) {
        throw new Error(`project ${input.projectId} is not in this workspace`)
      }
      const before = target ? memberIds(target.id) : []
      const projectId = target?.id ?? insertProject(workspaceId, input.name, input.repoPath)
      getDb()
        .prepare(
          `INSERT INTO repos (id, workspace_id, name, repo_path, added_at, project_id, project_position)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(rid, workspaceId, input.name, input.repoPath, now(), projectId, before.length)
      if (target) promoteIfFlat(target, before)
    })
    return repos.get(rid)!
  },
  /**
   * Delete a repo's rows (its worktrees cascade; a project it was home of
   * loses its home). Its tasks stay in the project with the repo cleared, and
   * unlinked from the worktrees that went with it. Its project goes too if
   * this was its last repo (taking every task with it), and is demoted if one
   * repo and no home are left.
   */
  remove(rid: string): void {
    writeTx(() => {
      const repo = repoRow(rid)
      if (!repo) return
      // `tasks.worktree_id` has no foreign key: unlink by hand, as worktrees.remove does.
      getDb()
        .prepare(
          `UPDATE tasks SET worktree_id = NULL, updated_at = ?
           WHERE worktree_id IN (SELECT id FROM worktrees WHERE repo_id = ?)`
        )
        .run(now(), rid)
      getDb().prepare('DELETE FROM repos WHERE id = ?').run(rid)
      if (repo.project_id) settleAfterLeave(repo.project_id)
    })
  },
  rename(rid: string, name: string): void {
    getDb().prepare('UPDATE repos SET name = ? WHERE id = ?').run(name, rid)
  },
  updateAgent(rid: string, patch: { defaultAgentId?: string; agentExecPath?: string }): void {
    writeTx(() => {
      const cur = repos.get(rid)
      if (!cur) return
      getDb()
        .prepare('UPDATE repos SET default_agent_id = ?, agent_exec_path = ? WHERE id = ?')
        .run(patch.defaultAgentId ?? cur.defaultAgentId, patch.agentExecPath ?? cur.agentExecPath ?? '', rid)
    })
  }
}

/* ============================================================================
 * Projects (scoped to the active workspace)
 *
 * A project is a root folder plus 1..n member repos, one of which may be its
 * home. Every repo is in exactly one project, so moving a repo is always
 * "from one project to another", and the rules below keep a project's name
 * and root honest as its membership changes:
 *
 *  - A project left with no repos is deleted (its rail row goes with it).
 *  - DEMOTE: a project left with one repo and no home after losing one becomes
 *    a plain repo row again, so it takes that repo's name and path. Otherwise
 *    the rail would draw a flat row carrying a hidden name and root.
 *  - PROMOTE: a flat project (one repo, no home) that gains a second repo is
 *    re-rooted to the folder its repos share, and renamed after that folder if
 *    its name was still the first repo's. It is not given a home: that would
 *    write the managed block into a repo because of a drag.
 *
 * These are rows only. Removing a project here deletes its repos' rows; the
 * watchers and terminals those repos had are the lifecycle layer's to stop
 * (worktree-lifecycle.ts `removeProject`).
 * ========================================================================== */

interface ProjectRow {
  id: string
  workspace_id: string
  name: string
  root_path: string
  home_repo_id: string | null
  managed_block: number
  code_workspace: number
  created_at: number
}

interface RepoRow {
  id: string
  workspace_id: string
  name: string
  repo_path: string
  project_id: string | null
}

function projectRow(pid: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(pid) as ProjectRow | undefined
}

function repoRow(rid: string): RepoRow | undefined {
  return getDb()
    .prepare('SELECT id, workspace_id, name, repo_path, project_id FROM repos WHERE id = ?')
    .get(rid) as RepoRow | undefined
}

/** The order of a project's repos: by hand, then (for any never placed) oldest first. */
const MEMBER_ORDER = 'project_position IS NULL, project_position, added_at, rowid'

/** A project's repo ids in their order. */
function memberIds(pid: string): string[] {
  return (
    getDb().prepare(`SELECT id FROM repos WHERE project_id = ? ORDER BY ${MEMBER_ORDER}`).all(pid) as Array<{
      id: string
    }>
  ).map((r) => r.id)
}

/**
 * Record `repoIds` as the project's repos, in that order (moving any that were
 * elsewhere). A repo that moves takes the tasks filed under it along; its
 * old project keeps its untagged ones. Called only through {@link writeScope},
 * which is what keeps this order and the rail's arrangement of the project the
 * same thing.
 */
function writeMembers(pid: string, repoIds: string[]): void {
  const set = getDb().prepare('UPDATE repos SET project_id = ?, project_position = ? WHERE id = ?')
  const follow = getDb().prepare('UPDATE tasks SET project_id = ? WHERE repo_id = ? AND project_id <> ?')
  repoIds.forEach((rid, i) => {
    set.run(pid, i, rid)
    follow.run(pid, rid, pid)
  })
}

function insertProject(workspaceId: string, name: string, rootPath: string): string {
  const pid = id()
  getDb()
    .prepare('INSERT INTO projects (id, workspace_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(pid, workspaceId, name, rootPath, now())
  return pid
}

function mapProject(r: ProjectRow, repoIds: string[]): Project {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    homeRepoId: r.home_repo_id ?? null,
    managedBlock: r.managed_block === 1,
    codeWorkspace: r.code_workspace === 1,
    repoIds,
    createdAt: r.created_at
  }
}

/**
 * Take a project's name and root from its one repo (the DEMOTE rule). A plain
 * repo row has no list of repos to arrange, so the folders that arranged it
 * go too.
 */
function demote(pid: string, rid: string): void {
  const repo = repoRow(rid)
  if (!repo) return
  getDb().prepare('UPDATE projects SET name = ?, root_path = ? WHERE id = ?').run(repo.name, repo.repo_path, pid)
  getDb().prepare('DELETE FROM rail_folders WHERE project_id = ?').run(pid)
}

/**
 * After a repo left `pid` (moved away or removed): delete the project if that
 * was its last repo, demote it if one repo and no home are left. When its
 * last repo moved to `heir`, the tasks still in it (the untagged ones; the
 * tagged ones went with their repo) move there too rather than going down
 * with the project. A removed last repo has no heir, and its project's tasks
 * go with the project.
 */
function settleAfterLeave(pid: string, heir?: string): void {
  const project = projectRow(pid)
  if (!project) return
  const left = memberIds(pid)
  if (left.length === 0) {
    if (heir && heir !== pid) getDb().prepare('UPDATE tasks SET project_id = ? WHERE project_id = ?').run(heir, pid)
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(pid)
  } else if (left.length === 1 && project.home_repo_id === null) demote(pid, left[0])
}

/**
 * The PROMOTE rule, for `target` having just gained a repo. `before` is who
 * was in it until then; only a flat project (exactly one repo, no home) is
 * promoted.
 */
function promoteIfFlat(target: ProjectRow, before: string[]): void {
  if (before.length !== 1 || target.home_repo_id !== null) return
  const original = repoRow(before[0])
  const paths = memberIds(target.id)
    .map((rid) => repoRow(rid)?.repo_path)
    .filter((p): p is string => !!p)
  const root = projectRootFor(paths)
  const name = original && target.name === original.name ? baseName(root) || target.name : target.name
  getDb().prepare('UPDATE projects SET name = ?, root_path = ? WHERE id = ?').run(name, root, target.id)
}

/** Clear `pid`'s home if it is `rid` (a repo on its way out). */
function dropHome(pid: string, rid: string): void {
  getDb().prepare('UPDATE projects SET home_repo_id = NULL WHERE id = ? AND home_repo_id = ?').run(pid, rid)
}

export const projects = {
  /** The active workspace's projects, oldest first; pass `workspaceId` to read another's (export). */
  list(workspaceId?: string): Project[] {
    const ws = workspaceId ?? requireWorkspaceId()
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at, rowid')
      .all(ws) as ProjectRow[]
    const members = new Map<string, string[]>(rows.map((r) => [r.id, []]))
    const repoRows = db
      .prepare(`SELECT id, project_id FROM repos WHERE workspace_id = ? ORDER BY ${MEMBER_ORDER}`)
      .all(ws) as Array<{ id: string; project_id: string | null }>
    for (const r of repoRows) if (r.project_id) members.get(r.project_id)?.push(r.id)
    return rows.map((r) => mapProject(r, members.get(r.id) ?? []))
  },
  get(pid: string): Project | undefined {
    const r = projectRow(pid)
    return r ? mapProject(r, memberIds(pid)) : undefined
  },
  /**
   * A new project at `rootPath`. Given `repoIds`, those repos move into it in
   * that order (their old projects settle as {@link projects.addRepo}
   * describes); `homeRepoId`, if one of them, becomes its home. With no repos
   * it is empty until one is added.
   */
  create(input: {
    name: string
    rootPath: string
    workspaceId?: string
    repoIds?: string[]
    homeRepoId?: string | null
  }): Project {
    let pid = ''
    writeTx(() => {
      const workspaceId = input.workspaceId ?? requireWorkspaceId()
      pid = insertProject(workspaceId, input.name, input.rootPath)
      const moving = (input.repoIds ?? [])
        .map((rid) => repoRow(rid))
        .filter((r): r is RepoRow => !!r && r.workspace_id === workspaceId)
      writeScope({
        projectId: pid,
        top: moving.map((r): RailItem => ({ kind: 'repo', id: r.id })),
        inside: new Map()
      })
      for (const r of moving) {
        if (!r.project_id) continue
        dropHome(r.project_id, r.id)
        settleAfterLeave(r.project_id, pid)
      }
      if (input.homeRepoId && moving.some((r) => r.id === input.homeRepoId)) {
        getDb().prepare('UPDATE projects SET home_repo_id = ? WHERE id = ?').run(input.homeRepoId, pid)
      }
    })
    return projects.get(pid)!
  },
  rename(pid: string, name: string): void {
    getDb().prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, pid)
  },
  setRoot(pid: string, rootPath: string): void {
    getDb().prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(rootPath, pid)
  },
  /**
   * Make `rid` the project's home, or clear the home with null. The home must
   * be one of the project's repos. Clearing it on a one-repo project makes it
   * flat, so it is demoted.
   */
  setHome(pid: string, rid: string | null): void {
    writeTx(() => {
      if (!projectRow(pid)) return
      const members = memberIds(pid)
      if (rid !== null && !members.includes(rid)) throw new Error(`repo ${rid} is not in project ${pid}`)
      getDb().prepare('UPDATE projects SET home_repo_id = ? WHERE id = ?').run(rid, pid)
      if (rid === null && members.length === 1) demote(pid, members[0])
    })
  },
  setManagedBlock(pid: string, on: boolean): void {
    getDb().prepare('UPDATE projects SET managed_block = ? WHERE id = ?').run(on ? 1 : 0, pid)
  },
  setCodeWorkspace(pid: string, on: boolean): void {
    getDb().prepare('UPDATE projects SET code_workspace = ? WHERE id = ?').run(on ? 1 : 0, pid)
  },
  /**
   * Delete a project's rows and, through the cascade, its tasks, its repos'
   * (and their worktrees) and its rail position. Rows only: stop the repos'
   * watchers and terminals first (worktree-lifecycle.ts `removeProject`).
   */
  remove(pid: string): void {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(pid)
  },
  /**
   * Move a repo into `pid`: into its folder `folderId` (null = the top of the
   * project's repos), just before the row `beforeId` of that list (a repo or
   * a folder; last when null or not there). The same project rearranges. From
   * another project, the repo stops being that project's home if it was, the
   * project it left is deleted or demoted, and `pid` is promoted if it was
   * flat (see the rules above). Repos and projects from different workspaces
   * never mix, and a folder that is not one of `pid`'s own makes the call do
   * nothing.
   */
  addRepo(pid: string, rid: string, beforeId: string | null, folderId: string | null = null): void {
    if (beforeId === rid) return
    writeTx(() => {
      const repo = repoRow(rid)
      const target = projectRow(pid)
      if (!repo || !target || repo.workspace_id !== target.workspace_id) return
      const before = memberIds(pid)
      const scope = scopeOf(readRailLayout(target.workspace_id), pid)
      const list = listIn(scope, folderId)
      if (!list) return
      take(scope, rid)
      insertBefore(list, { kind: 'repo', id: rid }, (item) => item.id === beforeId)
      writeScope(scope)
      const source = repo.project_id
      if (source === pid) return
      if (source) {
        dropHome(source, rid)
        settleAfterLeave(source, pid)
      }
      promoteIfFlat(target, before)
    })
  },
  /**
   * Take a repo out of its project into a new one of its own (named after
   * it, rooted at its path), placed in the rail in `folderId` (null = top
   * level) before `beforeId`. The project it left settles as in
   * {@link projects.addRepo}. A repo already alone in a flat project just
   * has that project placed. Returns the repo's project.
   */
  detachRepo(rid: string, folderId: string | null, beforeId: string | null): Project | undefined {
    let pid: string | undefined
    writeTx(() => {
      const repo = repoRow(rid)
      if (!repo) return
      const source = repo.project_id ? projectRow(repo.project_id) : undefined
      if (source && source.home_repo_id === null && memberIds(source.id).length === 1) {
        pid = source.id
      } else {
        pid = insertProject(repo.workspace_id, repo.name, repo.repo_path)
        writeScope({ projectId: pid, top: [{ kind: 'repo', id: rid }], inside: new Map() })
        if (source) {
          dropHome(source.id, rid)
          settleAfterLeave(source.id, pid)
        }
      }
      railFolders.placeProject(pid, folderId, beforeId)
    })
    return pid ? projects.get(pid) : undefined
  },
  /**
   * Undo a grouping: clear the home, and give every repo but the last a
   * project of its own, in order, where the group sits in the rail. The last
   * repo keeps the group's project, demoted to a plain repo row.
   */
  ungroup(pid: string): void {
    writeTx(() => {
      if (!projectRow(pid)) return
      const members = memberIds(pid)
      getDb().prepare('UPDATE projects SET home_repo_id = NULL WHERE id = ?').run(pid)
      const folderId = readRailLayout().folders.find((f) => f.items.some((item) => item.id === pid))?.id ?? null
      for (const rid of members.slice(0, -1)) projects.detachRepo(rid, folderId, pid)
      if (members.length === 1) demote(pid, members[0])
    })
  }
}

/* ============================================================================
 * Rail folders and the rail's arrangement (scoped to the active workspace)
 *
 * The rail orders its rows by hand, in lists. There are two kinds of list:
 *
 *  - the rail's own: the top level and every folder of projects. Their rows
 *    are projects and folders of projects.
 *  - a project's: the top of its repos and every folder among them. Their
 *    rows are that project's repos and its folders.
 *
 * A folder belongs to one kind for good (`rail_folders.project_id`: NULL, or
 * the project) and nests only in folders of the same kind and project.
 *
 * Where a row sits is a row of its own: a folder's is its `parent_id` and
 * `position`, a project's is in `rail_positions`, a repo's in
 * `rail_repo_positions`. So filing, reordering and unfiling leave projects
 * and repos as they were, with one exception that predates folders: a
 * project's repos have a flat hand order (`repos.project_position`, which is
 * `Project.repoIds`), and it is kept equal to the arrangement read top to
 * bottom. Without folders that is the arrangement.
 *
 * Every write renumbers the whole of the lists it touched, so rows of
 * different kinds sharing a list never collide. A row that has never been
 * arranged has no position and is listed last in its top-level list, oldest
 * first.
 * ========================================================================== */

interface RailLayout {
  /** Every folder of the workspace, of either kind, with what is filed in it. */
  folders: RailFolder[]
  /** The rail's top level: folders of projects and loose projects, interleaved. */
  rail: RailItem[]
  /** Each project's top-level list: its folders and its repos in none (the home repo included). */
  members: Map<string, RailItem[]>
}

function readRailLayout(workspaceId = requireWorkspaceId()): RailLayout {
  const db = getDb()
  const folderRows = db
    .prepare(
      `SELECT id, name, collapsed, position, parent_id, project_id FROM rail_folders
       WHERE workspace_id = ? ORDER BY position, created_at, id`
    )
    .all(workspaceId) as Array<{
    id: string
    name: string
    collapsed: number
    position: number
    parent_id: string | null
    project_id: string | null
  }>
  // Arranged rows first, by position; the rest (no row) after, oldest first,
  // with rowid settling a tie the way insertion order would.
  const projectRows = db
    .prepare(
      `SELECT p.id, s.folder_id, s.position FROM projects p
       LEFT JOIN rail_positions s ON s.project_id = p.id
       WHERE p.workspace_id = ? ORDER BY s.position IS NULL, s.position, p.created_at, p.rowid`
    )
    .all(workspaceId) as Array<{ id: string; folder_id: string | null; position: number | null }>
  const repoRows = db
    .prepare(
      `SELECT r.id, r.project_id, s.folder_id, s.position FROM repos r
       LEFT JOIN rail_repo_positions s ON s.repo_id = r.id
       WHERE r.workspace_id = ? AND r.project_id IS NOT NULL
       ORDER BY s.position IS NULL, s.position, r.project_position IS NULL, r.project_position, r.added_at, r.rowid`
    )
    .all(workspaceId) as Array<{ id: string; project_id: string; folder_id: string | null; position: number | null }>

  // Lists by key: a folder's id, or the top of a scope.
  const RAIL_TOP = ''
  const topOf = (projectId: string | null): string => (projectId === null ? RAIL_TOP : `project:${projectId}`)
  const folderById = new Map(folderRows.map((f) => [f.id, f]))
  const unplaced = Number.POSITIVE_INFINITY
  const lists = new Map<string, Array<{ item: RailItem; position: number }>>()
  const add = (key: string, item: RailItem, position: number): void => {
    const list = lists.get(key)
    if (list) list.push({ item, position })
    else lists.set(key, [{ item, position }])
  }
  // A row filed in a folder that is not one of its own kind (which no write
  // here produces) reads as never arranged, at the top of its own lists.
  for (const f of folderRows) {
    const parent = f.parent_id === null ? undefined : folderById.get(f.parent_id)
    const nested = !!parent && parent.project_id === f.project_id
    add(nested ? parent.id : topOf(f.project_id), { kind: 'folder', id: f.id }, f.position)
  }
  for (const p of projectRows) {
    const folder = p.folder_id === null ? undefined : folderById.get(p.folder_id)
    const stray = p.folder_id !== null && folder?.project_id !== null
    const key = folder && !stray ? folder.id : RAIL_TOP
    add(key, { kind: 'project', id: p.id }, stray ? unplaced : (p.position ?? unplaced))
  }
  for (const r of repoRows) {
    const folder = r.folder_id === null ? undefined : folderById.get(r.folder_id)
    const stray = r.folder_id !== null && folder?.project_id !== r.project_id
    const key = folder && !stray ? folder.id : topOf(r.project_id)
    add(key, { kind: 'repo', id: r.id }, stray ? unplaced : (r.position ?? unplaced))
  }
  // A stable sort: where positions tie, folders (added first) stay ahead of
  // the other rows and each kind keeps the order it was read in.
  for (const list of lists.values()) {
    list.sort((a, b) => (a.position === b.position ? 0 : a.position < b.position ? -1 : 1))
  }

  // Walk down from each top, so that every folder is listed exactly once
  // whatever the rows say: a folder whose parents loop back on themselves is
  // reachable from no top, and is put at the top of its own scope instead.
  const items = new Map<string, RailItem[]>()
  const parentOf = new Map<string, string | null>()
  const settle = (key: string, folderId: string | null): RailItem[] => {
    const out: RailItem[] = []
    for (const { item } of lists.get(key) ?? []) {
      if (item.kind === 'folder') {
        if (parentOf.has(item.id)) continue
        parentOf.set(item.id, folderId)
      }
      out.push(item)
    }
    items.set(key, out)
    for (const item of out) if (item.kind === 'folder') settle(item.id, item.id)
    return out
  }
  const rail = settle(RAIL_TOP, null)
  const members = new Map<string, RailItem[]>(projectRows.map((p) => [p.id, settle(topOf(p.id), null)]))
  for (const f of folderRows) {
    if (parentOf.has(f.id)) continue
    parentOf.set(f.id, null)
    const top = f.project_id === null ? rail : members.get(f.project_id)
    top?.push({ kind: 'folder', id: f.id })
    settle(f.id, f.id)
  }

  return {
    folders: folderRows.map((f) => ({
      id: f.id,
      name: f.name,
      collapsed: f.collapsed === 1,
      projectId: f.project_id,
      parentId: parentOf.get(f.id) ?? null,
      items: items.get(f.id) ?? []
    })),
    rail,
    members
  }
}

/**
 * One scope's arrangement, copied out to be edited and written back: the
 * rail's own lists (`projectId` null) or one project's.
 */
interface RailScope {
  projectId: string | null
  top: RailItem[]
  /** Every folder of the scope, by id. */
  inside: Map<string, RailItem[]>
}

function scopeOf(layout: RailLayout, projectId: string | null): RailScope {
  return {
    projectId,
    top: [...(projectId === null ? layout.rail : (layout.members.get(projectId) ?? []))],
    inside: new Map(layout.folders.filter((f) => f.projectId === projectId).map((f) => [f.id, [...f.items]]))
  }
}

/** A list of the scope: a folder's, or its top for null. Undefined for a folder the scope does not have. */
function listIn(scope: RailScope, folderId: string | null): RailItem[] | undefined {
  return folderId === null ? scope.top : scope.inside.get(folderId)
}

/** Where a row sits in the scope, if it is in it. */
function locate(scope: RailScope, rowId: string): { list: RailItem[]; index: number } | undefined {
  for (const list of [scope.top, ...scope.inside.values()]) {
    const index = list.findIndex((item) => item.id === rowId)
    if (index !== -1) return { list, index }
  }
  return undefined
}

/** Take a row out of whichever list of the scope holds it. */
function take(scope: RailScope, rowId: string): void {
  const at = locate(scope, rowId)
  if (at) at.list.splice(at.index, 1)
}

/** Whether folder `fid` is `ancestorId` or somewhere inside it. */
function isWithin(scope: RailScope, ancestorId: string, fid: string): boolean {
  if (ancestorId === fid) return true
  return (scope.inside.get(ancestorId) ?? []).some((item) => item.kind === 'folder' && isWithin(scope, item.id, fid))
}

/** The scope's repos, read top to bottom through its folders. */
function reposInOrder(scope: RailScope): string[] {
  const out: string[] = []
  const walk = (list: RailItem[]): void => {
    for (const item of list) {
      if (item.kind === 'repo') out.push(item.id)
      else if (item.kind === 'folder') walk(scope.inside.get(item.id) ?? [])
    }
  }
  walk(scope.top)
  return out
}

/**
 * Record a scope as edited: every row's list and place in it. For a project's
 * scope that also makes each repo in it a member of the project, in the order
 * the arrangement reads top to bottom (see {@link writeMembers}).
 */
function writeScope(scope: RailScope): void {
  const db = getDb()
  const setFolder = db.prepare('UPDATE rail_folders SET parent_id = ?, position = ? WHERE id = ?')
  const setProject = db.prepare(
    `INSERT INTO rail_positions (project_id, folder_id, position) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET folder_id = excluded.folder_id, position = excluded.position`
  )
  const setRepo = db.prepare(
    `INSERT INTO rail_repo_positions (repo_id, folder_id, position) VALUES (?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET folder_id = excluded.folder_id, position = excluded.position`
  )
  const write = (folderId: string | null, list: RailItem[]): void =>
    list.forEach((item, i) => {
      if (item.kind === 'folder') setFolder.run(folderId, i, item.id)
      else if (item.kind === 'project') setProject.run(item.id, folderId, i)
      else setRepo.run(item.id, folderId, i)
    })
  write(null, scope.top)
  for (const [fid, list] of scope.inside) write(fid, list)
  if (scope.projectId !== null) writeMembers(scope.projectId, reposInOrder(scope))
}

/** Insert `item` just before the entry `isBefore` matches, or last when none does. */
function insertBefore<T>(list: T[], item: T, isBefore: (entry: T) => boolean): void {
  const at = list.findIndex(isBefore)
  list.splice(at === -1 ? list.length : at, 0, item)
}

/** The part of a layout the renderer is sent per project: only the projects with folders have one. */
function projectItemsOf(layout: RailLayout): Record<string, RailItem[]> {
  const out: Record<string, RailItem[]> = {}
  for (const folder of layout.folders) {
    if (folder.projectId === null || out[folder.projectId]) continue
    out[folder.projectId] = layout.members.get(folder.projectId) ?? []
  }
  return out
}

export const railFolders = {
  /** The active workspace's folders, of projects and of a project's repos alike, each with its rows in order. */
  list(): RailFolder[] {
    return readRailLayout().folders
  },
  /** The rail's top level in order: folders of projects and the projects in none of them. */
  rail(): RailItem[] {
    return readRailLayout().rail
  },
  /**
   * The top of each project's own list, for the projects that have folders
   * among their repos (the rest have nothing to say beyond `repoIds`).
   */
  projectItems(): Record<string, RailItem[]> {
    return projectItemsOf(readRailLayout())
  },
  get(fid: string): RailFolder | undefined {
    return railFolders.list().find((f) => f.id === fid)
  },
  /**
   * A new, expanded folder.
   *
   * It goes last in its list, the way a new project or repo does, so nothing
   * already arranged moves to make room for it:
   *
   * - No `spot`: a folder of projects, last in the rail.
   * - `holding` a row: it takes that row's place, in whatever list the row is
   *   in, and holds it. A project gives a folder of projects, a repo a folder
   *   among its project's repos.
   * - `parentId`: last inside that folder (which is opened), as a folder of
   *   the same kind.
   * - `projectId`: last among that project's repos.
   *
   * A spot that names nothing in this workspace gives a folder of projects,
   * last in the rail.
   */
  create(name: string, spot?: RailFolderSpot): RailFolder {
    const fid = id()
    writeTx(() => {
      const layout = readRailLayout()
      const parent = spot && 'parentId' in spot ? layout.folders.find((f) => f.id === spot.parentId) : undefined
      let holding = spot && 'holding' in spot && spot.holding.kind !== 'folder' ? spot.holding : null
      let projectId: string | null = null
      if (parent) projectId = parent.projectId
      else if (spot && 'projectId' in spot && layout.members.has(spot.projectId)) projectId = spot.projectId
      else if (holding?.kind === 'repo') {
        const owner = repoRow(holding.id)?.project_id
        if (owner && layout.members.has(owner)) projectId = owner
        else holding = null
      }
      const scope = scopeOf(layout, projectId)
      getDb()
        .prepare(
          `INSERT INTO rail_folders (id, workspace_id, name, position, created_at, project_id)
           VALUES (?, ?, ?, 0, ?, ?)`
        )
        .run(fid, requireWorkspaceId(), name, now(), projectId)
      const entry: RailItem = { kind: 'folder', id: fid }
      const filed: RailItem[] = []
      scope.inside.set(fid, filed)
      const at = holding ? locate(scope, holding.id) : undefined
      if (holding && at) {
        at.list.splice(at.index, 1, entry)
        filed.push(holding)
      } else if (parent) {
        scope.inside.get(parent.id)?.push(entry)
        getDb().prepare('UPDATE rail_folders SET collapsed = 0 WHERE id = ?').run(parent.id)
      } else {
        scope.top.push(entry)
      }
      writeScope(scope)
    })
    return railFolders.get(fid)!
  },
  rename(fid: string, name: string): void {
    getDb().prepare('UPDATE rail_folders SET name = ? WHERE id = ?').run(name, fid)
  },
  /**
   * Delete a folder. Nothing in it is deleted: its rows, folders included,
   * take its place in the list it was in, in the order they had inside it.
   */
  remove(fid: string): void {
    writeTx(() => {
      const layout = readRailLayout()
      const folder = layout.folders.find((f) => f.id === fid)
      if (!folder) return
      const scope = scopeOf(layout, folder.projectId)
      const rows = scope.inside.get(fid) ?? []
      scope.inside.delete(fid)
      const at = locate(scope, fid)
      if (at) at.list.splice(at.index, 1, ...rows)
      else scope.top.push(...rows)
      // Before the delete: the rows now say where they went, so the cascade
      // from the folder finds none of them.
      writeScope(scope)
      getDb().prepare('DELETE FROM rail_folders WHERE id = ?').run(fid)
    })
  },
  setCollapsed(fid: string, collapsed: boolean): void {
    getDb().prepare('UPDATE rail_folders SET collapsed = ? WHERE id = ?').run(collapsed ? 1 : 0, fid)
  },
  /**
   * Put a project in the folder of projects `folderId` (null = the rail's top
   * level), just before `beforeId` or last when that is null or names nothing
   * there. `beforeId` is a row of that list: a project or a folder.
   *
   * A project or folder that is gone, belongs to another workspace, or (the
   * folder) arranges a project's repos is not in this workspace's rail, so
   * the call does nothing.
   */
  placeProject(pid: string, folderId: string | null, beforeId: string | null): void {
    if (beforeId === pid) return
    writeTx(() => {
      const scope = scopeOf(readRailLayout(), null)
      const list = listIn(scope, folderId)
      if (!list || !locate(scope, pid)) return
      take(scope, pid)
      insertBefore(list, { kind: 'project', id: pid }, (item) => item.id === beforeId)
      writeScope(scope)
    })
  },
  /**
   * Put a folder in `parentId`, a folder of its own kind (null = the top of
   * its list: the rail's for a folder of projects, its project's for a folder
   * of repos), just before the row `beforeId` there or last when that is null
   * or names nothing there. A folder never goes inside itself, into a folder
   * of the other kind, or into another project's.
   */
  placeFolder(fid: string, parentId: string | null, beforeId: string | null): void {
    if (beforeId === fid) return
    writeTx(() => {
      const layout = readRailLayout()
      const folder = layout.folders.find((f) => f.id === fid)
      if (!folder) return
      const scope = scopeOf(layout, folder.projectId)
      const list = listIn(scope, parentId)
      if (!list || (parentId !== null && isWithin(scope, fid, parentId))) return
      take(scope, fid)
      insertBefore(list, { kind: 'folder', id: fid }, (item) => item.id === beforeId)
      writeScope(scope)
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

/**
 * The worktree columns plus `project_ref`: a folder session's own project, else
 * its repo's. Reads that hydrate a Worktree select through this so `projectId`
 * follows a repo that moves between projects without a write per worktree.
 */
const WORKTREE_SELECT = `SELECT w.*, COALESCE(w.project_id, r.project_id) AS project_ref
  FROM worktrees w LEFT JOIN repos r ON r.id = w.repo_id`

/** Scope a {@link WORKTREE_SELECT} to a workspace: through the repo, or a folder session's project. */
const IN_WORKSPACE = `COALESCE(r.workspace_id, (SELECT j.workspace_id FROM projects j WHERE j.id = w.project_id)) = ?`

function buildWorktree(r: any, panes: Pane[]): Worktree {
  return {
    id: r.id,
    repoId: r.repo_id ?? null,
    projectId: r.project_ref ?? r.project_id ?? '',
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
      .prepare(`${WORKTREE_SELECT} WHERE ${IN_WORKSPACE} ORDER BY w.created_at`)
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
      .prepare(`SELECT w.id, w.status FROM worktrees w LEFT JOIN repos r ON r.id = w.repo_id WHERE ${IN_WORKSPACE}`)
      .all(requireWorkspaceId()) as Pick<Worktree, 'id' | 'status'>[]
  },
  /**
   * Lightweight id+path projection for the palette's file search — it runs on
   * every keystroke and wants only somewhere to point `git ls-files`, not the
   * pane/tab hydration a full list() does.
   */
  listPaths(): Pick<Worktree, 'id' | 'path' | 'repoId' | 'projectId' | 'kind'>[] {
    return getDb()
      .prepare(
        `SELECT w.id, w.path, w.repo_id AS repoId, COALESCE(w.project_id, r.project_id) AS projectId, w.kind
         FROM worktrees w LEFT JOIN repos r ON r.id = w.repo_id WHERE ${IN_WORKSPACE}`
      )
      .all(requireWorkspaceId()) as Pick<Worktree, 'id' | 'path' | 'repoId' | 'projectId' | 'kind'>[]
  },
  get(wid: string): Worktree | undefined {
    const r = getDb().prepare(`${WORKTREE_SELECT} WHERE w.id = ?`).get(wid)
    return r ? hydrateWorktree(r) : undefined
  },
  /** A project's folder session, if it has one. */
  folderOf(pid: string): Worktree | undefined {
    const r = getDb()
      .prepare(`${WORKTREE_SELECT} WHERE w.project_id = ? AND w.kind = 'folder' ORDER BY w.created_at LIMIT 1`)
      .get(pid)
    return r ? hydrateWorktree(r) : undefined
  },
  /**
   * Add a worktree. A repo's checkout names its `repoId`; a `folder` session
   * names its `projectId` instead (and no repo).
   */
  create(input: {
    repoId: string | null
    projectId?: string | null
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
          `INSERT INTO worktrees (id, repo_id, project_id, kind, name, path, branch, status, task_id, split_direction, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, 'row', ?)`
        )
        .run(
          wid,
          input.repoId,
          input.projectId ?? null,
          input.kind,
          input.name,
          input.path,
          input.branch,
          null,
          now()
        )
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
  /** Point a folder session at its project's (new) root. */
  setPath(wid: string, path: string): void {
    getDb().prepare('UPDATE worktrees SET path = ? WHERE id = ?').run(path, wid)
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
        `SELECT w.id FROM worktrees w LEFT JOIN repos r ON r.id = w.repo_id
         WHERE ${IN_WORKSPACE} AND w.path = ?`
      )
      .all(requireWorkspaceId(), path) as { id: string }[]
    return rows.map((r) => r.id)
  },
  /** Ids of every worktree of a repo (they share the repo's refs, so a fetch touches all). */
  idsByRepo(repoId: string): string[] {
    const rows = getDb().prepare('SELECT id FROM worktrees WHERE repo_id = ?').all(repoId) as { id: string }[]
    return rows.map((r) => r.id)
  },
  updateBranchByPath(path: string, branch: string): boolean {
    const r = getDb()
      // A folder session has no branch, even when its root is also a checkout.
      .prepare("UPDATE worktrees SET branch = ? WHERE path = ? AND branch <> ? AND kind <> 'folder'")
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

/** Refuse a repo that is not one of the project's (a tag never takes a task across projects). */
function assertRepoInProject(rid: string, pid: string): void {
  const repo = repoRow(rid)
  if (!repo) throw new Error(`repo ${rid} not found`)
  if (repo.project_id !== pid) throw new Error(`repo ${repo.name} is not in this task's project`)
}

/**
 * The repo a task is pinned to: while it has a live worktree in a repo (its
 * link resolves to a worktree with a repo), its repo follows that worktree
 * and nothing else may change it. Null when it is free to move.
 */
function repoLockOf(task: Task): { repoId: string; repoName: string } | null {
  if (!task.worktreeId) return null
  const row = getDb()
    .prepare('SELECT w.repo_id, r.name FROM worktrees w JOIN repos r ON r.id = w.repo_id WHERE w.id = ?')
    .get(task.worktreeId) as { repo_id: string; name: string } | undefined
  return row ? { repoId: row.repo_id, repoName: row.name } : null
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
  /**
   * File a task in a project, under `repoId` (one of the project's repos) or,
   * with null, under none.
   */
  create(input: {
    projectId: string
    repoId?: string | null
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
      if (!projectRow(input.projectId)) throw new Error(`project ${input.projectId} not found`)
      const repoId = input.repoId ?? null
      if (repoId !== null) assertRepoInProject(repoId, input.projectId)
      db.prepare(
        'INSERT INTO tasks (id, seq, project_id, repo_id, title, description, tags, status, worktree_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)'
      ).run(
        tid,
        nextTaskSeq(db),
        input.projectId,
        repoId,
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
      const repoId = patch.repoId === undefined ? cur.repoId : patch.repoId
      if (repoId !== cur.repoId) {
        const lock = repoLockOf(cur)
        if (lock && repoId !== lock.repoId) {
          throw new Error(`task #${cur.seq} has a worktree in ${lock.repoName}; its repo follows that worktree`)
        }
        if (repoId !== null) assertRepoInProject(repoId, cur.projectId)
      }
      getDb()
        .prepare(
          'UPDATE tasks SET title = ?, description = ?, tags = ?, status = ?, repo_id = ?, updated_at = ? WHERE id = ?'
        )
        .run(
          patch.title ?? cur.title,
          patch.description ?? cur.description,
          JSON.stringify(patch.tags ?? cur.tags),
          patch.status ?? cur.status,
          repoId,
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
    repos: repos.list(),
    projects: projects.list(),
    railFolders: rail.folders,
    railItems: rail.rail,
    railProjectItems: projectItemsOf(rail),
    worktrees: worktrees.list(),
    tasks: tasks.list()
  }
}
