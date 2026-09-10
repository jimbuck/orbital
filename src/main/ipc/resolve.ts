import { repo } from '../runtime'

/**
 * The checkout a renderer-named Worktree or project lives at. Every file and
 * git handler resolves its target through one of these: the renderer names
 * an id, main looks up the path it stored itself.
 */
export function worktreeRepoPath(worktreeId: string): string {
  const w = repo.worktrees.get(worktreeId)
  if (!w) throw new Error(`worktree ${worktreeId} not found`)
  return w.path
}

export function projectRepoPath(projectId: string): string {
  const p = repo.projects.get(projectId)
  if (!p) throw new Error(`project ${projectId} not found`)
  return p.repoPath
}
