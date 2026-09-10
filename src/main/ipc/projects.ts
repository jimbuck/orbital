import { dialog, BrowserWindow } from 'electron'
import { IPC, type ProjectAgentPatch } from '@shared/types'
import { runtime, repo } from '../runtime'
import { git } from '../services/git'
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
