import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { git } from './git'
import { syncEnvFiles } from './env-sync'
import { flights as flightRepo } from '../db/repositories'
import type { Workspace, Flight } from '@shared/types'

/** Turn a branch/title into a filesystem- and git-safe slug. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9/_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-/]+|[-/]+$/g, '') || 'flight'
  )
}

/**
 * Worktrees live in a sibling directory so they never pollute the repo's own
 * working tree: <repoParent>/.orbital-worktrees/<repoName>/<slug>.
 */
export function worktreeBaseDir(workspace: Workspace): string {
  return join(dirname(workspace.repoPath), '.orbital-worktrees', basename(workspace.repoPath))
}

function uniqueWorktreePath(workspace: Workspace, slug: string): string {
  const base = worktreeBaseDir(workspace)
  let candidate = join(base, slug.replace(/\//g, '-'))
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(base, `${slug.replace(/\//g, '-')}-${n}`)
    n++
  }
  return candidate
}

export interface CreateWorktreeFlightInput {
  workspace: Workspace
  /** Branch to check out or create. */
  branch: string
  name?: string
  baseRef?: string
  taskId?: string | null
}

/**
 * Create a git worktree on `branch`, register a worktree Flight for it, and
 * sync the workspace's env files into the new checkout (PRD §5, §8).
 */
export async function createWorktreeFlight(input: CreateWorktreeFlightInput): Promise<Flight> {
  const { workspace } = input
  const repoPath = workspace.repoPath
  // Slugify so a multi-word Flight name (e.g. "Login flow") becomes a valid git
  // ref ("login-flow"); an explicit ref like "feat/login" passes through.
  const raw = input.branch.trim()
  const baseSlug = slugify(raw)

  let branch = baseSlug
  let worktreePath = uniqueWorktreePath(workspace, baseSlug)
  let attached = false

  if (await git.branchExists(repoPath, baseSlug)) {
    // The branch already exists: attach a worktree to it (only possible when it
    // is not already checked out in another worktree).
    try {
      await git.worktreeAdd(repoPath, { branch: baseSlug, worktreePath, newBranch: false })
      attached = true
    } catch {
      // Already checked out elsewhere — fall through and fork a fresh branch.
    }
  }

  if (!attached) {
    // Create a NEW branch, suffixing the slug until the ref is free, and reuse
    // that unique slug for the worktree directory (PRD §8 collision suffixing).
    branch = baseSlug
    let n = 2
    while (await git.branchExists(repoPath, branch)) {
      branch = `${baseSlug}-${n}`
      n++
    }
    worktreePath = uniqueWorktreePath(workspace, branch)
    await git.worktreeAdd(repoPath, { branch, worktreePath, baseRef: input.baseRef, newBranch: true })
  }

  const flight = flightRepo.create({
    workspaceId: workspace.id,
    kind: 'worktree',
    name: input.name?.trim() || raw,
    worktreePath,
    branch,
    taskId: input.taskId ?? null
  })

  // Best-effort env sync; a worktree should still come up if a file fails.
  try {
    await syncEnvFiles(workspace.repoPath, worktreePath, workspace.envSyncPatterns)
  } catch {
    /* env sync is non-fatal */
  }

  return flight
}

/** Remove the git worktree backing a Flight (guarded by the caller). */
export async function removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
  await git.worktreeRemove(repoPath, worktreePath, force)
}
