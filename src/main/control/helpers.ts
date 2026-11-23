import type { ControlRequest, Repo, Task } from '@shared/types'
import { tables } from '../runtime'

/**
 * Normalize a CLI dev-server argument to a full URL: `3000` and `localhost:3000`
 * become `http://localhost:3000/`; explicit schemes pass through.
 */
export function normalizeServerUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const candidate = /^\d+$/.test(s) ? `http://localhost:${s}` : /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

/** Parse a comma-separated tag list ("bug, ui") into trimmed, non-empty tags. */
export function parseTagList(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * Resolve `--repo` against this instance's workspace: an exact id, then a
 * case-insensitive name, then a unique id prefix. Repos of other workspaces
 * never match — `tables.repos.list()` is workspace-scoped.
 */
export function resolveRepo(ref: string): { repo?: Repo; error?: string } {
  const needle = ref.trim()
  if (!needle) return { error: 'repo name or id required' }
  const inWorkspace = tables.repos.list()
  const byId = inWorkspace.find((p) => p.id === needle)
  if (byId) return { repo: byId }
  const byName = inWorkspace.filter((p) => p.name.toLowerCase() === needle.toLowerCase())
  if (byName.length === 1) return { repo: byName[0] }
  if (byName.length > 1) {
    return { error: `repo name '${needle}' is ambiguous — use its id (${byName.map((p) => p.id).join(', ')})` }
  }
  const byPrefix = inWorkspace.filter((p) => p.id.startsWith(needle))
  if (byPrefix.length === 1) return { repo: byPrefix[0] }
  if (byPrefix.length > 1) return { error: `repo id '${needle}' is ambiguous (${byPrefix.length} matches)` }
  return { error: `no repo '${needle}' in this workspace (see \`orbital repos\`)` }
}

/**
 * Check the client-supplied ORBITAL_* ids against this workspace. The env is
 * untrusted: `tables.worktrees.get` / `tables.tabs.get` are not workspace-scoped, so
 * a spoofed id could otherwise reach another workspace's worktree.
 *
 * - a worktree id must belong to a repo of this workspace, and to the env
 *   repo when one came along;
 * - a terminal id must belong to a tab in such a worktree.
 *
 * An id that matches nothing passes: there is nothing to act on, and the
 * handlers already answer "not found" / no-op (e.g. a hook from a just-closed
 * tab). Cost: two primary-key lookups plus the repo list, cheap enough for
 * the status/hook path.
 */
function validateEnvIds(req: ControlRequest, repoIds: Set<string>): string | undefined {
  if (req.worktreeId) {
    const wt = tables.worktrees.get(req.worktreeId)
    if (wt) {
      if (!repoIds.has(wt.repoId)) return `worktree '${req.worktreeId}' is not in this workspace`
      if (req.repoId && wt.repoId !== req.repoId) {
        return `worktree '${req.worktreeId}' does not belong to repo '${req.repoId}'`
      }
    }
  }
  if (req.terminalId) {
    const tab = tables.tabs.get(req.terminalId)
    if (tab) {
      const wt = tables.worktrees.get(tab.worktreeId)
      if (!wt || !repoIds.has(wt.repoId)) return `terminal '${req.terminalId}' is not in this workspace`
      if (req.worktreeId && tab.worktreeId !== req.worktreeId) {
        return `terminal '${req.terminalId}' does not belong to worktree '${req.worktreeId}'`
      }
      if (req.repoId && wt.repoId !== req.repoId) {
        return `terminal '${req.terminalId}' does not belong to repo '${req.repoId}'`
      }
    }
  }
  return undefined
}

/**
 * Settle which repo a request acts on, before any handler sees it.
 *
 * Without `--repo` a command stays scoped to the calling terminal's repo
 * (ORBITAL_REPO_ID). Passing `--repo` explicitly is the opt-in to reach a
 * sibling repo — reads and writes alike. Either way the id must belong to
 * this instance's workspace: the env is client-supplied, so a spoofed id must
 * not reach another workspace's repo (e.g. through `worktree new`). The
 * worktree/terminal ids are validated too, against the env repo — before
 * `--repo` overrides it, since the override only retargets task/worktree
 * commands, not the calling terminal's own identity.
 */
export function scopeRequest(req: ControlRequest): { req?: ControlRequest; error?: string } {
  const repos = tables.repos.list()
  if (req.repoId && !repos.some((p) => p.id === req.repoId)) {
    return { error: `repo '${req.repoId}' is not in this workspace` }
  }
  if (req.worktreeId || req.terminalId) {
    const error = validateEnvIds(req, new Set(repos.map((p) => p.id)))
    if (error) return { error }
  }
  const ref = req.args.repo
  if (ref !== undefined && ref !== null && ref !== '') {
    const { repo, error } = resolveRepo(String(ref))
    if (!repo) return { error }
    return { req: { ...req, repoId: repo.id } }
  }
  return { req }
}

/**
 * Resolve a task by number (`12` / `#12`), full id, or unique id prefix within a
 * repo. Archived tasks resolve too, so `task show` / `update` / `unarchive`
 * can still reach them — an archived #12 stays #12.
 */
export function resolveTask(repoId: string, idArg: string): { task?: ReturnType<typeof tables.tasks.get>; error?: string } {
  const inRepo = tables.tasks.list('all').filter((t) => t.repoId === repoId)
  if (/^#?\d+$/.test(idArg)) {
    const seq = Number.parseInt(idArg.replace('#', ''), 10)
    const task = inRepo.find((t) => t.seq === seq)
    return task ? { task } : { error: `no task matches number '${idArg}'` }
  }
  const candidates = inRepo.filter((t) => t.id === idArg || t.id.startsWith(idArg))
  if (candidates.length === 0) return { error: `no task matches id '${idArg}'` }
  if (candidates.length > 1) return { error: `id '${idArg}' is ambiguous (${candidates.length} matches)` }
  return { task: candidates[0] }
}

/** The task shape the CLI prints and `--json` emits. */
export function taskDto(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    seq: t.seq,
    status: t.status,
    title: t.title,
    description: t.description,
    tags: t.tags,
    worktreeId: t.worktreeId,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    archivedAt: t.archivedAt
  }
}
