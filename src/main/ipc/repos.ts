import { dialog, BrowserWindow } from 'electron'
import { IPC } from '@shared/contract'
import { runtime, tables } from '../runtime'
import { git } from '../services/git'
import { github } from '../services/github'
import { addRepo, removeRepo } from '../worktree-lifecycle'
import { handle, broadcast } from './handle'

/** Repos: add / remove / rename, the rail folders they are filed in, their branches and their agent defaults. */
export function register(): void {
  const h = handle
  // ---- repos ----
  h(IPC.addRepo, async () => {
    const win = runtime.window ?? undefined
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Open a git repository' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    if (!(await git.isRepo(dir))) {
      await dialog.showMessageBox(win ?? new BrowserWindow({ show: false }), {
        type: 'warning',
        message: 'Not a git repository',
        detail: `${dir} is not inside a git repository. Orbital can only add git repos.`
      })
      return null
    }
    return addRepo(dir)
  })

  h(IPC.pickDirectory, async (_e, title) => {
    const win = runtime.window ?? undefined
    const opts = { properties: ['openDirectory' as const], title: title || 'Choose a folder' }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- github (gh CLI) ----
  h(IPC.githubContext, (_e, account) => github.getContext(account))
  h(IPC.githubListRepos, (_e, owner, account) => github.listRepos(owner, account))
  h(IPC.githubCheckRepoName, (_e, owner, name, account) =>
    github.checkRepoName(owner, name, account)
  )
  h(IPC.githubCreateRepo, (_e, opts) => github.createRepo(opts))

  // Clone into <parentDir>/<repo>, then register it exactly as addRepo does
  // for a folder picked by hand.
  h(IPC.githubCloneRepo, async (_e, nameWithOwner, parentDir, account) => {
    const repoName = String(nameWithOwner).split('/').pop() ?? ''
    const dest = github.resolveCloneTarget(String(parentDir), repoName)
    await github.cloneRepo(String(nameWithOwner), dest, account)
    if (!(await git.isRepo(dest))) {
      throw new Error(`Cloned ${nameWithOwner}, but ${dest} is not a git repository.`)
    }
    return addRepo(dest)
  })

  h(IPC.removeRepo, (_e, repoId) => removeRepo(repoId))

  h(IPC.renameRepo, (_e, repoId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    tables.repos.rename(repoId, trimmed)
    broadcast()
  })

  // ---- folders (the rail's grouping; see tables.railFolders) ----
  h(IPC.createRailFolder, (_e, name, repoId) => {
    const folder = tables.railFolders.create(String(name ?? '').trim() || 'New Folder', repoId || undefined)
    broadcast()
    return folder
  })

  h(IPC.renameRailFolder, (_e, folderId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    tables.railFolders.rename(folderId, trimmed)
    broadcast()
  })

  h(IPC.removeRailFolder, (_e, folderId) => {
    tables.railFolders.remove(folderId)
    broadcast()
  })

  h(IPC.setRailFolderCollapsed, (_e, folderId, collapsed) => {
    tables.railFolders.setCollapsed(folderId, !!collapsed)
    broadcast()
  })

  h(IPC.placeRepo, (_e, repoId, folderId, beforeId) => {
    tables.railFolders.placeRepo(repoId, folderId ?? null, beforeId ?? null)
    broadcast()
  })

  h(IPC.placeRailFolder, (_e, folderId, beforeId) => {
    tables.railFolders.placeFolder(folderId, beforeId ?? null)
    broadcast()
  })

  h(IPC.listBranches, async (_e, repoId) => {
    const repo = tables.repos.get(repoId)
    if (!repo) return { branches: [], remotes: [], head: 'HEAD' }
    const [branches, allRemotes, head] = await Promise.all([
      git.listBranches(repo.repoPath).catch(() => [] as string[]),
      git.listRemoteBranches(repo.repoPath).catch(() => [] as string[]),
      git.currentBranch(repo.repoPath).catch(() => 'main')
    ])
    // Only surface remote branches that have no local counterpart — picking the
    // local one is always the better checkout target.
    const locals = new Set(branches)
    const remotes = allRemotes.filter((r) => !locals.has(r.replace(/^[^/]+\//, '')))
    return { branches, remotes, head }
  })

  h(IPC.setRepoAgent, (_e, repoId, patch) => {
    tables.repos.updateAgent(repoId, patch)
    broadcast()
  })
}
