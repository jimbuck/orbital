import {
  normalizeStatus,
  normalizeTaskStatus,
  findAgentConfig,
  type TabType,
  type TabConfig,
  type TaskStatus,
  type TaskPatch,
  type ControlCommand,
  type ControlRequest,
  type ControlResponse
} from '@shared/types'
import { runtime, repo } from '../runtime'
import { createLinkedWorktree } from '../services/worktree'
import { getSettings } from '../services/settings'
import { logger } from '../services/logger'
import { recordAgentSession } from '../services/agents/launch'
import { createTabInWorktree } from '../tabs'
import { beginWorktreeSetup, syncWorktreeEnv } from '../worktree-lifecycle'
import { acceptStatusEvent, clearAttentionKind, hookEventToStatus, setAttentionKind, setTabStatus } from '../status'
import { normalizeServerUrl, parseTagList, resolveTask, taskDto } from './helpers'

/**
 * The `orbital` CLI's commands, one handler per ControlCommand. The table is
 * typed exhaustively, so adding a command to the union without a handler here
 * is a compile error rather than a runtime "unknown command".
 */
type Handler = (req: ControlRequest) => Promise<ControlResponse>

const handlers: Record<ControlCommand, Handler> = {
  status: async (req) => {
    const status = normalizeStatus(String(req.args.status ?? ''))
    if (!status) return { ok: false, error: `unknown status '${req.args.status}'` }
    if (!req.terminalId) return { ok: false, error: 'no ORBITAL_TERMINAL_ID in environment' }
    const tab = repo.tabs.get(req.terminalId)
    if (!tab) return { ok: false, error: 'terminal not found' }
    if (acceptStatusEvent(req.terminalId, req.args.firedAt)) {
      // CLI-set needs-attention has no prompt kind — typing then resets to idle.
      clearAttentionKind(req.terminalId)
      setTabStatus(req.terminalId, tab.worktreeId, status)
    }
    return { ok: true, data: { status } }
  },
  whoami: async (req) => {
    // Self-inspection: an agent knows its ids from the env, but not what they
    // mean. One call answers "where am I, and what does the cockpit think I'm doing".
    if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    const worktree = repo.worktrees.get(req.worktreeId)
    if (!worktree) return { ok: false, error: 'worktree not found' }
    const project = repo.projects.get(worktree.projectId)
    const tab = req.terminalId ? repo.tabs.get(req.terminalId) : undefined
    const task = worktree.taskId ? repo.tasks.get(worktree.taskId) : undefined
    return {
      ok: true,
      data: {
        project: project?.name ?? '',
        projectId: worktree.projectId,
        repoPath: project?.repoPath ?? '',
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
  worktrees: async (req) => {
    const pid = req.projectId
    const list = repo.worktrees
      .list()
      .filter((w) => !pid || w.projectId === pid)
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
    if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
    const project = repo.projects.get(req.projectId)
    if (!project) return { ok: false, error: 'project not found' }
    // A task number/id may come along, both to seed the branch name and to
    // link the task — same as the cockpit's "start a worktree from a task".
    let task: ReturnType<typeof repo.tasks.get> | undefined
    if (req.args.task !== undefined) {
      const resolved = resolveTask(req.projectId, String(req.args.task).trim())
      if (!resolved.task) return { ok: false, error: resolved.error }
      task = resolved.task
    }
    const existingBranch = req.args.existingBranch ? String(req.args.existingBranch) : undefined
    const branch = String(req.args.worktree ?? req.args.name ?? task?.title ?? `worktree-${Date.now()}`)
    const worktree = await createLinkedWorktree({
      project,
      branch,
      existingBranch,
      name: req.args.name ? String(req.args.name) : task?.title,
      baseRef: req.args.base ? String(req.args.base) : undefined,
      taskId: task?.id ?? null
    })
    // Link the task both ways and start it, matching the play-button flow.
    if (task) {
      repo.tasks.setWorktree(task.id, worktree.id)
      if (task.status !== 'in_progress' && task.status !== 'done') {
        repo.tasks.update(task.id, { status: 'in_progress' })
      }
    }
    runtime.gitWatcher.watch(worktree.path)
    beginWorktreeSetup(worktree, project.repoPath)
    runtime.broadcastState()
    return {
      ok: true,
      data: {
        id: worktree.id,
        name: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        task: task ? { seq: task.seq, title: task.title } : null
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
    if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
    const type = String(req.args.type ?? 'terminal') as TabType
    if (!['terminal', 'browser', 'editor', 'agent'].includes(type)) {
      return { ok: false, error: `unknown tab type '${type}'` }
    }
    const arg = req.args.arg ? String(req.args.arg) : undefined
    // For agents the argument names a configured profile — its id, its name
    // (as typed in Settings, case-insensitively), or a provider id.
    if (type === 'agent' && arg) {
      const agents = getSettings().agents
      const agent =
        findAgentConfig(agents, arg) ?? agents.find((a) => a.name.toLowerCase() === arg.toLowerCase())
      if (!agent) {
        return { ok: false, error: `no agent '${arg}' is configured (try: ${agents.map((a) => a.name).join(', ')})` }
      }
      const tab = createTabInWorktree(req.worktreeId, null, type, { agentId: agent.id })
      runtime.broadcastState()
      return { ok: true, data: { id: tab.id, type: tab.type } }
    }
    const config: TabConfig =
      type === 'browser' ? { url: arg } : type === 'editor' ? { filePath: arg } : {}
    const tab = createTabInWorktree(req.worktreeId, null, type, config)
    runtime.broadcastState()
    return { ok: true, data: { id: tab.id, type: tab.type } }
  },
  hook: async (req) => {
    // Invoked by Claude Code hooks via `orbital hook <event>`. The CLI only
    // reaches here for Orbital-spawned sessions (it guards on ORBITAL_WORKTREE_ID).
    if (!req.terminalId) return { ok: true }
    const tab = repo.tabs.get(req.terminalId)
    if (!tab) return { ok: true }
    const event = String(req.args.event ?? '')
    const payload = (req.args.payload ?? {}) as Record<string, unknown>
    // Every hook payload names the session it came from. Keep the tab
    // pointed at it so a respawn resumes the conversation actually running
    // — after a `/clear` mid-session that is a different id from the one
    // Orbital launched with.
    recordAgentSession(tab, payload.session_id)
    const status = hookEventToStatus(event, payload)
    if (!status) return { ok: true }
    // Async hooks race over the pipe — drop an event a later-fired one beat here.
    if (!acceptStatusEvent(req.terminalId, req.args.firedAt)) return { ok: true }
    if (status === 'needs_attention') {
      setAttentionKind(req.terminalId, String(payload.notification_type ?? ''))
    } else {
      clearAttentionKind(req.terminalId)
    }
    setTabStatus(req.terminalId, tab.worktreeId, status)
    return { ok: true, data: { status } }
  },
  'task-add': async (req) => {
    if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
    const title = String(req.args.title ?? '').trim()
    if (!title) return { ok: false, error: 'task title required' }
    const task = repo.tasks.create({
      projectId: req.projectId,
      title,
      description: req.args.description ? String(req.args.description) : undefined,
      tags: req.args.tags ? parseTagList(String(req.args.tags)) : undefined
    })
    runtime.broadcastState()
    return { ok: true, data: { id: task.id, seq: task.seq, title: task.title } }
  },
  'task-list': async (req) => {
    if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
    const all = req.args.all === true || req.args.all === 'true'
    // Explicit --status implies --all: asking for `done` and getting nothing
    // because the default hides done tasks would just be confusing.
    let wanted: TaskStatus | null = null
    if (req.args.status !== undefined) {
      wanted = normalizeTaskStatus(String(req.args.status))
      if (!wanted) return { ok: false, error: `unknown task status '${req.args.status}'` }
    }
    const tag = req.args.tag !== undefined ? String(req.args.tag).trim().toLowerCase() : null
    const list = repo.tasks
      .list()
      .filter((t) => t.projectId === req.projectId && (all || wanted !== null || t.status !== 'done'))
      .filter((t) => wanted === null || t.status === wanted)
      .filter((t) => !tag || t.tags.some((x) => x.toLowerCase() === tag))
      .map(taskDto)
    return { ok: true, data: list }
  },
  'task-show': async (req) => {
    if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
    const idArg = String(req.args.id ?? '').trim()
    if (!idArg) return { ok: false, error: 'task id required' }
    const { task, error } = resolveTask(req.projectId, idArg)
    if (!task) return { ok: false, error }
    return { ok: true, data: taskDto(task) }
  },
  'task-update': async (req) => {
    if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
    const idArg = String(req.args.id ?? '').trim()
    if (!idArg) return { ok: false, error: 'task id required' }
    const { task, error } = resolveTask(req.projectId, idArg)
    if (!task) return { ok: false, error }
    const patch: TaskPatch = {}
    if (req.args.status !== undefined) {
      const status = normalizeTaskStatus(String(req.args.status))
      if (!status) return { ok: false, error: `unknown task status '${req.args.status}'` }
      patch.status = status
    }
    if (req.args.title !== undefined) patch.title = String(req.args.title)
    if (req.args.description !== undefined) patch.description = String(req.args.description)
    if (req.args.tags !== undefined) patch.tags = parseTagList(String(req.args.tags))
    if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' }
    const updated = repo.tasks.update(task.id, patch)
    runtime.broadcastState()
    return { ok: true, data: { id: updated.id, seq: updated.seq, status: updated.status, title: updated.title } }
  },
  'task-delete': async (req) => {
    if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
    const idArg = String(req.args.id ?? '').trim()
    if (!idArg) return { ok: false, error: 'task id required' }
    const { task, error } = resolveTask(req.projectId, idArg)
    if (!task) return { ok: false, error }
    repo.tasks.remove(task.id)
    runtime.broadcastState()
    return { ok: true, data: { id: task.id, seq: task.seq, title: task.title } }
  },
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
  }
}

export async function handleControl(req: ControlRequest): Promise<ControlResponse> {
  // Record every incoming CLI command up front so a crash mid-dispatch still
  // leaves a trail of what the CLI was asking the app to do.
  logger.cli(req.cmd, { args: req.args, worktreeId: req.worktreeId, projectId: req.projectId })
  const handler = Object.prototype.hasOwnProperty.call(handlers, req.cmd) ? handlers[req.cmd] : undefined
  if (!handler) return { ok: false, error: `unknown command '${String(req.cmd)}'` }
  try {
    return await handler(req)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error(`cli ${req.cmd} failed`, { error })
    return { ok: false, error }
  }
}
