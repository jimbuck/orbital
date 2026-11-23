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

/**
 * The checkout a git operation on a Worktree runs in. A project's folder
 * session has no git, so asking for one is an error the caller can show, not
 * a git command pointed at a folder that may sit above several repos.
 */
export function worktreeGitPath(worktreeId: string): string {
  const w = tables.worktrees.get(worktreeId)
  if (!w) throw new Error(`worktree ${worktreeId} not found`)
  if (w.kind === 'folder') throw new Error('Not a git checkout: this is a project folder session.')
  return w.path
}

/** Where a project's session runs: its home repo's path, else its root folder. */
export function projectSessionPath(projectId: string): string {
  const project = tables.projects.get(projectId)
  if (!project) throw new Error(`project ${projectId} not found`)
  const home = project.homeRepoId ? tables.repos.get(project.homeRepoId) : undefined
  return home?.repoPath ?? project.rootPath
}

export function repoPathOf(repoId: string): string {
  const p = tables.repos.get(repoId)
  if (!p) throw new Error(`repo ${repoId} not found`)
  return p.repoPath
}
