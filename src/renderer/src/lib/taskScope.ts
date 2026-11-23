import type { Project, Repo, Task, Worktree } from '@shared/types'

/**
 * Where tasks sit within a project, for every view that shows them (board,
 * tracker, archived list, New Worktree). Pure: everything comes in as
 * arguments, so the rules are tested here and the components only render.
 *
 * The rules, from the board spec:
 *  - A project is single when it has fewer than two repos. A single project
 *    shows no lanes, no repo chips and no repo pickers.
 *  - A task's lane is its repo when that repo is in the project, else the
 *    Project lane (a stale or foreign tag reads as none; no task is dropped).
 *  - A project's repos are listed home first, then the rest in hand order.
 *  - A task with a live worktree is locked to that worktree's repo.
 */

/** The fields of the store these helpers read. */
export interface TaskScopeState {
  projects: Project[]
  repos: Repo[]
  worktrees: Worktree[]
  activeProjectId: string | null
  activeWorktreeId: string | null
}

/** The untagged lane's key. */
export const PROJECT_LANE = 'project'

/** Fewer than two repos: one list, and the repo tag is invisible. */
export function isSingleProject(project: Pick<Project, 'repoIds'>): boolean {
  return project.repoIds.length < 2
}

/** The project's repos, home first, then its hand order. Skips ids with no repo. */
export function projectRepos(project: Project, repos: Repo[]): Repo[] {
  const byId = new Map(repos.map((r) => [r.id, r]))
  const order =
    project.homeRepoId && project.repoIds.includes(project.homeRepoId)
      ? [project.homeRepoId, ...project.repoIds.filter((id) => id !== project.homeRepoId)]
      : project.repoIds
  return order.map((id) => byId.get(id)).filter((r): r is Repo => !!r)
}

export interface BoardLane {
  /** The repo id, or {@link PROJECT_LANE} for the untagged lane. Also the hover-cell key prefix. */
  key: string
  /** What a drop here sets the task's repo to: null in the Project lane. */
  repoId: string | null
  kind: 'project' | 'home' | 'repo'
  /** 'Project', or the repo's name. */
  name: string
  /** This lane's tasks, in store order. */
  tasks: Task[]
}

/** Rule 3: the key of the lane a task sits in. */
export function taskLaneKey(task: Pick<Task, 'repoId'>, project: Pick<Project, 'repoIds'>): string {
  return task.repoId && project.repoIds.includes(task.repoId) ? task.repoId : PROJECT_LANE
}

/**
 * The board's lanes. Multi: the Project lane, then a lane per repo in
 * {@link projectRepos} order. Single: one lane holding every task, filed
 * under the sole repo (null with none).
 */
export function boardLanes(project: Project, repos: Repo[], tasks: Task[]): { single: boolean; lanes: BoardLane[] } {
  const mine = tasks.filter((t) => t.projectId === project.id)
  if (isSingleProject(project)) {
    const only = projectRepos(project, repos)[0]
    return {
      single: true,
      lanes: [
        {
          key: PROJECT_LANE,
          repoId: only?.id ?? null,
          kind: 'project',
          name: 'Project',
          tasks: mine
        }
      ]
    }
  }
  const lanes: BoardLane[] = [
    {
      key: PROJECT_LANE,
      repoId: null,
      kind: 'project',
      name: 'Project',
      tasks: mine.filter((t) => taskLaneKey(t, project) === PROJECT_LANE)
    }
  ]
  for (const r of projectRepos(project, repos)) {
    lanes.push({
      key: r.id,
      repoId: r.id,
      kind: r.id === project.homeRepoId ? 'home' : 'repo',
      name: r.name,
      tasks: mine.filter((t) => t.repoId === r.id)
    })
  }
  return { single: false, lanes }
}

/** Rule 5: the worktree that pins this task's repo, else null. */
export function repoLock(task: Pick<Task, 'worktreeId'>, worktrees: Worktree[]): Worktree | null {
  if (!task.worktreeId) return null
  const wt = worktrees.find((w) => w.id === task.worktreeId)
  return wt && wt.repoId !== null ? wt : null
}

/**
 * A project's own session: its home repo's root worktree, else its folder
 * session. A plain one-repo project has neither, and its session is its
 * repo's. (The store's `projectSession` re-exports this.)
 */
export function projectSessionOf(projects: Project[], worktrees: Worktree[], projectId: string): Worktree | undefined {
  const project = projects.find((p) => p.id === projectId)
  if (!project) return undefined
  const repoSession = (repoId: string): Worktree | undefined => {
    const mine = worktrees.filter((w) => w.repoId === repoId)
    return mine.find((w) => w.kind === 'root') ?? mine[0]
  }
  if (project.homeRepoId) return repoSession(project.homeRepoId)
  return (
    worktrees.find((w) => w.kind === 'folder' && w.projectId === projectId) ??
    (project.repoIds.length === 1 ? repoSession(project.repoIds[0]) : undefined)
  )
}

/**
 * The repo the tracker leads with; null = show the whole project as one list.
 * Null with no active project, in a single project, when the active worktree
 * has no repo, or when the active worktree IS the project session. Otherwise
 * the active worktree's repo (a linked worktree of the home repo leads with
 * the home repo).
 */
export function trackerFocusRepoId(s: TaskScopeState): string | null {
  const project = s.projects.find((p) => p.id === s.activeProjectId)
  if (!project || isSingleProject(project)) return null
  const wt = s.worktrees.find((w) => w.id === s.activeWorktreeId)
  if (!wt?.repoId || !project.repoIds.includes(wt.repoId)) return null
  if (projectSessionOf(s.projects, s.worktrees, project.id)?.id === wt.id) return null
  return wt.repoId
}

/** What quick capture and the board's single lane file under. */
export function captureRepoId(s: TaskScopeState): string | null {
  const project = s.projects.find((p) => p.id === s.activeProjectId)
  if (!project) return null
  if (isSingleProject(project)) return projectRepos(project, s.repos)[0]?.id ?? null
  return trackerFocusRepoId(s)
}

/** Where a new worktree goes: a repo, or (later, #403) the whole project. */
export type WorktreeTarget = { kind: 'repo'; repoId: string } | { kind: 'project' }

/** The targets New Worktree offers for a project. v1 returns repo targets only. */
export function worktreeTargets(project: Project, repos: Repo[]): WorktreeTarget[] {
  return projectRepos(project, repos).map((r) => ({
    kind: 'repo',
    repoId: r.id
  }))
}

/** A target as a `<select>` option value: `repo:{id}` or `project`. */
export function targetValue(t: WorktreeTarget): string {
  return t.kind === 'repo' ? `repo:${t.repoId}` : 'project'
}

/** The inverse of {@link targetValue}; null for '' or anything unknown. */
export function parseTargetValue(v: string): WorktreeTarget | null {
  if (v === 'project') return { kind: 'project' }
  if (v.startsWith('repo:') && v.length > 5) return { kind: 'repo', repoId: v.slice(5) }
  return null
}

/**
 * The repo New Worktree is implied to target, or null when the user must
 * pick: the given repo, else the task's repo when it is in its project, else
 * the project's only repo.
 */
export function impliedWorktreeRepoId(
  given: Pick<Repo, 'id'> | undefined,
  task: Pick<Task, 'repoId'> | undefined,
  project: Pick<Project, 'repoIds'> | undefined
): string | null {
  if (given) return given.id
  if (task?.repoId && project?.repoIds.includes(task.repoId)) return task.repoId
  if (project && project.repoIds.length === 1) return project.repoIds[0]
  return null
}
