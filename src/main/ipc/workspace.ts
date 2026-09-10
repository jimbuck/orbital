import { spawn } from 'node:child_process'
import { app, dialog } from 'electron'
import { IPC, type SettingsPatch } from '@shared/types'
import { runtime, repo } from '../runtime'
import { logger } from '../services/logger'
import { patchTouches, setSettings } from '../services/settings'
import { exportWorkspaceToFile, importWorkspaceFromFile } from '../services/workspaces'
import { refreshJumpList } from '../services/jump-list'
import { handle, broadcast } from './handle'

/**
 * Launch a separate Orbital instance scoped to `workspaceId`. Each workspace
 * gets its own profile dir (and control pipe), so it runs side by side with
 * this instance; if that workspace is already open, the child hits its
 * single-instance lock, focuses the existing window, and quits — either way
 * the caller just fires and forgets.
 */
function launchWorkspace(workspaceId: string): void {
  // Packaged: the exe IS the app. Dev: process.execPath is electron.exe, which
  // needs the app dir as its first argument (same shape electron-vite uses).
  const args = app.isPackaged
    ? ['--workspace-id', workspaceId]
    : [app.getAppPath(), '--workspace-id', workspaceId]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
}

/** App state, settings, and the workspace picker. */
export function register(): void {
  const h = handle
  // ---- state / settings ----
  h(IPC.getState, () => runtime.appState())
  h(IPC.setSettings, (_e, patch: SettingsPatch) => {
    // Merges the patch's keys across the global store and the workspace YAML
    // behind the facade, leaving every key the renderer did not send untouched.
    const s = setSettings(patch)
    // Each side effect is gated on the key that actually drives it. Patches are
    // single-key and frequent — a theme click sends { theme }, an untouched Save
    // sends {} — so nothing here may run for a key the patch did not name.
    // (envSyncPatterns has no side effect: the patterns are read fresh at each
    // worktree creation and each explicit resync, and there is no watcher to
    // reconfigure.)
    //
    // Toggling periodicFetch starts/stops the background fetcher live.
    if (patchTouches(patch, 'periodicFetch')) runtime.configureFetch()
    // Toggling debug logging takes effect immediately (no restart needed). Gated
    // on the key, but the VALUE comes from the merged result rather than from the
    // patch: a patch that leaves debugLogging out must not be read as "turn it
    // off", and the stored value is the one another instance may have just set.
    if (patchTouches(patch, 'debugLogging')) logger.setEnabled(s.debugLogging)
    broadcast()
    return s
  })

  // ---- workspaces ----
  h(IPC.listWorkspaces, () => repo.workspaces.list())

  h(IPC.openWorkspace, (_e, workspaceId: string) => {
    const info = repo.workspaces.get(workspaceId)
    if (!info) throw new Error('workspace not found')
    // Opening the workspace this instance already runs just means "focus me".
    if (workspaceId === repo.requireWorkspaceId()) {
      const win = runtime.window
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
      return info
    }
    launchWorkspace(workspaceId)
    return info
  })

  h(IPC.createWorkspace, (_e, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return null
    const info = repo.workspaces.create(trimmed)
    launchWorkspace(info.id)
    return info
  })

  h(IPC.renameWorkspace, (_e, workspaceId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    repo.workspaces.rename(workspaceId, trimmed)
    // The title-bar breadcrumb and the OS window title show the current
    // workspace's name.
    if (workspaceId === repo.requireWorkspaceId()) {
      broadcast()
      runtime.refreshWindowTitle()
    }
    refreshJumpList()
  })

  h(IPC.removeWorkspace, (_e, workspaceId: string) => {
    // Deleting the workspace out from under this window would strand it; the
    // picker greys out the current workspace instead. (An instance of ANOTHER
    // workspace being open while it's deleted is the user's call — its window
    // keeps running on in-memory state until closed.)
    if (workspaceId === repo.requireWorkspaceId()) {
      throw new Error('switch to another workspace before deleting this one')
    }
    repo.workspaces.remove(workspaceId)
    refreshJumpList()
    return repo.workspaces.list()
  })

  h(IPC.exportWorkspace, async (_e, workspaceId: string) => {
    const ws = repo.workspaces.get(workspaceId)
    if (!ws) throw new Error('workspace not found')
    const win = runtime.window ?? undefined
    const opts = {
      title: 'Export workspace',
      defaultPath: `${ws.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.workspace.yaml`,
      filters: [{ name: 'Orbital workspace', extensions: ['yaml', 'yml'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return null
    exportWorkspaceToFile(workspaceId, result.filePath)
    return result.filePath
  })

  h(IPC.importWorkspace, async () => {
    const win = runtime.window ?? undefined
    const opts = {
      title: 'Import workspace',
      filters: [{ name: 'Orbital workspace', extensions: ['yaml', 'yml'] }],
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return importWorkspaceFromFile(result.filePaths[0]) // throws readable errors
  })
}
