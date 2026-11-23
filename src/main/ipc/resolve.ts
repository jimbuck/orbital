import { tables } from '../runtime'

/**
 * The checkout a renderer-named Worktree or repo lives at. Every file and
 * git handler resolves its target through one of these: the renderer names
 * an id, main looks up the path it stored itself.
 */
export function worktreeRepoPath(worktreeId: string): string {
  const w = tables.worktrees.get(worktreeId)
  if (!w) throw new Error(`worktree ${worktreeId} not found`)
  return w.path
}

export function repoPathOf(repoId: string): string {
  const p = tables.repos.get(repoId)
  if (!p) throw new Error(`repo ${repoId} not found`)
  return p.repoPath
}
