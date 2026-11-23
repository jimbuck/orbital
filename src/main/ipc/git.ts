import { IPC } from '@shared/contract'
import { runtime, tables } from '../runtime'
import { git } from '../services/git'
import { searchFiles } from '../services/file-index'
import { searchContent, cancelSearch } from '../services/search'
import { handle, broadcast, gitChanged } from './handle'
import { worktreeRepoPath } from './resolve'

/** Git and file operations on a Worktree's checkout; every path is resolved through the git service's containment gate. */
export function register(): void {
  const h = handle
  // ---- git ----
  h(IPC.gitStatus, (_e, worktreeId) => git.status(worktreeRepoPath(worktreeId)))
  h(IPC.gitStage, async (_e, worktreeId, path) => {
    await git.stage(worktreeRepoPath(worktreeId), path)
    gitChanged(worktreeId)
  })
  h(IPC.gitUnstage, async (_e, worktreeId, path) => {
    await git.unstage(worktreeRepoPath(worktreeId), path)
    gitChanged(worktreeId)
  })
  h(IPC.gitStageAll, async (_e, worktreeId) => {
    await git.stageAll(worktreeRepoPath(worktreeId))
    gitChanged(worktreeId)
  })
  h(IPC.gitUnstageAll, async (_e, worktreeId) => {
    await git.unstageAll(worktreeRepoPath(worktreeId))
    gitChanged(worktreeId)
  })
  h(IPC.gitDiscard, async (_e, worktreeId, path) => {
    await git.discard(worktreeRepoPath(worktreeId), path)
    gitChanged(worktreeId)
  })
  h(IPC.gitDiscardAll, async (_e, worktreeId) => {
    await git.discardAll(worktreeRepoPath(worktreeId))
    gitChanged(worktreeId)
  })
  h(IPC.gitCommit, async (_e, worktreeId, message, amend) => {
    await git.commit(worktreeRepoPath(worktreeId), message, amend)
    gitChanged(worktreeId)
  })
  h(IPC.gitLastCommitMessage, (_e, worktreeId) => git.lastCommitMessage(worktreeRepoPath(worktreeId)))
  h(IPC.gitPush, async (_e, worktreeId) => {
    await git.push(worktreeRepoPath(worktreeId))
    gitChanged(worktreeId)
  })
  h(IPC.gitPull, async (_e, worktreeId) => {
    await git.pull(worktreeRepoPath(worktreeId))
    gitChanged(worktreeId)
  })
  h(IPC.gitFetch, async (_e, worktreeId) => {
    await git.fetch(worktreeRepoPath(worktreeId))
    gitChanged(worktreeId)
  })
  h(IPC.gitCheckout, async (_e, worktreeId, branch, create) => {
    const w = tables.worktrees.get(worktreeId)
    if (!w) throw new Error(`worktree ${worktreeId} not found`)
    // Linked Worktrees are pinned to their branch; only the root checkout may move HEAD.
    if (w.kind !== 'root') throw new Error('branches can only be switched on the root Worktree')
    await git.checkout(w.path, branch, create)
    // Persist the new HEAD onto the Worktree so the rail/panel reflect it immediately.
    await runtime.refreshBranch(w.path)
    broadcast()
    gitChanged(worktreeId)
  })
  h(IPC.gitDiff, (_e, worktreeId, path, staged) =>
    git.diff(worktreeRepoPath(worktreeId), path, staged)
  )
  // History: `hash` is renderer-supplied and reaches git as a positional
  // argument, so the git service hex-checks it (see checkHash) the way paths go
  // through the containment gate.
  h(IPC.gitLog, (_e, worktreeId, skip, limit) =>
    git.log(worktreeRepoPath(worktreeId), skip, limit)
  )
  h(IPC.gitCommitDetail, (_e, worktreeId, hash) =>
    git.commitDetail(worktreeRepoPath(worktreeId), hash)
  )
  h(IPC.gitCommitDiff, (_e, worktreeId, hash, path, oldPath) =>
    git.commitDiff(worktreeRepoPath(worktreeId), hash, path, oldPath)
  )
  h(IPC.fileTree, (_e, worktreeId) => git.fileTree(worktreeRepoPath(worktreeId)))
  // Every handler from here down is given a checkout-relative path chosen by
  // the renderer, and every one of them resolves it through the git service's
  // containment gate rather than joining it onto the checkout root and hoping.
  // Which half of the gate each uses (lexical, or lexical plus a real-path
  // check of the ancestors) is argued in git.ts beside the functions.
  h(IPC.listDir, (_e, worktreeId, path) => git.listDir(worktreeRepoPath(worktreeId), path))
  h(IPC.readFile, (_e, worktreeId, path) => git.readFile(worktreeRepoPath(worktreeId), path))
  h(IPC.readFileBase64, (_e, worktreeId, path) => git.readFileBase64(worktreeRepoPath(worktreeId), path))
  h(IPC.writeFile, async (_e, worktreeId, path, content) => {
    await git.writeFile(worktreeRepoPath(worktreeId), path, content)
    gitChanged(worktreeId)
  })
  // The four mutating file operations behind the editor tree's context menu.
  // Like writeFile above, each is checked lexically AND against the real
  // filesystem, so a symlinked directory can't lead one out of the checkout;
  // an escaping path is rejected before anything touches disk. The read-only
  // resolvePath below stops at the lexical check — it hands back a string and
  // writes nothing.
  h(IPC.createFile, async (_e, worktreeId, parentDir, name) => {
    const path = await git.createFile(worktreeRepoPath(worktreeId), parentDir, name)
    gitChanged(worktreeId)
    return path
  })
  h(IPC.createDirectory, async (_e, worktreeId, parentDir, name) => {
    const path = await git.createDirectory(worktreeRepoPath(worktreeId), parentDir, name)
    gitChanged(worktreeId)
    return path
  })
  h(IPC.renamePath, async (_e, worktreeId, path, newName) => {
    const next = await git.renamePath(worktreeRepoPath(worktreeId), path, newName)
    gitChanged(worktreeId)
    return next
  })
  h(IPC.trashPath, async (_e, worktreeId, path) => {
    await git.trashPath(worktreeRepoPath(worktreeId), path)
    gitChanged(worktreeId)
  })
  h(IPC.resolvePath, (_e, worktreeId, path) =>
    git.resolveInRepo(worktreeRepoPath(worktreeId), path)
  )
  // Cross-Worktree file search for the command palette. No worktree id: it
  // spans every checkout in the workspace, and main picks them from its own
  // rows — the renderer names nothing but a query string.
  h(IPC.searchFiles, (_e, query, limit) => searchFiles(query, limit))
  // Content search. Like searchFiles it names no worktree of its own — the
  // query's scope decides which checkouts main points git at.
  h(IPC.searchContent, (_e, query, searchId) => searchContent(query, searchId))
  h(IPC.cancelSearch, (_e, searchId) => cancelSearch(searchId))
}
