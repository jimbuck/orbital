import { IPC, isPtyTabType, type CreateWorktreeOptions, type RemoveWorktreeOptions } from '@shared/types'
import { runtime, repo } from '../runtime'
import { git } from '../services/git'
import { createLinkedWorktree, removeWorktree } from '../services/worktree'
import { startPtyTab } from '../services/agents/launch'
import { killWorktreeTerminals } from '../tabs'
import { beginWorktreeSetup, releaseWorktreeRuntime, syncWorktreeEnv } from '../worktree-lifecycle'
import { resetWorktree } from '../status'
import { handle, broadcast, broadcastAll } from './handle'

/** Worktrees: create / remove / rename, env resync, and the force status clear. */
export function register(): void {
  const h = handle
  // ---- worktrees / panes / tabs ----
  h(IPC.createWorktree, async (_e, projectId: string, opts: CreateWorktreeOptions) => {
    const project = repo.projects.get(projectId)
    if (!project) throw new Error(`project ${projectId} not found`)
    const branch = (opts.branch || opts.name || `worktree-${Date.now()}`).trim()
    const worktree = await createLinkedWorktree({
      project,
      branch,
      existingBranch: opts.existingBranch,
      name: opts.name,
      baseRef: opts.baseRef,
      taskId: opts.taskId
    })
    runtime.gitWatcher.watch(worktree.path)
    beginWorktreeSetup(worktree, project.repoPath)
    broadcastAll()
    return repo.worktrees.get(worktree.id)!
  })

  h(IPC.removeWorktree, async (_e, worktreeId: string, opts: RemoveWorktreeOptions) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    if (worktree.kind === 'root') throw new Error('the root Worktree cannot be removed')
    if (opts.removeWorktree) {
      const project = repo.projects.get(worktree.projectId)
      if (project) {
        // Dirty guard BEFORE tearing anything down, so a refused removal leaves
        // the Worktree fully intact and its unpushed work is not silently
        // orphaned (PRD §5 unpushed-work guard).
        if (!opts.force && !(await git.status(worktree.path)).clean) {
          throw new Error('The worktree has uncommitted changes.')
        }
        // Release everything holding handles inside the worktree before git
        // deletes it — on Windows a PTY cwd'd there (or a directory watcher)
        // locks the folder and makes the removal fail on the first attempt.
        runtime.gitWatcher.unwatch(worktree.path)
        killWorktreeTerminals(worktreeId)
        try {
          await removeWorktree(project.repoPath, worktree.path, opts.force)
        } catch (err) {
          // Removal still failed — restore the Worktree to a usable state
          // (watchers back on, fresh PTYs) before surfacing the error.
          runtime.gitWatcher.watch(worktree.path)
          for (const pane of worktree.panes) {
            for (const tab of pane.tabs) if (isPtyTabType(tab.type)) startPtyTab(worktree, tab)
          }
          broadcastAll()
          throw err
        }
      }
    }
    releaseWorktreeRuntime(worktree)
    repo.worktrees.remove(worktreeId)
    broadcastAll()
  })

  h(IPC.renameWorktree, (_e, worktreeId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    repo.worktrees.rename(worktreeId, trimmed)
    broadcast()
  })

  h(IPC.syncWorktreeEnv, (_e, worktreeId: string) => syncWorktreeEnv(worktreeId))

  h(IPC.clearWorktreeStatus, (_e, worktreeId: string) => resetWorktree(worktreeId))
}
