import { IPC } from '@shared/contract'
import { tables } from '../runtime'
import { createWorktree, removeWorktree, syncWorktreeEnv } from '../worktree-lifecycle'
import { resetWorktree } from '../status'
import { handle, broadcast } from './handle'

/** Worktrees: create / remove / rename, env resync, and the force status clear. */
export function register(): void {
  const h = handle
  // ---- worktrees / panes / tabs ----
  h(IPC.createWorktree, (_e, repoId, opts) =>
    createWorktree({
      repoId,
      branch: opts.branch,
      existingBranch: opts.existingBranch,
      name: opts.name,
      baseRef: opts.baseRef,
      taskId: opts.taskId
    })
  )

  h(IPC.removeWorktree, (_e, worktreeId, opts) => removeWorktree(worktreeId, opts))

  h(IPC.renameWorktree, (_e, worktreeId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    tables.worktrees.rename(worktreeId, trimmed)
    broadcast()
  })

  h(IPC.syncWorktreeEnv, (_e, worktreeId) => syncWorktreeEnv(worktreeId))

  h(IPC.clearWorktreeStatus, (_e, worktreeId) => resetWorktree(worktreeId))
}
