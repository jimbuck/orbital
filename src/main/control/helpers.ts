import type { ControlRequest, Project, Task } from '@shared/types'
import { repo } from '../runtime'

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
 * Resolve `--project` against this instance's workspace: an exact id, then a
 * case-insensitive name, then a unique id prefix. Projects of other workspaces
 * never match — `repo.projects.list()` is workspace-scoped.
 */
export function resolveProject(ref: string): { project?: Project; error?: string } {
  const needle = ref.trim()
  if (!needle) return { error: 'project name or id required' }
  const inWorkspace = repo.projects.list()
  const byId = inWorkspace.find((p) => p.id === needle)
  if (byId) return { project: byId }
  const byName = inWorkspace.filter((p) => p.name.toLowerCase() === needle.toLowerCase())
  if (byName.length === 1) return { project: byName[0] }
  if (byName.length > 1) {
    return { error: `project name '${needle}' is ambiguous — use its id (${byName.map((p) => p.id).join(', ')})` }
  }
  const byPrefix = inWorkspace.filter((p) => p.id.startsWith(needle))
  if (byPrefix.length === 1) return { project: byPrefix[0] }
  if (byPrefix.length > 1) return { error: `project id '${needle}' is ambiguous (${byPrefix.length} matches)` }
  return { error: `no project '${needle}' in this workspace (see \`orbital projects\`)` }
}

/**
 * Settle which project a request acts on, before any handler sees it.
 *
 * Without `--project` a command stays scoped to the calling terminal's project
 * (ORBITAL_PROJECT_ID). Passing `--project` explicitly is the opt-in to reach a
 * sibling project — reads and writes alike. Either way the id must belong to
 * this instance's workspace: the env is client-supplied, so a spoofed id must
 * not reach another workspace's project (e.g. through `worktree new`).
 */
export function scopeRequest(req: ControlRequest): { req?: ControlRequest; error?: string } {
  const ref = req.args.project
  if (ref !== undefined && ref !== null && ref !== '') {
    const { project, error } = resolveProject(String(ref))
    if (!project) return { error }
    return { req: { ...req, projectId: project.id } }
  }
  if (req.projectId && !repo.projects.list().some((p) => p.id === req.projectId)) {
    return { error: `project '${req.projectId}' is not in this workspace` }
  }
  return { req }
}

/**
 * Resolve a task by number (`12` / `#12`), full id, or unique id prefix within a
 * project. Archived tasks resolve too, so `task show` / `update` / `unarchive`
 * can still reach them — an archived #12 stays #12.
 */
export function resolveTask(projectId: string, idArg: string): { task?: ReturnType<typeof repo.tasks.get>; error?: string } {
  const inProject = repo.tasks.list('all').filter((t) => t.projectId === projectId)
  if (/^#?\d+$/.test(idArg)) {
    const seq = Number.parseInt(idArg.replace('#', ''), 10)
    const task = inProject.find((t) => t.seq === seq)
    return task ? { task } : { error: `no task matches number '${idArg}'` }
  }
  const candidates = inProject.filter((t) => t.id === idArg || t.id.startsWith(idArg))
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
