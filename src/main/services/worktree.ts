import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { git } from './git'
import { syncEnvFiles } from './env-sync'
import { worktrees as worktreeRepo } from '../db/repositories'
import { getSettings } from './settings'
import type { Project, Worktree } from '@shared/types'

/** Turn a branch/title into a filesystem- and git-safe slug. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9/_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-/]+|[-/]+$/g, '') || 'worktree'
  )
}

/**
 * Worktrees live in a sibling directory so they never pollute the repo's own
 * working tree: <repoParent>/.orbital-worktrees/<repoName>/<slug>.
 */
export function worktreeBaseDir(project: Project): string {
  return join(dirname(project.repoPath), '.orbital-worktrees', basename(project.repoPath))
}

function uniqueWorktreePath(project: Project, slug: string): string {
  const base = worktreeBaseDir(project)
  let candidate = join(base, slug.replace(/\//g, '-'))
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(base, `${slug.replace(/\//g, '-')}-${n}`)
    n++
  }
  return candidate
}

export interface CreateLinkedWorktreeInput {
  project: Project
  /** Branch to check out or create. */
  branch: string
  /** Check out this existing branch (local, or `origin/x` remote) instead of creating one. */
  existingBranch?: string
  name?: string
  baseRef?: string
  taskId?: string | null
}

/**
 * Create a git worktree on `branch`, register a linked Worktree for it, and
 * sync the project's env files into the new checkout (PRD §5, §8).
 */
export async function createLinkedWorktree(input: CreateLinkedWorktreeInput): Promise<Worktree> {
  const { project } = input
  const repoPath = project.repoPath

  let branch: string
  let worktreePath: string

  if (input.existingBranch) {
    // "Open existing branch": check the picked branch out into the new worktree
    // instead of forking a fresh one. A remote-only pick ("origin/pr-42") gets a
    // local tracking branch named after it.
    const picked = input.existingBranch.trim()
    const isLocal = await git.branchExists(repoPath, picked)
    branch = isLocal ? picked : picked.replace(/^[^/]+\//, '')
    worktreePath = uniqueWorktreePath(project, slugify(branch))
    if (isLocal || (await git.branchExists(repoPath, branch))) {
      try {
        await git.worktreeAdd(repoPath, { branch, worktreePath, newBranch: false })
      } catch (err) {
        // git refuses to check a branch out into two worktrees — say so plainly
        // instead of surfacing the raw fatal.
        const msg = err instanceof Error ? err.message : String(err)
        if (/already (checked out|used by)/i.test(msg)) {
          throw new Error(`Branch "${branch}" is already checked out in another worktree.`)
        }
        throw err
      }
    } else {
      await git.worktreeAdd(repoPath, { branch, worktreePath, baseRef: picked, newBranch: true, track: true })
    }
  } else {
    // Slugify so a multi-word Worktree name (e.g. "Login flow") becomes a valid git
    // ref ("login-flow"); an explicit ref like "feat/login" passes through.
    const baseSlug = slugify(input.branch.trim())

    branch = baseSlug
    worktreePath = uniqueWorktreePath(project, baseSlug)
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
      worktreePath = uniqueWorktreePath(project, branch)
      await git.worktreeAdd(repoPath, { branch, worktreePath, baseRef: input.baseRef, newBranch: true })
    }
  }

  const worktree = worktreeRepo.create({
    projectId: project.id,
    kind: 'linked',
    name: input.name?.trim() || branch,
    path: worktreePath,
    branch,
    taskId: input.taskId ?? null
  })

  // Small, fast files (env files + agent config dirs) sync BEFORE we return, so
  // they're present the moment the Flight opens. Best-effort: a worktree should
  // still come up if a file fails. The heavy node_modules copy is kicked off
  // separately by the caller (in the background), so it never blocks flight
  // creation — see ipc.ts / runtime.markSettingUp.
  try {
    await syncEnvFiles(project.repoPath, worktreePath, getSettings().envSyncPatterns)
  } catch {
    /* env sync is non-fatal */
  }

  return worktree
}

/**
 * Remove the git worktree backing a Worktree. The caller has already decided the
 * removal should proceed (the dirty guard passed, or force was given), so this
 * tears the worktree down as reliably as it can rather than giving up on the
 * first refusal.
 */
export async function removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
  // Idempotent: if the directory is already gone (a prior attempt deleted it, or
  // it was removed out-of-band) git's admin entry may still dangle — prune it and
  // treat that as success rather than throwing on the "not a working tree" error.
  if (!existsSync(worktreePath)) {
    await git.worktreePrune(repoPath).catch(() => {})
    return
  }

  // On Windows the directory can stay locked for a beat after the Worktree's PTYs
  // are killed: conpty releases the shell's cwd handle asynchronously (kill() is
  // fire-and-forget), and a directory watcher may not have fully torn down yet.
  // While any handle lingers `git worktree remove` fails with a delete/permission
  // error, so retry with backoff over a few seconds to let the handles drain.
  const delays = [0, 250, 500, 1000, 1000, 1000]
  let lastErr: unknown
  for (const ms of delays) {
    if (ms) await new Promise((r) => setTimeout(r, ms))
    // A previous attempt may have partially deleted the tree before failing;
    // once the directory is gone, retrying the same command just fails with a
    // different error ("is not a working tree"), so prune and finish instead.
    if (!existsSync(worktreePath)) {
      await git.worktreePrune(repoPath).catch(() => {})
      return
    }
    try {
      await git.worktreeRemove(repoPath, worktreePath, force)
      return
    } catch (err) {
      lastErr = err
    }
  }

  // git never managed it. Only fall back to deleting the directory ourselves when
  // the caller asked to force — a non-force refusal is git's unpushed-work guard
  // (the worktree may have gone dirty after ipc.ts took its clean snapshot, e.g. a
  // still-dying agent PTY flushed a file), and blindly fs.rm'ing would destroy that
  // uncommitted work. Surface the git error instead so the UI can offer a force step.
  if (!force) throw lastErr
  // Forced: the handle is still held, or git partially deleted the tree and now
  // refuses the leftover. Delete the directory ourselves — fs.rm's own retry loop
  // rides out the last of the Windows lock.
  try {
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (err) {
    // Couldn't delete the folder either — surface the original git error, which
    // is more informative than fs.rm's bare EBUSY/EPERM on the locked file.
    throw lastErr ?? err
  }
  // Directory is gone; make git drop the now-dangling worktree admin entry.
  await git.worktreePrune(repoPath).catch(() => {})
}
