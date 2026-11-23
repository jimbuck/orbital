/**
 * What an agent needs to know about the project its session is in: which
 * role the session plays (the project's own session, or one member repo's),
 * the directories it should be able to reach, and a live map of the member
 * repos (remote, branch, dirty state, worktrees, tasks).
 *
 * The role and directory rules are pure so they can be tested on plain data.
 * The live map shells out to git at agent launch and from `orbital project`,
 * so every probe runs in parallel under a short timeout and degrades to
 * "unknown" rather than failing the launch.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { Project, Repo, Task, Worktree } from '@shared/types'
import { tables } from '../runtime'

/* ---- roles ---------------------------------------------------------------- */

/**
 * A session's place in its project.
 *
 * - `project`: the project's own session. A folder session, or a worktree of
 *   the home repo when the project has other members too.
 * - `member`: a worktree of a member repo that is not the home, in a project
 *   with more than one repo or with a home.
 *
 * Null for everything else (a plain one-repo project, or a home repo that is
 * the project's only repo): those sessions get no project context at all.
 */
export type SessionRole =
  | { kind: 'project'; project: Project; members: Repo[]; home: Repo | null }
  | { kind: 'member'; project: Project; members: Repo[]; home: Repo | null; repo: Repo }

export function sessionRole(
  worktree: Pick<Worktree, 'kind' | 'repoId'>,
  project: Project | undefined,
  repos: Repo[]
): SessionRole | null {
  if (!project) return null
  const byId = new Map(repos.map((r) => [r.id, r]))
  const members = project.repoIds.map((id) => byId.get(id)).filter((r): r is Repo => !!r)
  const home = project.homeRepoId ? (byId.get(project.homeRepoId) ?? null) : null
  if (worktree.kind === 'folder') return { kind: 'project', project, members, home }
  if (!worktree.repoId) return null
  if (home && worktree.repoId === home.id) {
    return members.length > 1 ? { kind: 'project', project, members, home } : null
  }
  const repo = byId.get(worktree.repoId)
  if (!repo || (members.length < 2 && !home)) return null
  return { kind: 'member', project, members, home, repo }
}

/** Path comparison that ignores case on Windows and a trailing separator. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/**
 * The directories an agent in this session should be able to read and edit
 * besides its own: every other member repo for the project session, the home
 * repo for a member session. Never the session's own repo (a linked worktree
 * of the home must not reach into the home's main checkout) and never the cwd.
 */
export function agentAddDirs(role: SessionRole | null, worktree: Pick<Worktree, 'repoId' | 'path'>): string[] {
  if (!role) return []
  const candidates =
    role.kind === 'project'
      ? role.members.filter((r) => r.id !== worktree.repoId).map((r) => r.repoPath)
      : role.home && role.home.id !== worktree.repoId
        ? [role.home.repoPath]
        : []
  const out: string[] = []
  for (const dir of candidates) {
    if (!dir || samePath(dir, worktree.path) || out.some((d) => samePath(d, dir))) continue
    out.push(dir)
  }
  return out
}

/**
 * `target` relative to `from`, with forward slashes, or null when there is no
 * sensible relative path (another drive, or the same folder).
 */
export function relativePath(from: string, target: string): string | null {
  const rel = relative(from, target)
  if (!rel || isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/* ---- live map --------------------------------------------------------------- */

/** One member repo as an agent sees it. */
export interface RepoMapEntry {
  id: string
  name: string
  path: string
  /** Relative to the project root, forward slashes; null when outside it. */
  relPath: string | null
  /** `origin`'s URL, or null when there is none (or git could not say). */
  remote: string | null
  /** The root checkout's branch; null when git could not say. */
  branch: string | null
  /** Whether the root checkout has changes; null when git could not say. */
  dirty: boolean | null
  home: boolean
  /** The calling session's own repo. */
  current: boolean
  /** Its linked worktrees in Orbital. */
  worktrees: { name: string; branch: string; path: string; task: number | null }[]
  /** Tasks filed under this repo, not done and not archived. */
  openTasks: number
  /** Agent steering files at the repo root, in the order agents read them. */
  steering: string[]
}

export interface ProjectMap {
  id: string
  name: string
  rootPath: string
  home: { id: string; name: string; path: string } | null
  repos: RepoMapEntry[]
  /** The project's open tasks filed under no repo: work that spans it. */
  openTasks: number
}

/** What git said about one checkout. */
export interface RepoProbe {
  remote: string | null
  branch: string | null
  dirty: boolean | null
}

const STEERING_FILES = ['AGENTS.md', 'CLAUDE.md']

/** Build the map from rows already in hand plus the git probes (pure apart from `steering`). */
export function assembleProjectMap(input: {
  project: Project
  members: Repo[]
  worktrees: Worktree[]
  tasks: Task[]
  probes: Map<string, RepoProbe>
  currentRepoId: string | null
  steering?: (repoPath: string) => string[]
}): ProjectMap {
  const { project, members, worktrees, tasks, probes, currentRepoId } = input
  const steering = input.steering ?? steeringFiles
  const seqOf = new Map(tasks.map((t) => [t.id, t.seq]))
  const open = tasks.filter((t) => t.projectId === project.id && t.status !== 'done' && t.archivedAt == null)
  const home = project.homeRepoId ? members.find((r) => r.id === project.homeRepoId) : undefined
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    home: home ? { id: home.id, name: home.name, path: home.repoPath } : null,
    repos: members.map((r) => {
      const probe = probes.get(r.id)
      return {
        id: r.id,
        name: r.name,
        path: r.repoPath,
        relPath: relativePath(project.rootPath, r.repoPath),
        remote: probe?.remote ?? null,
        branch: probe?.branch ?? worktrees.find((w) => w.repoId === r.id && w.kind === 'root')?.branch ?? null,
        dirty: probe?.dirty ?? null,
        home: r.id === project.homeRepoId,
        current: r.id === currentRepoId,
        worktrees: worktrees
          .filter((w) => w.repoId === r.id && w.kind === 'linked')
          .map((w) => ({ name: w.name, branch: w.branch, path: w.path, task: w.taskId ? (seqOf.get(w.taskId) ?? null) : null })),
        openTasks: open.filter((t) => t.repoId === r.id).length,
        steering: steering(r.repoPath)
      }
    }),
    // A tag naming a repo outside the project counts as none, as on the board.
    openTasks: open.filter((t) => !t.repoId || !project.repoIds.includes(t.repoId)).length
  }
}

/** Which agent steering files sit at a repo's root. */
export function steeringFiles(repoPath: string): string[] {
  return STEERING_FILES.filter((f) => {
    try {
      return existsSync(join(repoPath, f))
    } catch {
      return false
    }
  })
}

/** Per git call. Launches wait on these, so they are kept short. */
const PROBE_TIMEOUT_MS = 3_000

/** Run git and return trimmed stdout, or null on any failure or timeout. */
function gitOut(cwd: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        { cwd, timeout: timeoutMs, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout) => resolve(err ? null : String(stdout))
      )
    } catch {
      resolve(null)
    }
  })
}

/** `origin`'s URL, or null. */
export async function originUrl(repoPath: string): Promise<string | null> {
  const out = await gitOut(repoPath, ['config', '--get', 'remote.origin.url'])
  return out?.trim() || null
}

/**
 * The branch named in `git status --porcelain --branch`'s header line:
 * `## main...origin/main [ahead 1]`, `## No commits yet on main`,
 * `## HEAD (no branch)` (detached).
 */
export function branchFromStatusHeader(line: string): string | null {
  if (!line.startsWith('## ')) return null
  let rest = line.slice(3).trim()
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(rest)
  if (unborn) return unborn[1].trim()
  if (rest.startsWith('HEAD (no branch)')) return 'HEAD (detached)'
  rest = rest.split('...')[0]
  return rest.split(' ')[0] || null
}

/** Branch, dirty state and remote of one checkout, each null when git could not say. */
export async function probeRepo(repoPath: string): Promise<RepoProbe> {
  const [status, remote] = await Promise.all([
    gitOut(repoPath, ['status', '--porcelain=v1', '--branch']),
    originUrl(repoPath)
  ])
  if (status === null) return { remote, branch: null, dirty: null }
  const lines = status.split(/\r?\n/).filter(Boolean)
  return {
    remote,
    branch: lines[0] ? branchFromStatusHeader(lines[0]) : null,
    dirty: lines.some((l) => !l.startsWith('## '))
  }
}

/** Probe every repo in parallel, keyed by repo id. */
export async function probeRepos(repos: Repo[]): Promise<Map<string, RepoProbe>> {
  const results = await Promise.all(repos.map((r) => probeRepo(r.repoPath).catch(() => null)))
  const out = new Map<string, RepoProbe>()
  repos.forEach((r, i) => {
    const p = results[i]
    if (p) out.set(r.id, p)
  })
  return out
}

/* ---- from the live tables ----------------------------------------------------- */

/** The role of a worktree's session, read from this workspace's rows. */
export function roleOf(worktree: Pick<Worktree, 'kind' | 'repoId' | 'projectId'>): SessionRole | null {
  return sessionRole(worktree, tables.projects.get(worktree.projectId), tables.repos.list())
}

/**
 * The live map of a project, with git probed for every member in parallel.
 * `currentRepoId` marks the caller's own repo. Null when the project is gone.
 */
export async function loadProjectMap(projectId: string, currentRepoId: string | null): Promise<ProjectMap | null> {
  const project = tables.projects.get(projectId)
  if (!project) return null
  const repos = tables.repos.list()
  const members = project.repoIds.map((id) => repos.find((r) => r.id === id)).filter((r): r is Repo => !!r)
  const probes = await probeRepos(members)
  return assembleProjectMap({
    project,
    members,
    worktrees: tables.worktrees.list(),
    tasks: tables.tasks.list('active'),
    probes,
    currentRepoId
  })
}
