import { join } from 'node:path'
import { delimiter as PATH_DELIM } from 'node:path'
import { existsSync } from 'node:fs'
import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import {
  IPC,
  ENV,
  controlPipePath,
  normalizeStatus,
  type CreateFlightOptions,
  type RemoveFlightOptions,
  type TabType,
  type TabConfig,
  type TerminalStatus,
  type SplitDirection,
  type TaskPatch,
  type Flight,
  type Tab,
  type ControlRequest,
  type ControlResponse
} from '@shared/types'
import { runtime, repo } from './runtime'
import { git } from './services/git'
import { createWorktreeFlight, removeWorktree, slugify } from './services/worktree'

/* ---- helpers ----------------------------------------------------------- */

/** Directory holding the bundled `orbital` CLI + shims, prepended to PTY PATH. */
function cliDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'cli') : join(app.getAppPath(), 'resources', 'cli')
}

function terminalEnv(flight: Flight, tabId: string): Record<string, string> {
  const path = `${cliDir()}${PATH_DELIM}${process.env.PATH ?? ''}`
  return {
    [ENV.terminalId]: tabId,
    [ENV.flightId]: flight.id,
    [ENV.workspaceId]: flight.workspaceId,
    [ENV.socket]: controlPipePath(),
    PATH: path,
    Path: path
  }
}

function spawnTerminal(flight: Flight, tab: Tab): void {
  const shellPref = repo.settings.get().defaultShell || undefined
  runtime.terminals.spawn({
    tabId: tab.id,
    cwd: flight.worktreePath,
    shell: shellPref,
    env: terminalEnv(flight, tab.id)
  })
}

/** Create a tab in a Flight (resolving the target pane) and start its PTY if a terminal. */
function createTabInFlight(flightId: string, paneId: string | null, type: TabType, config?: TabConfig): Tab {
  const flight = repo.flights.get(flightId)
  if (!flight) throw new Error(`flight ${flightId} not found`)
  const targetPane = paneId ?? repo.panes.firstPaneId(flightId)
  if (!targetPane) throw new Error(`flight ${flightId} has no pane`)
  const tab = repo.tabs.create({ flightId, paneId: targetPane, type, config })
  if (type === 'terminal') spawnTerminal(flight, tab)
  return tab
}

/** Give a freshly created Flight a ready terminal in its first pane. */
function openInitialTerminal(flight: Flight): void {
  const paneId = repo.panes.firstPaneId(flight.id)
  if (!paneId) return
  const tab = repo.tabs.create({ flightId: flight.id, paneId, type: 'terminal' })
  spawnTerminal(flight, tab)
}

function killFlightTerminals(flightId: string): void {
  const flight = repo.flights.get(flightId)
  if (!flight) return
  for (const pane of flight.panes) {
    for (const tab of pane.tabs) {
      if (tab.type === 'terminal') runtime.terminals.kill(tab.id)
    }
  }
}

/** Register a workspace: create its root Flight and start its watchers. */
async function registerWorkspace(repoPath: string): Promise<Flight | null> {
  const existing = repo.workspaces.getByPath(repoPath)
  if (existing) {
    runtime.gitWatcher.watch(repoPath)
    runtime.ensureEnvWatcher(existing.id)
    return repo.flights.list().find((f) => f.workspaceId === existing.id && f.kind === 'root') ?? null
  }
  const name = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath
  const ws = repo.workspaces.create({ name, repoPath })
  const branch = await git.currentBranch(repoPath).catch(() => 'main')
  const root = repo.flights.create({
    workspaceId: ws.id,
    kind: 'root',
    name: 'main',
    worktreePath: repoPath,
    branch
  })
  runtime.gitWatcher.watch(repoPath)
  runtime.ensureEnvWatcher(ws.id)
  openInitialTerminal(root)
  return root
}

/* ---- registration ------------------------------------------------------ */

export function registerIpc(): void {
  const h = ipcMain.handle.bind(ipcMain)
  const broadcast = (): void => runtime.broadcastState()
  const broadcastAll = (): void => {
    runtime.broadcastState()
    runtime.broadcastAlert()
  }

  // ---- state / settings ----
  h(IPC.getState, () => repo.getAppState())
  h(IPC.getSettings, () => repo.settings.get())
  h(IPC.setSettings, (_e, settings) => {
    const s = repo.settings.set(settings)
    broadcast()
    return s
  })

  // ---- workspaces ----
  h(IPC.addWorkspace, async () => {
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
        detail: `${dir} is not inside a git repository. Orbital workspaces must be git repos.`
      })
      return null
    }
    await registerWorkspace(dir)
    const ws = repo.workspaces.getByPath(dir)!
    broadcastAll()
    return ws
  })

  h(IPC.removeWorkspace, (_e, workspaceId: string) => {
    const ws = repo.workspaces.get(workspaceId)
    if (!ws) return
    for (const f of repo.flights.list()) {
      if (f.workspaceId === workspaceId) killFlightTerminals(f.id)
    }
    runtime.gitWatcher.unwatch(ws.repoPath)
    runtime.removeEnvWatcher(workspaceId)
    repo.workspaces.remove(workspaceId)
    broadcastAll()
  })

  h(IPC.updateEnvPatterns, (_e, workspaceId: string, patterns: string[]) => {
    repo.workspaces.updateEnvPatterns(workspaceId, patterns)
    runtime.ensureEnvWatcher(workspaceId)
    broadcast()
  })

  // ---- flights / panes / tabs ----
  h(IPC.createFlight, async (_e, workspaceId: string, opts: CreateFlightOptions) => {
    const ws = repo.workspaces.get(workspaceId)
    if (!ws) throw new Error(`workspace ${workspaceId} not found`)
    const branch = (opts.branch || opts.name || `flight-${Date.now()}`).trim()
    const flight = await createWorktreeFlight({
      workspace: ws,
      branch,
      name: opts.name,
      baseRef: opts.baseRef,
      taskId: opts.taskId
    })
    runtime.ensureEnvWatcher(workspaceId)
    openInitialTerminal(flight)
    broadcastAll()
    return repo.flights.get(flight.id)!
  })

  h(IPC.removeFlight, async (_e, flightId: string, opts: RemoveFlightOptions) => {
    const flight = repo.flights.get(flightId)
    if (!flight) return
    if (flight.kind === 'root') throw new Error('the root Flight cannot be removed')
    if (opts.removeWorktree) {
      const ws = repo.workspaces.get(flight.workspaceId)
      if (ws) {
        // git refuses a dirty/unpushed worktree without --force; let that error
        // propagate so the Flight is NOT removed and the unpushed work is not
        // silently orphaned (PRD §5 unpushed-work guard).
        await removeWorktree(ws.repoPath, flight.worktreePath, opts.force)
        runtime.envWatchers.get(ws.id)?.unregister(flight.worktreePath)
      }
    }
    killFlightTerminals(flightId)
    repo.flights.remove(flightId)
    broadcastAll()
  })

  h(IPC.createTab, (_e, flightId: string, paneId: string | null, type: TabType, config?: TabConfig) => {
    const tab = createTabInFlight(flightId, paneId, type, config)
    broadcast()
    return tab
  })

  h(IPC.closeTab, (_e, tabId: string) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    if (tab.type === 'terminal') runtime.terminals.kill(tabId)
    repo.tabs.remove(tabId)
    repo.flights.recomputeStatus(tab.flightId)
    broadcastAll()
  })

  h(IPC.setActiveTab, (_e, paneId: string, tabId: string) => {
    repo.tabs.setActive(paneId, tabId)
    broadcast()
  })

  h(IPC.moveTab, (_e, tabId: string, targetPaneId: string) => {
    repo.tabs.move(tabId, targetPaneId)
    broadcast()
  })

  h(IPC.splitPane, (_e, flightId: string, _sourcePaneId: string, direction: SplitDirection) => {
    repo.flights.updateSplitDirection(flightId, direction)
    const pane = repo.panes.create(flightId)
    broadcast()
    return pane
  })

  h(IPC.setPaneFlex, (_e, paneId: string, flex: number) => {
    repo.panes.updateFlex(paneId, flex)
    broadcast()
  })

  h(IPC.setTerminalStatus, (_e, tabId: string, status: TerminalStatus) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    repo.tabs.updateStatus(tabId, status)
    repo.flights.recomputeStatus(tab.flightId)
    broadcastAll()
  })

  // ---- terminals ----
  ipcMain.on(IPC.terminalInput, (_e, tabId: string, data: string) => runtime.terminals.write(tabId, data))
  ipcMain.on(IPC.terminalResize, (_e, tabId: string, cols: number, rows: number) =>
    runtime.terminals.resize(tabId, cols, rows)
  )
  h(IPC.terminalBuffer, (_e, tabId: string) => runtime.terminals.buffer(tabId))

  // ---- git ----
  const flightRepoPath = (flightId: string): string => {
    const f = repo.flights.get(flightId)
    if (!f) throw new Error(`flight ${flightId} not found`)
    return f.worktreePath
  }
  h(IPC.gitStatus, (_e, flightId: string) => git.status(flightRepoPath(flightId)))
  h(IPC.gitStage, async (_e, flightId: string, path: string) => {
    await git.stage(flightRepoPath(flightId), path)
    broadcast()
  })
  h(IPC.gitUnstage, async (_e, flightId: string, path: string) => {
    await git.unstage(flightRepoPath(flightId), path)
    broadcast()
  })
  h(IPC.gitCommit, async (_e, flightId: string, message: string) => {
    await git.commit(flightRepoPath(flightId), message)
    broadcast()
  })
  h(IPC.gitPush, (_e, flightId: string) => git.push(flightRepoPath(flightId)))
  h(IPC.gitPull, async (_e, flightId: string) => {
    await git.pull(flightRepoPath(flightId))
    broadcast()
  })
  h(IPC.gitFetch, (_e, flightId: string) => git.fetch(flightRepoPath(flightId)))
  h(IPC.gitDiff, (_e, flightId: string, path: string, staged: boolean) =>
    git.diff(flightRepoPath(flightId), path, staged)
  )
  h(IPC.fileTree, (_e, flightId: string) => git.fileTree(flightRepoPath(flightId)))
  h(IPC.readFile, (_e, flightId: string, path: string) => git.readFile(flightRepoPath(flightId), path))
  h(IPC.writeFile, async (_e, flightId: string, path: string, content: string) => {
    await git.writeFile(flightRepoPath(flightId), path, content)
    broadcast()
  })

  // ---- tasks ----
  h(IPC.createTask, (_e, workspaceId: string, title: string, description?: string) => {
    const t = repo.tasks.create({ workspaceId, title, description })
    broadcast()
    return t
  })
  h(IPC.updateTask, (_e, taskId: string, patch: TaskPatch) => {
    const t = repo.tasks.update(taskId, patch)
    broadcast()
    return t
  })
  h(IPC.deleteTask, (_e, taskId: string) => {
    repo.tasks.remove(taskId)
    broadcast()
  })
  h(IPC.startFlightFromTask, async (_e, taskId: string) => {
    const task = repo.tasks.get(taskId)
    if (!task) throw new Error(`task ${taskId} not found`)
    const ws = repo.workspaces.get(task.workspaceId)
    if (!ws) throw new Error(`workspace ${task.workspaceId} not found`)
    const flight = await createWorktreeFlight({
      workspace: ws,
      branch: slugify(task.title),
      name: task.title,
      taskId: task.id
    })
    repo.tasks.setFlight(task.id, flight.id)
    runtime.ensureEnvWatcher(ws.id)
    openInitialTerminal(flight)
    broadcastAll()
    return repo.flights.get(flight.id)!
  })

  // ---- browser / window ----
  h(IPC.openExternal, (_e, url: string) => shell.openExternal(url))
  ipcMain.on(IPC.windowMinimize, () => runtime.window?.minimize())
  ipcMain.on(IPC.windowMaximize, () => {
    const w = runtime.window
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on(IPC.windowClose, () => runtime.window?.close())
}

/* ---- CLI control channel dispatcher ------------------------------------ */

export async function handleControl(req: ControlRequest): Promise<ControlResponse> {
  try {
    switch (req.cmd) {
      case 'status': {
        const status = normalizeStatus(String(req.args.status ?? ''))
        if (!status) return { ok: false, error: `unknown status '${req.args.status}'` }
        if (!req.terminalId) return { ok: false, error: 'no ORBITAL_TERMINAL_ID in environment' }
        const tab = repo.tabs.get(req.terminalId)
        if (!tab) return { ok: false, error: 'terminal not found' }
        repo.tabs.updateStatus(req.terminalId, status)
        repo.flights.recomputeStatus(tab.flightId)
        runtime.broadcastState()
        runtime.broadcastAlert()
        return { ok: true, data: { status } }
      }
      case 'flights': {
        const wsId = req.workspaceId
        const list = repo.flights
          .list()
          .filter((f) => !wsId || f.workspaceId === wsId)
          .map((f) => ({ id: f.id, name: f.name, branch: f.branch, status: f.status, kind: f.kind }))
        return { ok: true, data: list }
      }
      case 'flight-new': {
        if (!req.workspaceId) return { ok: false, error: 'no ORBITAL_WORKSPACE_ID in environment' }
        const ws = repo.workspaces.get(req.workspaceId)
        if (!ws) return { ok: false, error: 'workspace not found' }
        const branch = String(req.args.worktree ?? req.args.name ?? `flight-${Date.now()}`)
        const flight = await createWorktreeFlight({
          workspace: ws,
          branch,
          name: req.args.name ? String(req.args.name) : undefined
        })
        runtime.ensureEnvWatcher(ws.id)
        openInitialTerminal(flight)
        runtime.broadcastState()
        return { ok: true, data: { id: flight.id, name: flight.name, branch: flight.branch } }
      }
      case 'tab-new': {
        if (!req.flightId) return { ok: false, error: 'no ORBITAL_FLIGHT_ID in environment' }
        const type = String(req.args.type ?? 'terminal') as TabType
        if (!['terminal', 'browser', 'editor'].includes(type)) {
          return { ok: false, error: `unknown tab type '${type}'` }
        }
        const arg = req.args.arg ? String(req.args.arg) : undefined
        const config: TabConfig = type === 'browser' ? { url: arg } : type === 'editor' ? { filePath: arg } : {}
        const tab = createTabInFlight(req.flightId, null, type, config)
        runtime.broadcastState()
        return { ok: true, data: { id: tab.id, type: tab.type } }
      }
      case 'task-add': {
        if (!req.workspaceId) return { ok: false, error: 'no ORBITAL_WORKSPACE_ID in environment' }
        const title = String(req.args.title ?? '').trim()
        if (!title) return { ok: false, error: 'task title required' }
        const task = repo.tasks.create({
          workspaceId: req.workspaceId,
          title,
          description: req.args.description ? String(req.args.description) : undefined
        })
        runtime.broadcastState()
        return { ok: true, data: { id: task.id, title: task.title } }
      }
      default:
        return { ok: false, error: `unknown command '${(req as ControlRequest).cmd}'` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** On startup, resume watchers for already-registered workspaces. */
export function resumeWorkspaces(): void {
  for (const ws of repo.workspaces.list()) {
    runtime.gitWatcher.watch(ws.repoPath)
    runtime.ensureEnvWatcher(ws.id)
  }
}

/**
 * Terminals start fresh across restarts (PRD §5): scrollback does not persist,
 * so respawn a clean PTY for every terminal tab and reset its status to idle.
 */
export function resumeTerminals(): void {
  for (const flight of repo.flights.list()) {
    // A worktree may have been removed externally while the app was closed;
    // node-pty throws synchronously on a missing cwd, so skip such Flights.
    if (!existsSync(flight.worktreePath)) continue
    for (const pane of flight.panes) {
      for (const tab of pane.tabs) {
        if (tab.type === 'terminal') {
          repo.tabs.updateStatus(tab.id, 'idle')
          try {
            spawnTerminal(flight, tab)
          } catch (err) {
            console.error(`failed to respawn terminal ${tab.id}:`, err)
          }
        }
      }
    }
    repo.flights.recomputeStatus(flight.id)
  }
}
