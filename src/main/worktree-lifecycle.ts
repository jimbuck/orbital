import { existsSync } from 'node:fs'
import type { Worktree } from '@shared/types'
import { runtime, repo } from './runtime'
import { git } from './services/git'
import { planWorktreeSync, pathsBeingCreated, WorktreesWatcher } from './services/worktree-scan'
import { copyNodeModulesTree, hasIncompleteCopy, syncEnvFiles, targetsNodeModules } from './services/env-sync'
import { deleteBriefing } from './services/agents/briefing'
import { logger } from './services/logger'
import { getSettings } from './services/settings'
import { killWorktreeTerminals } from './tabs'
import { forgetTabStatus } from './status'

/**
 * Project and Worktree lifecycle: registration, background setup after
 * creation, env resync, discovery of checkouts made outside Orbital, teardown
 * of everything the runtime holds for a Worktree, and boot-time resume.
 */

/**
 * Kick off a freshly created linked Worktree's background setup: bulk-copy
 * node_modules off the critical path (awaiting it would block worktree creation
 * for minutes), flagging the worktree as "setting up" so the rail shows a
 * spinner until the copy finishes. No-op for root Worktrees or when
 * node_modules isn't a sync target.
 *
 * The outcome goes to the log either way. There is no in-app channel for a
 * background failure, and the spinner clearing is the only thing the rail can
 * say — so the report (files, bytes, errors, duration) is what a "why is my
 * worktree missing packages" question gets answered from.
 */
export function beginWorktreeSetup(worktree: Worktree, repoPath: string): void {
  if (worktree.kind !== 'linked') return
  if (!targetsNodeModules(getSettings().envSyncPatterns)) return
  runtime.markSettingUp(worktree.id)
  logger.info('node_modules copy started', { worktree: worktree.name, from: repoPath })
  // The failure actually seen in the field was a copy that made no progress
  // for a quarter of an hour and reported nothing. Whatever its cause, that
  // shape is now at least visible: a progress counter, and a warning when it
  // stops moving. (A copy queued behind another for the same root has not
  // started yet and is not "stalled"; the counter only exists once it runs.)
  let done = 0
  let seen = -1
  const watchdog = setInterval(() => {
    if (done === seen && done > 0) {
      logger.warn('node_modules copy has made no progress', {
        worktree: worktree.name,
        files: done,
        seconds: COPY_STALL_SECONDS
      })
    }
    seen = done
  }, COPY_STALL_SECONDS * 1000)
  void copyNodeModulesTree(repoPath, worktree.path, {
    onProgress: (n) => {
      done = n
    }
  })
    .then((report) => {
      const level = report.errorCount > 0 ? 'warn' : 'info'
      logger[level]('node_modules copy finished', { worktree: worktree.name, ...report })
    })
    .catch((err: unknown) => {
      logger.error('node_modules copy failed', {
        worktree: worktree.name,
        message: err instanceof Error ? err.message : String(err)
      })
    })
    .finally(() => {
      clearInterval(watchdog)
      runtime.clearSettingUp(worktree.id)
    })
}

/** How long a running node_modules copy may go without copying a file before the log says so. */
const COPY_STALL_SECONDS = 60

/**
 * Copy the root checkout's env files into a linked Worktree again — the same
 * one-shot sync a fresh worktree gets at creation, on request. This is the
 * ONLY way a worktree's synced files change after creation (see env-sync.ts
 * for why there is no watcher), and it overwrites: the root is the source of
 * truth whenever the user asks it to be. node_modules is not part of it — that
 * is a one-time bulk copy, and a package install in the worktree is how it
 * catches up.
 */
export async function syncWorktreeEnv(worktreeId: string): Promise<{ copied: string[] }> {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) throw new Error(`worktree ${worktreeId} not found`)
  if (worktree.kind !== 'linked') throw new Error('the root checkout is what env files are synced from')
  const project = repo.projects.get(worktree.projectId)
  if (!project) throw new Error(`project ${worktree.projectId} not found`)
  const copied = await syncEnvFiles(project.repoPath, worktree.path, getSettings().envSyncPatterns)
  logger.info('env files synced from root', { worktree: worktree.name, copied: copied.length })
  // The editor's file tree refetches on the git-changed push.
  runtime.broadcastGitChanged([worktreeId])
  return { copied }
}

/** Register a project: create its root Worktree and start its watchers. */
export async function registerProject(repoPath: string): Promise<Worktree | null> {
  const existing = repo.projects.getByPath(repoPath)
  if (existing) {
    runtime.gitWatcher.watch(repoPath)
    ensureWorktreesWatcher(existing)
    return repo.worktrees.list().find((w) => w.projectId === existing.id && w.kind === 'root') ?? null
  }
  const name = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath
  const project = repo.projects.create({ name, repoPath })
  const branch = await git.currentBranch(repoPath).catch(() => 'main')
  const root = repo.worktrees.create({
    projectId: project.id,
    kind: 'root',
    name: 'main',
    path: repoPath,
    branch
  })
  runtime.gitWatcher.watch(repoPath)
  ensureWorktreesWatcher(project)
  return root
}

/* ---- git worktree auto-discovery ---------------------------------------- */

/** One admin-dir watcher per project so external worktree add/remove shows live. */
const worktreesWatchers = new Map<string, WorktreesWatcher>()

function ensureWorktreesWatcher(project: { id: string; repoPath: string }): void {
  if (worktreesWatchers.has(project.id)) return
  const watcher = new WorktreesWatcher(project.repoPath)
  worktreesWatchers.set(project.id, watcher)
  watcher.on('changed', () => void reconcileProjectWorktrees(project.id))
  void watcher.start()
}

export function removeWorktreesWatcher(projectId: string): void {
  worktreesWatchers.get(projectId)?.stop()
  worktreesWatchers.delete(projectId)
}

/** Stop every discovery watcher (app shutdown). */
export function stopWorktreesWatchers(): void {
  for (const watcher of worktreesWatchers.values()) watcher.stop()
  worktreesWatchers.clear()
}

/** Tear down everything the runtime holds for a Worktree (PTYs, watchers, servers, briefings). */
export function releaseWorktreeRuntime(worktree: Worktree): void {
  killWorktreeTerminals(worktree.id)
  runtime.clearDevServers(worktree.id)
  if (worktree.kind === 'linked') {
    runtime.gitWatcher.unwatch(worktree.path)
  }
  for (const pane of worktree.panes) {
    for (const tab of pane.tabs) {
      if (tab.type === 'agent') deleteBriefing(worktree.id, tab.id)
      forgetTabStatus(tab.id)
    }
  }
}

/**
 * Make a project's Worktrees match `git worktree list`: adopt checkouts created
 * outside Orbital, drop rows whose checkout is gone (their tabs/layout go too —
 * UI state is keyed to a live checkout), and resync branches. Broadcasts only
 * when something actually changed.
 */
export async function reconcileProjectWorktrees(projectId: string): Promise<void> {
  const project = repo.projects.get(projectId)
  if (!project) return
  let entries
  try {
    entries = await git.worktreeList(project.repoPath)
  } catch {
    return // repo dir missing or not a git repo — leave the stored rows alone
  }
  // Everything from here to the end of the apply below is synchronous, so it sees
  // one consistent picture: no create can slip in between the rows snapshot, the
  // in-flight list, and the writes.
  const rows = repo.worktrees.list().filter((w) => w.projectId === projectId)
  // A checkout that IS another project belongs to that project's rail entry; one
  // Orbital is still creating gets its row from createLinkedWorktree, not here.
  const skip = [
    ...repo.projects
      .list()
      .filter((p) => p.id !== projectId)
      .map((p) => p.repoPath),
    ...pathsBeingCreated()
  ]
  const plan = planWorktreeSync(project, rows, entries, skip)
  if (!plan.createRoot && plan.adopt.length === 0 && plan.remove.length === 0 && plan.branchUpdates.length === 0) {
    return
  }

  // A project that entered via the workspace YAML starts without a root row.
  if (plan.createRoot) {
    repo.worktrees.create({
      projectId,
      kind: 'root',
      name: 'main',
      path: project.repoPath,
      branch: plan.createRoot.branch
    })
  }
  for (const a of plan.adopt) {
    repo.worktrees.create({ projectId, kind: 'linked', name: a.name, path: a.path, branch: a.branch })
    runtime.gitWatcher.watch(a.path)
  }
  for (const row of plan.remove) {
    releaseWorktreeRuntime(row)
    repo.worktrees.remove(row.id)
  }
  for (const u of plan.branchUpdates) repo.worktrees.updateBranchByPath(u.path, u.branch)

  runtime.broadcastState()
  runtime.broadcastAlert()
}

/** On startup, resume watchers for already-registered projects and their worktrees. */
export function resumeProjects(): void {
  const checkouts = new Set<string>()
  for (const project of repo.projects.list()) {
    runtime.gitWatcher.watch(project.repoPath)
    ensureWorktreesWatcher(project)
    checkouts.add(project.repoPath)
  }
  for (const w of repo.worktrees.list()) {
    if (w.kind === 'linked' && existsSync(w.path)) {
      runtime.gitWatcher.watch(w.path)
      checkouts.add(w.path)
      // A node_modules copy that was still running when the app last quit (or
      // that never finished) left its marker behind. Pick it up where it
      // stopped: the copy skips files the worktree already has.
      if (hasIncompleteCopy(w.path)) {
        const project = repo.projects.get(w.projectId)
        if (project) {
          logger.info('resuming interrupted node_modules copy', { worktree: w.name })
          beginWorktreeSetup(w, project.repoPath)
        }
      }
    }
  }
  // Reconcile every project against `git worktree list` (adopt checkouts created
  // outside Orbital while it was closed, drop vanished ones), then resync
  // branches — they can move while the app is closed.
  void Promise.all(repo.projects.list().map((p) => reconcileProjectWorktrees(p.id)))
    .then(() => Promise.all([...checkouts].map((p) => runtime.refreshBranch(p))))
    .then(() => runtime.broadcastState())
}
