import { dialog } from 'electron'
import { IPC } from '@shared/contract'
import { runtime, tables } from '../runtime'
import { removeProject, settleProjectSessions } from '../worktree-lifecycle'
import { handle, broadcast } from './handle'

/**
 * After a change to a project's shape: open or close folder sessions to match
 * (tearing down the terminals of any that close), then push the state.
 */
function settled(): void {
  settleProjectSessions()
  broadcast()
}

/**
 * Projects (a root folder and the repos grouped under it) and the rail
 * folders that arrange them. The grouping rules (promote, demote, deleting a
 * project left empty) live in `tables.projects`; removing a project goes
 * through the lifecycle layer so its repos' terminals and watchers stop.
 */
export function register(): void {
  const h = handle

  // ---- projects ----
  h(IPC.addRepoToProject, (_e, projectId, repoId, beforeRepoId) => {
    tables.projects.addRepo(projectId, repoId, beforeRepoId ?? null)
    settled()
  })

  h(IPC.detachRepo, (_e, repoId, folderId, beforeId) => {
    const project = tables.projects.detachRepo(repoId, folderId ?? null, beforeId ?? null)
    settled()
    return project ?? null
  })

  h(IPC.setProjectHome, (_e, projectId, repoId) => {
    tables.projects.setHome(projectId, repoId ?? null)
    settled()
  })

  h(IPC.setProjectRoot, async (_e, projectId) => {
    const project = tables.projects.get(projectId)
    if (!project) return null
    const win = runtime.window ?? undefined
    const opts = {
      properties: ['openDirectory' as const],
      title: `Choose the root folder for ${project.name}`,
      defaultPath: project.rootPath
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    tables.projects.setRoot(projectId, root)
    settled()
    return root
  })

  h(IPC.setProjectManagedBlock, (_e, projectId, on) => {
    tables.projects.setManagedBlock(projectId, !!on)
    broadcast()
  })

  h(IPC.renameProject, (_e, projectId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    tables.projects.rename(projectId, trimmed)
    settled()
  })

  h(IPC.ungroupProject, (_e, projectId) => {
    tables.projects.ungroup(projectId)
    settled()
  })

  // Announces itself (and tears down each repo's runtime first).
  h(IPC.removeProject, (_e, projectId) => removeProject(projectId))

  h(IPC.createProject, async () => {
    const win = runtime.window ?? undefined
    const opts = { properties: ['openDirectory' as const], title: 'Choose the root folder for a new project' }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root
    const project = tables.projects.create({ name, rootPath: root })
    // Placed explicitly, at the end, where a new row is expected.
    tables.railFolders.placeProject(project.id, null, null)
    settled()
    return tables.projects.get(project.id) ?? project
  })

  // ---- rail folders (the rail's arrangement; see tables.railFolders) ----
  h(IPC.createRailFolder, (_e, name, projectId) => {
    const folder = tables.railFolders.create(String(name ?? '').trim() || 'New Folder', projectId || undefined)
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

  h(IPC.placeProject, (_e, projectId, folderId, beforeId) => {
    tables.railFolders.placeProject(projectId, folderId ?? null, beforeId ?? null)
    broadcast()
  })

  h(IPC.placeRailFolder, (_e, folderId, beforeId) => {
    tables.railFolders.placeFolder(folderId, beforeId ?? null)
    broadcast()
  })
}
