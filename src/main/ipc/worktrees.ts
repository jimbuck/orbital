import { IPC, type CreateWorktreeOptions, type RemoveWorktreeOptions } from '@shared/types'
import { repo } from '../runtime'
import { createWorktree, removeWorktree, syncWorktreeEnv } from '../worktree-lifecycle'
import { resetWorktree } from '../status'
import { handle, broadcast } from './handle'

/** Worktrees: create / remove / rename, env resync, and the force status clear. */
export function register(): void {
  const h = handle
  // ---- worktrees / panes / tabs ----
  h(IPC.createWorktree, (_e, projectId: string, opts: CreateWorktreeOptions) =>
    createWorktree({
      projectId,
      branch: opts.branch,
      existingBranch: opts.existingBranch,
      name: opts.name,
      baseRef: opts.baseRef,
      taskId: opts.taskId
    })
  )

  h(IPC.removeWorktree, (_e, worktreeId: string, opts: RemoveWorktreeOptions) => removeWorktree(worktreeId, opts))

  h(IPC.renameWorktree, (_e, worktreeId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    repo.worktrees.rename(worktreeId, trimmed)
    broadcast()
  })

  h(IPC.syncWorktreeEnv, (_e, worktreeId: string) => syncWorktreeEnv(worktreeId))

  h(IPC.clearWorktreeStatus, (_e, worktreeId: string) => resetWorktree(worktreeId))
}
