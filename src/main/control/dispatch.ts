import {
  normalizeStatus,
  normalizeTaskStatus,
  findAgentConfig,
  resolveAgentRef,
  type TabType,
  type TabConfig,
  type TaskStatus,
  type TaskPatch,
  type Project,
  type Task,
  type Worktree,
  type ControlCommand,
  type ControlRequest,
  type ControlResponse
} from '@shared/types'
import { runtime, tables } from '../runtime'
import { getSettings } from '../services/settings'
import { logger } from '../services/logger'
import { updater } from '../services/updater'
import { recordAgentSession } from '../services/agents/launch'
import { getProvider } from '../services/agents/provider'
import { loadProjectMap } from '../services/project-map'
import { createTabInWorktree } from '../tabs'
import { createWorktree, syncWorktreeEnv } from '../worktree-lifecycle'
import { addFolder, listFolders, moveToFolder, removeFolder, renameFolder } from './folders'
import { hookFired, statusReported } from '../status'
import {
  noRepoError,
  normalizeServerUrl,
  parseTagList,
  resolveTask,
  scopeRequest,
  sessionCaptureRepoId,
  sessionFocusRepoId,
  taskDto
} from './helpers'

/**
 * The `orbital` CLI's commands, one handler per ControlCommand. The table is
 * typed exhaustively, so adding a command to the union without a handler here
 * is a compile error rather than a runtime "unknown command".
 */
type Handler = (req: ControlRequest) => Promise<ControlResponse>

/** `task archive` / `task unarchive` (and the legacy `task delete`). */
async function archiveTask(req: ControlRequest, archive: boolean): Promise<ControlResponse> {
  const found = findTask(req)
  if (!found.task) return { ok: false, error: found.error }
  const task = found.task
  if (archive) tables.tasks.archive(task.id)
  else tables.tasks.unarchive(task.id)
  runtime.broadcastState()
  return { ok: true, data: { id: task.id, seq: task.seq, title: task.title, repo: repoNameOf(task.repoId) } }
}

/** A repo's name, so the CLI can say where a task went; undefined for none. */
const repoNameOf = (repoId: string | null | undefined): string | undefined =>
  repoId ? tables.repos.get(repoId)?.name : undefined

/** Whether `--repo` was passed (scopeRequest has then made it `req.repoId`). */
const repoGiven = (req: ControlRequest): boolean =>
  req.args.repo !== undefined && req.args.repo !== null && req.args.repo !== ''

const flag = (v: unknown): boolean => v === true || v === 'true'

/**
 * The project task commands act in: `--repo`'s project when it is passed (the
 * opt-in to reach another repo, which may be in another project), else the
 * calling terminal's. Tasks belong to projects, so a folder session, which
 * has no repo, works here like any other.
 */
function taskProject(req: ControlRequest): { project?: Project; error?: string } {
  const pid = repoGiven(req) && req.repoId ? tables.repos.get(req.repoId)?.projectId : projectIdOf(req)
  const project = pid ? tables.projects.get(pid) : undefined
  return project ? { project } : { error: 'no ORBITAL_WORKTREE_ID in environment' }
}

/** {@link taskProject} as the pair the folder commands take: the project, and why there is none. */
function projectOrError(req: ControlRequest): [Project | undefined, string | undefined] {
  const { project, error } = taskProject(req)
  return [project, error]
}

/** The `id` argument resolved in the request's project. */
function findTask(req: ControlRequest): { task?: Task; project?: Project; error?: string } {
  const { project, error } = taskProject(req)
  if (!project) return { error }
  const idArg = String(req.args.id ?? '').trim()
  if (!idArg) return { error: 'task id required' }
  const found = resolveTask(project.id, idArg)
  return found.task ? { task: found.task, project } : { error: found.error }
}

/** The calling terminal's worktree, when it is one of this workspace's. */
const callerWorktree = (req: ControlRequest): Worktree | undefined =>
  req.worktreeId ? tables.worktrees.get(req.worktreeId) : undefined

/**
 * The project a request is about: the calling worktree's (it follows its repo
 * when the repo moves), else the env project, else the env repo's.
 */
function projectIdOf(req: ControlRequest): string | undefined {
  const wt = req.worktreeId ? tables.worktrees.get(req.worktreeId) : undefined
  if (wt) return wt.projectId
  if (req.projectId && tables.projects.get(req.projectId)) return req.projectId
  return req.repoId ? tables.repos.get(req.repoId)?.projectId : undefined
}

/**
 * The worktree `tab new` opens in. Without `--repo` / `--worktree` it is the
 * calling one. `--repo` picks that repo's root checkout; `--worktree` picks one
 * of the repo's worktrees (this terminal's repo when `--repo` is absent) by
 * name, branch or id.
 */
function tabTarget(req: ControlRequest): { worktreeId?: string; error?: string } {
  const repoGiven = req.args.repo !== undefined && req.args.repo !== null && req.args.repo !== ''
  const ref = req.args.worktree !== undefined ? String(req.args.worktree).trim() : ''
  if (!repoGiven && !ref) {
    return req.worktreeId ? { worktreeId: req.worktreeId } : { error: 'no ORBITAL_WORKTREE_ID in environment' }
  }
  if (!req.repoId) return { error: noRepoError(req) }
  const inRepo = tables.worktrees.list().filter((w) => w.repoId === req.repoId)
  const name = tables.repos.get(req.repoId)?.name ?? req.repoId
  if (!ref) {
    const root = inRepo.find((w) => w.kind === 'root')
    return root ? { worktreeId: root.id } : { error: `repo '${name}' has no root worktree in Orbital` }
  }
  const lower = ref.toLowerCase()
  const byId = inRepo.find((w) => w.id === ref)
  if (byId) return { worktreeId: byId.id }
  const hits = inRepo.filter((w) => w.name.toLowerCase() === lower || w.branch === ref)
  if (hits.length === 1) return { worktreeId: hits[0].id }
  if (hits.length > 1) {
    return { error: `worktree '${ref}' is ambiguous in repo '${name}' (${hits.map((w) => w.id).join(', ')})` }
  }
  return { error: `no worktree '${ref}' in repo '${name}' (see \`orbital worktrees --repo ${name}\`)` }
}

const handlers: Record<ControlCommand, Handler> = {
  status: async (req) => {
    const status = normalizeStatus(String(req.args.status ?? ''))
    if (!status) return { ok: false, error: `unknown status '${req.args.status}'` }
    if (!req.terminalId) return { ok: false, error: 'no ORBITAL_TERMINAL_ID in environment' }
    const tab = tables.tabs.get(req.terminalId)
    if (!tab) return { ok: false, error: 'terminal not found' }
    statusReported(req.terminalId, status, req.args.firedAt)
    return { ok: true, data: { status } }
  },
  whoami: async (req) => {
    // Self-inspection: an agent knows its ids from the env, but not what they
    // mean. One call answers "where am I, and what does the cockpit think I'm doing".
    if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    const worktree = tables.worktrees.get(req.worktreeId)
    if (!worktree) return { ok: false, error: 'worktree not found' }
    // A folder session has no repo: it answers with its project alone.
    const repo = worktree.repoId ? tables.repos.get(worktree.repoId) : undefined
    const project = tables.projects.get(worktree.projectId)
    const tab = req.terminalId ? tables.tabs.get(req.terminalId) : undefined
    const task = worktree.taskId ? tables.tasks.get(worktree.taskId) : undefined
    return {
      ok: true,
      data: {
        project: project?.name ?? '',
        projectId: worktree.projectId,
        repo: repo?.name ?? '',
        repoId: worktree.repoId ?? '',
        repoPath: repo?.repoPath ?? '',
        worktree: worktree.name,
        worktreeId: worktree.id,
        kind: worktree.kind,
        branch: worktree.branch,
        path: worktree.path,
        status: tab?.status ?? worktree.status,
        terminalId: req.terminalId ?? '',
        task: task ? { seq: task.seq, title: task.title, status: task.status } : null,
        servers: runtime.devServersFor(worktree.id)
      }
    }
  },
  repos: async (req) => {
    // The workspace's repos, so an agent can find a sibling to pass as `--repo`.
    const list = tables.repos.list().map((p) => ({
      id: p.id,
      name: p.name,
      repoPath: p.repoPath,
      current: p.id === req.repoId
    }))
    return { ok: true, data: list }
  },
  project: async (req) => {
    // The calling terminal's project, live: its root, home and member repos
    // with their branches, changes and worktrees — the fan-out targets.
    const pid = projectIdOf(req)
    if (!pid) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    const map = await loadProjectMap(pid, req.repoId ?? null)
    if (!map) return { ok: false, error: 'project not found' }
    const wt = req.worktreeId ? tables.worktrees.get(req.worktreeId) : undefined
    const projectSession =
      wt?.kind === 'folder' || (map.home !== null && wt?.repoId === map.home.id && map.repos.length > 1)
    return { ok: true, data: { ...map, projectSession } }
  },
  worktrees: async (req) => {
    const pid = req.repoId
    const list = tables.worktrees
      .list()
      .filter((w) => !pid || w.repoId === pid)
      .map((w) => ({
        id: w.id,
        name: w.name,
        branch: w.branch,
        status: w.status,
        kind: w.kind,
        path: w.path
      }))
    return { ok: true, data: list }
  },
  'worktree-new': async (req) => {
    // A task number/id may come along: the Worktree is then started from that
    // task, same as the cockpit's "start a worktree from a task". It goes in
    // `--repo` when that is passed, else the task's repo, else the project's
    // only repo; an untagged task in a project of several needs `--repo`.
    let task: Task | undefined
    let repoId = req.repoId
    if (req.args.task !== undefined) {
      const { project, error } = taskProject(req)
      if (!project) return { ok: false, error }
      const resolved = resolveTask(project.id, String(req.args.task).trim())
      if (!resolved.task) return { ok: false, error: resolved.error }
      task = resolved.task
      if (!repoGiven(req)) {
        repoId =
          task.repoId && project.repoIds.includes(task.repoId)
            ? task.repoId
            : project.repoIds.length === 1
              ? project.repoIds[0]
              : undefined
        if (!repoId) {
          return {
            ok: false,
            error: `task #${task.seq} has no repo, so say where to start it: pass --repo <name|id> (\`orbital project\` lists the repos)`
          }
        }
      }
    }
    if (!repoId) return { ok: false, error: noRepoError(req) }
    const repo = tables.repos.get(repoId)
    if (!repo) return { ok: false, error: 'repo not found' }
    const worktree = await createWorktree({
      repoId: repo.id,
      branch: req.args.worktree !== undefined ? String(req.args.worktree) : undefined,
      existingBranch: req.args.existingBranch ? String(req.args.existingBranch) : undefined,
      name: req.args.name ? String(req.args.name) : undefined,
      baseRef: req.args.base ? String(req.args.base) : undefined,
      taskId: task?.id
    })
    return {
      ok: true,
      data: {
        id: worktree.id,
        name: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        task: task ? { seq: task.seq, title: task.title } : null,
        repo: repo.name
      }
    }
  },
  'worktree-sync': async (req) => {
    if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    try {
      return { ok: true, data: await syncWorktreeEnv(req.worktreeId) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  'tab-new': async (req) => {
    const type = String(req.args.type ?? 'terminal') as TabType
    if (!['terminal', 'browser', 'editor', 'agent', 'search'].includes(type)) {
      return { ok: false, error: `unknown tab type '${type}'` }
    }
    const target = tabTarget(req)
    if (!target.worktreeId) return { ok: false, error: target.error }
    const worktreeId = target.worktreeId
    const arg = req.args.arg ? String(req.args.arg) : undefined
    const prompt = req.args.prompt !== undefined ? String(req.args.prompt).trim() : ''
    if (prompt && type !== 'agent') return { ok: false, error: '--prompt only applies to agent tabs' }
    // Name the destination when it is not the caller's own worktree.
    const where = (): Record<string, unknown> => {
      if (worktreeId === req.worktreeId) return {}
      const wt = tables.worktrees.get(worktreeId)
      return { worktree: wt?.name, repo: wt?.repoId ? tables.repos.get(wt.repoId)?.name : undefined }
    }
    if (type === 'agent') {
      // The argument names a configured profile — its id, its name (as typed
      // in Settings, case-insensitively), or a provider id. Without one the
      // target repo's default runs.
      const agents = getSettings().agents
      let agentId: string | undefined
      if (arg) {
        const agent =
          findAgentConfig(agents, arg) ?? agents.find((a) => a.name.toLowerCase() === arg.toLowerCase())
        if (!agent) {
          return { ok: false, error: `no agent '${arg}' is configured (try: ${agents.map((a) => a.name).join(', ')})` }
        }
        agentId = agent.id
      }
      if (prompt) {
        const wt = tables.worktrees.get(worktreeId)
        const repo = wt?.repoId ? tables.repos.get(wt.repoId) : undefined
        const provider = getProvider(resolveAgentRef(agents, agentId, undefined, repo?.defaultAgentId ?? 'claude')?.provider)
        if (!provider.acceptsPrompt) {
          return { ok: false, error: `${provider.displayName} cannot be started with a prompt; open it without --prompt` }
        }
      }
      const config: TabConfig = {}
      if (agentId) config.agentId = agentId
      if (prompt) config.agentPrompt = prompt
      const tab = createTabInWorktree(worktreeId, null, type, config)
      runtime.broadcastState()
      return { ok: true, data: { id: tab.id, type: tab.type, ...where() } }
    }
    // A search tab's argument is the query, scoped to the target Worktree —
    // `orbital tab new search TODO` is how an agent hands its findings over.
    const config: TabConfig =
      type === 'browser'
        ? { url: arg }
        : type === 'editor'
          ? { filePath: arg }
          : type === 'search' && arg
            ? { search: { query: arg, scope: 'worktree', worktreeId } }
            : {}
    const tab = createTabInWorktree(worktreeId, null, type, config)
    runtime.broadcastState()
    return { ok: true, data: { id: tab.id, type: tab.type, ...where() } }
  },
  hook: async (req) => {
    // Invoked by Claude Code hooks via `orbital hook <event>`. The CLI only
    // reaches here for Orbital-spawned sessions (it guards on ORBITAL_WORKTREE_ID).
    if (!req.terminalId) return { ok: true }
    const tab = tables.tabs.get(req.terminalId)
    if (!tab) return { ok: true }
    const event = String(req.args.event ?? '')
    const payload = (req.args.payload ?? {}) as Record<string, unknown>
    // Every hook payload names the session it came from. Keep the tab
    // pointed at it so a respawn resumes the conversation actually running
    // — after a `/clear` mid-session that is a different id from the one
    // Orbital launched with.
    recordAgentSession(tab, payload.session_id)
    const status = hookFired(req.terminalId, event, payload, req.args.firedAt)
    return status ? { ok: true, data: { status } } : { ok: true }
  },
  'task-add': async (req) => {
    const title = String(req.args.title ?? '').trim()
    if (!title) return { ok: false, error: 'task title required' }
    const noRepo = flag(req.args.noRepo)
    if (noRepo && repoGiven(req)) return { ok: false, error: 'pass --repo or --no-repo, not both' }
    const { project, error } = taskProject(req)
    if (!project) return { ok: false, error }
    // Not told otherwise, file it where the tracker's quick capture would:
    // this repo from a repo session, no repo from the project session.
    const repoId = noRepo ? null : repoGiven(req) ? (req.repoId ?? null) : sessionCaptureRepoId(project, callerWorktree(req))
    const task = tables.tasks.create({
      projectId: project.id,
      repoId,
      title,
      description: req.args.description ? String(req.args.description) : undefined,
      tags: req.args.tags ? parseTagList(String(req.args.tags)) : undefined,
      // The control pipe is the agents' door into the cockpit; a person files
      // tasks through the UI, which goes through IPC instead.
      createdBy: 'agent'
    })
    runtime.broadcastState()
    return {
      ok: true,
      data: { id: task.id, seq: task.seq, title: task.title, repo: repoNameOf(task.repoId) ?? null, project: project.name }
    }
  },
  'task-list': async (req) => {
    const { project, error } = taskProject(req)
    if (!project) return { ok: false, error }
    const all = flag(req.args.all)
    const archived = flag(req.args.archived)
    const noRepo = flag(req.args.noRepo)
    const allRepos = flag(req.args.allRepos)
    if ([noRepo, allRepos, repoGiven(req)].filter(Boolean).length > 1) {
      return { ok: false, error: 'pass one of --repo, --no-repo and --all-repos' }
    }
    // Which repo's tasks: `--repo`'s, none (`--no-repo`), every one
    // (`--all-repos`), or by default the terminal's: its repo's in a repo
    // session, the whole project's in the project session.
    const scope: { repoId: string | null } | 'all' = noRepo
      ? { repoId: null }
      : repoGiven(req)
        ? { repoId: req.repoId ?? null }
        : allRepos
          ? 'all'
          : ((focus) => (focus ? { repoId: focus } : 'all'))(sessionFocusRepoId(project, callerWorktree(req)))
    // A tag naming a repo outside the project reads as none, as on the board.
    const tagOf = (t: Task): string | null => (t.repoId && project.repoIds.includes(t.repoId) ? t.repoId : null)
    // Explicit --status implies --all: asking for `done` and getting nothing
    // because the default hides done tasks would just be confusing.
    let wanted: TaskStatus | null = null
    if (req.args.status !== undefined) {
      wanted = normalizeTaskStatus(String(req.args.status))
      if (!wanted) return { ok: false, error: `unknown task status '${req.args.status}'` }
    }
    const tag = req.args.tag !== undefined ? String(req.args.tag).trim().toLowerCase() : null
    // --archived shows only archived tasks (any status); --all adds them to
    // everything else; the default is active, not-done tasks.
    const list = tables.tasks
      .list(archived ? 'archived' : all ? 'all' : 'active')
      .filter((t) => t.projectId === project.id && (scope === 'all' || tagOf(t) === scope.repoId))
      .filter((t) => all || archived || wanted !== null || t.status !== 'done')
      .filter((t) => wanted === null || t.status === wanted)
      .filter((t) => !tag || t.tags.some((x) => x.toLowerCase() === tag))
      .map(taskDto)
    return { ok: true, data: list }
  },
  'task-show': async (req) => {
    const { task, project, error } = findTask(req)
    if (!task || !project) return { ok: false, error }
    return { ok: true, data: { ...taskDto(task), project: project.name } }
  },
  'task-update': async (req) => {
    const { task, error } = findTask(req)
    if (!task) return { ok: false, error }
    const patch: TaskPatch = {}
    // `task update --repo <r>` files it under r, `--no-repo` under none.
    // (`task done` passes `--repo` only to find the task, never to move it.)
    const noRepo = flag(req.args.noRepo)
    if (noRepo && repoGiven(req)) return { ok: false, error: 'pass --repo or --no-repo, not both' }
    if (noRepo) patch.repoId = null
    else if (flag(req.args.retag) && repoGiven(req) && req.repoId) patch.repoId = req.repoId
    if (req.args.status !== undefined) {
      const status = normalizeTaskStatus(String(req.args.status))
      if (!status) return { ok: false, error: `unknown task status '${req.args.status}'` }
      patch.status = status
    }
    if (req.args.title !== undefined) patch.title = String(req.args.title)
    if (req.args.description !== undefined) patch.description = String(req.args.description)
    if (req.args.tags !== undefined) patch.tags = parseTagList(String(req.args.tags))
    if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' }
    const updated = tables.tasks.update(task.id, patch)
    runtime.broadcastState()
    return {
      ok: true,
      data: {
        id: updated.id,
        seq: updated.seq,
        status: updated.status,
        title: updated.title,
        repo: repoNameOf(updated.repoId) ?? null,
        retagged: patch.repoId !== undefined && task.repoId !== updated.repoId
      }
    }
  },
  'task-archive': async (req) => archiveTask(req, true),
  'task-unarchive': async (req) => archiveTask(req, false),
  // Tasks are never hard-deleted; an older CLI's `task delete` archives.
  'task-delete': async (req) => archiveTask(req, true),
  'server-add': async (req) => {
    if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    const url = normalizeServerUrl(String(req.args.url ?? ''))
    if (!url) return { ok: false, error: `invalid server url '${req.args.url}'` }
    const servers = runtime.addDevServer(req.worktreeId, url)
    return { ok: true, data: { url, servers } }
  },
  'server-remove': async (req) => {
    if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    const url = normalizeServerUrl(String(req.args.url ?? ''))
    if (!url) return { ok: false, error: `invalid server url '${req.args.url}'` }
    const servers = runtime.removeDevServer(req.worktreeId, url)
    return { ok: true, data: { url, servers } }
  },
  'server-list': async (req) => {
    if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    return { ok: true, data: runtime.devServersFor(req.worktreeId) }
  },
  // The rail's folders. Like tasks they are about a project, so they work
  // from any of its terminals, the folder session included.
  'folder-list': async (req) => listFolders(req, ...projectOrError(req)),
  'folder-add': async (req) => addFolder(req, ...projectOrError(req)),
  'folder-move': async (req) => moveToFolder(req, ...projectOrError(req)),
  'folder-rename': async (req) => renameFolder(req, ...projectOrError(req)),
  'folder-remove': async (req) => removeFolder(req, ...projectOrError(req)),
  'quit-for-update': async () => {
    // Sent by the instance whose Update button was clicked (peer-instances.ts).
    // The pid lets it wait for this process to fully exit, not just the pipe.
    updater.quitForPeerUpdate()
    return { ok: true, data: { pid: process.pid } }
  }
}

export async function handleControl(req: ControlRequest): Promise<ControlResponse> {
  // Record every incoming CLI command up front so a crash mid-dispatch still
  // leaves a trail of what the CLI was asking the app to do.
  logger.cli(req.cmd, { args: req.args, worktreeId: req.worktreeId, repoId: req.repoId })
  const handler = Object.prototype.hasOwnProperty.call(handlers, req.cmd) ? handlers[req.cmd] : undefined
  if (!handler) return { ok: false, error: `unknown command '${String(req.cmd)}'` }
  try {
    // Resolve `--repo` / validate ORBITAL_REPO_ID against this workspace
    // up front, so every handler's `req.repoId` is one it may act on.
    const scoped = scopeRequest(req)
    if (!scoped.req) return { ok: false, error: scoped.error }
    return await handler(scoped.req)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error(`cli ${req.cmd} failed`, { error })
    return { ok: false, error }
  }
}
