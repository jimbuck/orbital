import { existsSync } from 'node:fs'
import {
  isPtyTabType,
  type Project,
  type Repo,
  type RemoveWorktreeOptions,
  type TaskPatch,
  type Worktree
} from '@shared/types'
import { runtime, tables } from './runtime'
import { git } from './services/git'
import { createLinkedWorktree, removeWorktree as removeCheckout } from './services/worktree'
import { planWorktreeSync, pathsBeingCreated, WorktreesWatcher } from './services/worktree-scan'
import { copyNodeModulesTree, hasIncompleteCopy, syncEnvFiles, targetsNodeModules } from './services/env-sync'
import { startPtyTab } from './services/agents/launch'
import { scheduleProjectPointers } from './services/project-pointers'
import { logger } from './services/logger'
import { getSettings } from './services/settings'
import { killWorktreeTerminals, releaseTabRuntime } from './tabs'
import { forgetTabs } from './status'

/**
 * Repo and Worktree lifecycle. The window's IPC handlers and the CLI's
 * control handlers both come through here to add or remove a Repo and to
 * create or remove a Worktree, so each of those is one sequence: the git
 * checkout, the rows, the task link, the watchers, background setup, teardown
 * with rollback, and the pushes that tell the window it happened.
 *
 * Also here: env resync, discovery of checkouts made outside Orbital, and
 * boot-time resume.
 */

/** What a caller says to start a Worktree; everything else is decided here. */
export interface CreateWorktreeInput {
  repoId: string
  /** New branch to create (slugified). Defaults to the name, then the task's title. */
  branch?: string
  /** Check out this existing branch (local, or `origin/x` remote) instead of creating one. */
  existingBranch?: string
  /** Display name. Defaults to the task's title, then the branch. */
  name?: string
  /** Ref the new branch forks from (defaults to HEAD). */
  baseRef?: string
  /** The task this Worktree is started from. */
  taskId?: string
}

/**
 * Create a linked Worktree: a real `git worktree` on its own branch, its row
 * and first pane, env files copied in, the git watcher on, and the heavy
 * node_modules copy started in the background.
 *
 * Started from a task, the two are linked both ways and the task moves to
 * in-progress (unless it is already there, or done): opening a Worktree for a
 * task is starting it, whichever door the request came through.
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
  const repo = tables.repos.get(input.repoId)
  if (!repo) throw new Error(`repo ${input.repoId} not found`)
  const task = input.taskId ? tables.tasks.get(input.taskId) : undefined
  if (input.taskId && !task) throw new Error(`task ${input.taskId} not found`)
  // A tag never takes a task across projects, and a worktree pins its task's repo.
  if (task && task.projectId !== repo.projectId) {
    throw new Error(`task #${task.seq} is not in the project of repo ${repo.name}`)
  }

  const name = input.name?.trim() || task?.title
  const branch = input.branch?.trim() || name || `worktree-${Date.now()}`
  const created = await createLinkedWorktree({
    repo,
    branch,
    existingBranch: input.existingBranch,
    name,
    baseRef: input.baseRef,
    taskId: task?.id ?? null
  })
  if (task) {
    // Starting it is also filing it: an untagged task (or one tagged with
    // another repo) now lives where its worktree does.
    const patch: TaskPatch = {}
    if (task.status !== 'in_progress' && task.status !== 'done') patch.status = 'in_progress'
    if (task.repoId !== repo.id) patch.repoId = repo.id
    if (Object.keys(patch).length) tables.tasks.update(task.id, patch)
  }
  runtime.gitWatcher.watch(created.path)
  beginWorktreeSetup(created, repo.repoPath)
  announce()
  return tables.worktrees.get(created.id) ?? created
}

/**
 * Remove a Worktree from the cockpit and, with `removeWorktree`, delete its
 * git checkout too. The root Worktree cannot be removed.
 *
 * Deleting the checkout refuses a dirty working tree unless forced, and
 * checks BEFORE tearing anything down, so a refused removal leaves the
 * Worktree fully intact and its unpushed work is not silently orphaned
 * (PRD §5 unpushed-work guard). If git still cannot remove it, the Worktree
 * is put back in a usable state (watcher on, fresh PTYs) and the error is
 * rethrown.
 */
export async function removeWorktree(worktreeId: string, opts: RemoveWorktreeOptions = {}): Promise<void> {
  const worktree = tables.worktrees.get(worktreeId)
  if (!worktree) return
  if (worktree.kind === 'root') throw new Error('the root Worktree cannot be removed')
  // A project's folder session comes and goes with the project's shape (see
  // settleProjectSessions), never on its own.
  if (worktree.kind === 'folder') throw new Error("a project's folder session cannot be removed")
  const repo = opts.removeWorktree && worktree.repoId ? tables.repos.get(worktree.repoId) : undefined
  if (repo) {
    if (!opts.force && !(await git.status(worktree.path)).clean) {
      throw new Error('The worktree has uncommitted changes.')
    }
    // Release everything holding handles inside the worktree before git
    // deletes it — on Windows a PTY cwd'd there (or a directory watcher)
    // locks the folder and makes the removal fail on the first attempt.
    runtime.gitWatcher.unwatch(worktree.path)
    killWorktreeTerminals(worktreeId)
    try {
      await removeCheckout(repo.repoPath, worktree.path, opts.force)
    } catch (err) {
      runtime.gitWatcher.watch(worktree.path)
      for (const pane of worktree.panes) {
        for (const tab of pane.tabs) if (isPtyTabType(tab.type)) startPtyTab(worktree, tab)
      }
      announce()
      throw err
    }
  }
  releaseWorktreeRuntime(worktree)
  tables.worktrees.remove(worktreeId)
  announce()
}

/**
 * Add a git repository as a Repo: its root Worktree, its watchers, and any
 * worktrees the repo already has (they show up immediately). Adding a path
 * that is already a Repo returns that Repo.
 */
export async function addRepo(repoPath: string, projectId?: string): Promise<Repo> {
  await registerRepo(repoPath, projectId)
  let repo = tables.repos.getByPath(repoPath)
  if (!repo) throw new Error(`repo at ${repoPath} was not registered`)
  // Already added, but asked for in another project: move it there.
  if (projectId && repo.projectId !== projectId) {
    tables.projects.addRepo(projectId, repo.id, null)
    repo = tables.repos.get(repo.id) ?? repo
  }
  await reconcileRepoWorktrees(repo.id)
  settleProjectSessions()
  announce()
  scheduleProjectPointers()
  return repo
}

/** Remove a Repo from the cockpit. Its checkouts stay on disk. */
export function removeRepo(repoId: string): void {
  const repo = tables.repos.get(repoId)
  if (!repo) return
  releaseRepoRuntime(repo)
  tables.repos.remove(repoId)
  settleProjectSessions()
  announce()
  scheduleProjectPointers()
}

/**
 * Remove a Project and every repo in it from the cockpit, each repo's
 * runtime torn down as {@link removeRepo} does. Nothing on disk changes.
 */
export function removeProject(projectId: string): void {
  const project = tables.projects.get(projectId)
  if (!project) return
  for (const repoId of project.repoIds) {
    const repo = tables.repos.get(repoId)
    if (repo) releaseRepoRuntime(repo)
  }
  const folder = tables.worktrees.folderOf(projectId)
  if (folder) releaseWorktreeRuntime(folder)
  tables.projects.remove(projectId)
  announce()
  // Its home (if any) loses the managed repo list this instance wrote.
  scheduleProjectPointers()
}

/* ---- project sessions ----------------------------------------------------- */

/**
 * Whether a project's session is a folder session: it has no home repo, and
 * it is a group rather than a plain repo row (which is one repo and no home,
 * and whose session is that repo's root). A project with no repos yet is a
 * group too, so it still has somewhere to open a terminal.
 */
export function wantsFolderSession(project: Pick<Project, 'homeRepoId' | 'repoIds'>): boolean {
  return project.homeRepoId === null && project.repoIds.length !== 1
}

/**
 * Make every project's folder session match its shape. A project that has
 * just become a no-home group (two repos joined, its home cleared, made
 * empty) gets a `folder` worktree at its root, with one empty pane; one that
 * stopped being one (a home was set, it went back to a plain repo row, it was
 * ungrouped) loses it, with its terminals and agents torn down first, as
 * {@link removeWorktree} does for a checkout. A root that moved moves the
 * session's directory and name with it (open terminals keep the cwd they
 * started in). Rows plus runtime, no push: callers announce.
 *
 * Every grouping change goes through here (the project IPC, adding and
 * removing repos, boot), so the rule lives in one place and a crash between
 * the grouping write and this one heals on the next boot.
 */
export function settleProjectSessions(): void {
  const projects = tables.projects.list()
  const wanted = new Map(projects.filter(wantsFolderSession).map((p) => [p.id, p]))
  const have = new Map<string, Worktree>()
  for (const w of tables.worktrees.list()) {
    if (w.kind !== 'folder') continue
    const project = wanted.get(w.projectId)
    if (!project || have.has(project.id)) {
      releaseWorktreeRuntime(w)
      tables.worktrees.remove(w.id)
      continue
    }
    have.set(project.id, w)
    if (w.path !== project.rootPath) tables.worktrees.setPath(w.id, project.rootPath)
    if (w.name !== project.name) tables.worktrees.rename(w.id, project.name)
  }
  for (const project of wanted.values()) {
    if (have.has(project.id)) continue
    tables.worktrees.create({
      repoId: null,
      projectId: project.id,
      kind: 'folder',
      name: project.name,
      path: project.rootPath,
      branch: ''
    })
  }
}

/** Stop everything a Repo holds open: its Worktrees' terminals and status, and its watchers. */
function releaseRepoRuntime(repo: Repo): void {
  for (const w of tables.worktrees.list()) {
    if (w.repoId === repo.id) releaseWorktreeRuntime(w)
  }
  runtime.gitWatcher.unwatch(repo.repoPath)
  removeWorktreesWatcher(repo.id)
}

/** The set of Worktrees changed: push the state, and the alert their statuses feed. */
function announce(): void {
  runtime.broadcastState()
  runtime.broadcastAlert()
}

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
function beginWorktreeSetup(worktree: Worktree, repoPath: string): void {
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
  const worktree = tables.worktrees.get(worktreeId)
  if (!worktree) throw new Error(`worktree ${worktreeId} not found`)
  if (worktree.kind !== 'linked' || !worktree.repoId) {
    throw new Error('the root checkout is what env files are synced from')
  }
  const repo = tables.repos.get(worktree.repoId)
  if (!repo) throw new Error(`repo ${worktree.repoId} not found`)
  const copied = await syncEnvFiles(repo.repoPath, worktree.path, getSettings().envSyncPatterns)
  logger.info('env files synced from root', { worktree: worktree.name, copied: copied.length })
  // The editor's file tree refetches on the git-changed push.
  runtime.broadcastGitChanged([worktreeId])
  return { copied }
}

/**
 * Register a repo: create its root Worktree and start its watchers. It joins
 * `projectId` when given, and otherwise gets a project of its own.
 */
async function registerRepo(repoPath: string, projectId?: string): Promise<Worktree | null> {
  const existing = tables.repos.getByPath(repoPath)
  if (existing) {
    runtime.gitWatcher.watch(repoPath)
    ensureWorktreesWatcher(existing)
    return tables.worktrees.list().find((w) => w.repoId === existing.id && w.kind === 'root') ?? null
  }
  const name = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath
  const repo = tables.repos.create({ name, repoPath, projectId })
  const branch = await git.currentBranch(repoPath).catch(() => 'main')
  const root = tables.worktrees.create({
    repoId: repo.id,
    kind: 'root',
    name: 'main',
    path: repoPath,
    branch
  })
  runtime.gitWatcher.watch(repoPath)
  ensureWorktreesWatcher(repo)
  return root
}

/* ---- git worktree auto-discovery ---------------------------------------- */

/** One admin-dir watcher per repo so external worktree add/remove shows live. */
const worktreesWatchers = new Map<string, WorktreesWatcher>()

function ensureWorktreesWatcher(repo: { id: string; repoPath: string }): void {
  if (worktreesWatchers.has(repo.id)) return
  const watcher = new WorktreesWatcher(repo.repoPath)
  worktreesWatchers.set(repo.id, watcher)
  watcher.on('changed', () => void reconcileRepoWorktrees(repo.id))
  void watcher.start()
}

function removeWorktreesWatcher(repoId: string): void {
  worktreesWatchers.get(repoId)?.stop()
  worktreesWatchers.delete(repoId)
}

/** Stop every discovery watcher (app shutdown). */
export function stopWorktreesWatchers(): void {
  for (const watcher of worktreesWatchers.values()) watcher.stop()
  worktreesWatchers.clear()
}

/** Tear down everything the runtime holds for a Worktree (PTYs, watchers, servers, briefings). */
function releaseWorktreeRuntime(worktree: Worktree): void {
  const tabs = worktree.panes.flatMap((pane) => pane.tabs)
  for (const tab of tabs) releaseTabRuntime(tab)
  runtime.clearDevServers(worktree.id)
  if (worktree.kind === 'linked') {
    runtime.gitWatcher.unwatch(worktree.path)
  }
  forgetTabs(tabs.map((t) => t.id))
}

/**
 * Make a repo's Worktrees match `git worktree list`: adopt checkouts created
 * outside Orbital, drop rows whose checkout is gone (their tabs/layout go too —
 * UI state is keyed to a live checkout), and resync branches. Broadcasts only
 * when something actually changed.
 */
export async function reconcileRepoWorktrees(repoId: string): Promise<void> {
  const repo = tables.repos.get(repoId)
  if (!repo) return
  let entries
  try {
    entries = await git.worktreeList(repo.repoPath)
  } catch {
    return // repo dir missing or not a git repo — leave the stored rows alone
  }
  // Everything from here to the end of the apply below is synchronous, so it sees
  // one consistent picture: no create can slip in between the rows snapshot, the
  // in-flight list, and the writes.
  const rows = tables.worktrees.list().filter((w) => w.repoId === repoId)
  // A checkout that IS another repo belongs to that repo's rail entry; one
  // Orbital is still creating gets its row from createLinkedWorktree, not here.
  const skip = [
    ...tables.repos
      .list()
      .filter((p) => p.id !== repoId)
      .map((p) => p.repoPath),
    ...pathsBeingCreated()
  ]
  const plan = planWorktreeSync(repo, rows, entries, skip)
  if (!plan.createRoot && plan.adopt.length === 0 && plan.remove.length === 0 && plan.branchUpdates.length === 0) {
    return
  }

  // A repo that entered via the workspace YAML starts without a root row.
  if (plan.createRoot) {
    tables.worktrees.create({
      repoId,
      kind: 'root',
      name: 'main',
      path: repo.repoPath,
      branch: plan.createRoot.branch
    })
  }
  for (const a of plan.adopt) {
    tables.worktrees.create({ repoId, kind: 'linked', name: a.name, path: a.path, branch: a.branch })
    runtime.gitWatcher.watch(a.path)
  }
  for (const row of plan.remove) {
    releaseWorktreeRuntime(row)
    tables.worktrees.remove(row.id)
  }
  for (const u of plan.branchUpdates) tables.worktrees.updateBranchByPath(u.path, u.branch)

  announce()
}

/** On startup, resume watchers for already-registered repos and their worktrees. */
export function resumeRepos(): void {
  // Before anything reads the worktrees: a grouping written by an older build
  // (or one interrupted between its two writes) gets its folder sessions now.
  settleProjectSessions()
  // Every home repo's managed repo list, written or refreshed (off the boot path).
  scheduleProjectPointers()
  const checkouts = new Set<string>()
  for (const repo of tables.repos.list()) {
    runtime.gitWatcher.watch(repo.repoPath)
    ensureWorktreesWatcher(repo)
    checkouts.add(repo.repoPath)
  }
  for (const w of tables.worktrees.list()) {
    if (w.kind === 'linked' && existsSync(w.path)) {
      runtime.gitWatcher.watch(w.path)
      checkouts.add(w.path)
      // A node_modules copy that was still running when the app last quit (or
      // that never finished) left its marker behind. Pick it up where it
      // stopped: the copy skips files the worktree already has.
      if (hasIncompleteCopy(w.path) && w.repoId) {
        const repo = tables.repos.get(w.repoId)
        if (repo) {
          logger.info('resuming interrupted node_modules copy', { worktree: w.name })
          beginWorktreeSetup(w, repo.repoPath)
        }
      }
    }
  }
  // Reconcile every repo against `git worktree list` (adopt checkouts created
  // outside Orbital while it was closed, drop vanished ones), then resync
  // branches — they can move while the app is closed.
  void Promise.all(tables.repos.list().map((p) => reconcileRepoWorktrees(p.id)))
    .then(() => Promise.all([...checkouts].map((p) => runtime.refreshBranch(p))))
    .then(() => runtime.broadcastState())
}
