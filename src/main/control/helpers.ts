import type { Task } from '@shared/types'
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

/** Resolve a task by number (`12` / `#12`), full id, or unique id prefix within a project. */
export function resolveTask(projectId: string, idArg: string): { task?: ReturnType<typeof repo.tasks.get>; error?: string } {
  const inProject = repo.tasks.list().filter((t) => t.projectId === projectId)
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
    worktreeId: t.worktreeId
  }
}
