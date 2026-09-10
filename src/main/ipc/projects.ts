import { dialog, BrowserWindow } from 'electron'
import { IPC, type ProjectAgentPatch } from '@shared/types'
import { runtime, repo } from '../runtime'
import { git } from '../services/git'
import { github } from '../services/github'
import type { GithubAccountRef, GithubCreateRepoOptions } from '@shared/github'
import { registerProject, reconcileProjectWorktrees, releaseWorktreeRuntime, removeWorktreesWatcher } from '../worktree-lifecycle'
import { handle, broadcast, broadcastAll } from './handle'

/** Projects: add / remove / rename, their branches and their agent defaults. */
export function register(): void {
  const h = handle
  // ---- projects ----
  h(IPC.addProject, async () => {
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
        detail: `${dir} is not inside a git repository. Orbital projects must be git repos.`
      })
      return null
    }
    await registerProject(dir)
    const project = repo.projects.getByPath(dir)!
    // Adopt any worktrees the repo already has — they show up immediately.
    await reconcileProjectWorktrees(project.id)
    broadcastAll()
    return project
  })

  h(IPC.pickDirectory, async (_e, title?: string) => {
    const win = runtime.window ?? undefined
    const opts = { properties: ['openDirectory' as const], title: title || 'Choose a folder' }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- github (gh CLI) ----
  h(IPC.githubContext, (_e, account?: GithubAccountRef) => github.getContext(account))
  h(IPC.githubListRepos, (_e, owner: string, account?: GithubAccountRef) => github.listRepos(owner, account))
  h(IPC.githubCheckRepoName, (_e, owner: string, name: string, account?: GithubAccountRef) =>
    github.checkRepoName(owner, name, account)
  )
  h(IPC.githubCreateRepo, (_e, opts: GithubCreateRepoOptions) => github.createRepo(opts))

  // Clone into <parentDir>/<repo>, then register it exactly as addProject does
  // for a folder picked by hand.
  h(IPC.githubCloneRepo, async (_e, nameWithOwner: string, parentDir: string, account?: GithubAccountRef) => {
    const repoName = String(nameWithOwner).split('/').pop() ?? ''
    const dest = github.resolveCloneTarget(String(parentDir), repoName)
    await github.cloneRepo(String(nameWithOwner), dest, account)
    if (!(await git.isRepo(dest))) {
      throw new Error(`Cloned ${nameWithOwner}, but ${dest} is not a git repository.`)
    }
    await registerProject(dest)
    const project = repo.projects.getByPath(dest)!
    await reconcileProjectWorktrees(project.id)
    broadcastAll()
    return project
  })

  h(IPC.removeProject, (_e, projectId: string) => {
    const project = repo.projects.get(projectId)
    if (!project) return
    for (const w of repo.worktrees.list()) {
      if (w.projectId === projectId) releaseWorktreeRuntime(w)
    }
    runtime.gitWatcher.unwatch(project.repoPath)
    removeWorktreesWatcher(projectId)
    repo.projects.remove(projectId)
    broadcastAll()
  })

  h(IPC.renameProject, (_e, projectId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    repo.projects.rename(projectId, trimmed)
    broadcast()
  })

  h(IPC.listBranches, async (_e, projectId: string) => {
    const project = repo.projects.get(projectId)
    if (!project) return { branches: [], remotes: [], head: 'HEAD' }
    const [branches, allRemotes, head] = await Promise.all([
      git.listBranches(project.repoPath).catch(() => [] as string[]),
      git.listRemoteBranches(project.repoPath).catch(() => [] as string[]),
      git.currentBranch(project.repoPath).catch(() => 'main')
    ])
    // Only surface remote branches that have no local counterpart — picking the
    // local one is always the better checkout target.
    const locals = new Set(branches)
    const remotes = allRemotes.filter((r) => !locals.has(r.replace(/^[^/]+\//, '')))
    return { branches, remotes, head }
  })

  h(IPC.setProjectAgent, (_e, projectId: string, patch: ProjectAgentPatch) => {
    repo.projects.updateAgent(projectId, patch)
    broadcast()
  })
}
