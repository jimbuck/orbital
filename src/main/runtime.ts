import type { BrowserWindow } from 'electron'
import { TerminalManager } from './services/terminals'
import { GitWatcher } from './services/git'
import { ControlChannel } from './services/control-channel'
import { AlertManager } from './services/alerts'
import { EnvSyncWatcher } from './services/env-sync'
import * as repo from './db/repositories'
import { deleteBriefing } from './services/agents/briefing'
import { IPC, isPtyTabType } from '@shared/types'

/**
 * The main-process service hub. Owns the long-lived service singletons and the
 * helpers that push state/terminal/alert events down to the renderer. Importing
 * this module never touches Electron until `init()` is called.
 */
class Runtime {
  private static readonly COALESCE_MS = 50

  window: BrowserWindow | null = null
  readonly terminals = new TerminalManager()
  readonly gitWatcher = new GitWatcher()
  readonly control = new ControlChannel()
  alerts!: AlertManager
  /** One env-sync watcher per workspace, watching its root checkout. */
  readonly envWatchers = new Map<string, EnvSyncWatcher>()
  private readonly pendingBroadcasts = new Map<string, NodeJS.Timeout>()
  private readonly lastBroadcastAt = new Map<string, number>()

  init(): void {
    this.alerts = new AlertManager(
      () => this.window,
      () => repo.settings.get()
    )

    this.terminals.on('data', (e) => this.send(IPC.evtTerminalData, e))
    this.terminals.on('exit', (e) => {
      this.send(IPC.evtTerminalExit, e)
      const tab = repo.tabs.get(e.tabId)
      if (!tab) return
      // An agent (Claude) session that exits on its own closes its tab. Note that
      // TerminalManager.kill() does NOT emit 'exit', so this fires only on a real
      // process exit (e.g. `/exit` or a crash), never on flight/app teardown.
      if (tab.type === 'agent') {
        deleteBriefing(tab.flightId, tab.id)
        repo.tabs.remove(tab.id)
        repo.flights.recomputeStatus(tab.flightId)
        this.broadcastState()
        this.broadcastAlert()
        return
      }
      // A dead terminal PTY keeps its tab but must stop contributing a stale status
      // to the Flight aggregate (else the rail/taskbar stay stuck on working/needs-you).
      if (isPtyTabType(tab.type)) {
        repo.tabs.updateStatus(e.tabId, 'idle')
        repo.flights.recomputeStatus(tab.flightId)
        this.broadcastState()
        this.broadcastAlert()
      }
    })

    // External git activity (commits, checkouts) -> refresh the renderer.
    this.gitWatcher.on('change', () => this.broadcastState())
  }

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  send(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload)
    }
  }

  /** Push the full hydrated app state to the renderer (coalesced). */
  broadcastState(): void {
    this.coalesce('state', () => this.send(IPC.evtStateChanged, repo.getAppState()))
  }

  /** Recompute needs-attention, update the taskbar badge, notify the renderer (coalesced). */
  broadcastAlert(): void {
    if (!this.alerts) return
    this.coalesce('alert', () => this.send(IPC.evtAlert, this.alerts.update(repo.flights.listStatuses())))
  }

  /**
   * Leading+trailing throttle. An isolated broadcast fires immediately so UI
   * actions stay snappy; bursts (Claude hooks fire per tool call, each of which
   * would re-hydrate and push the full app state) collapse into one trailing push.
   */
  private coalesce(key: 'state' | 'alert', fire: () => void): void {
    if (this.pendingBroadcasts.has(key)) return
    const elapsed = Date.now() - (this.lastBroadcastAt.get(key) ?? 0)
    if (elapsed >= Runtime.COALESCE_MS) {
      this.lastBroadcastAt.set(key, Date.now())
      fire()
      return
    }
    this.pendingBroadcasts.set(
      key,
      setTimeout(() => {
        this.pendingBroadcasts.delete(key)
        this.lastBroadcastAt.set(key, Date.now())
        fire()
      }, Runtime.COALESCE_MS - elapsed)
    )
  }

  /** Ensure an env-sync watcher exists & is running for a workspace. */
  ensureEnvWatcher(workspaceId: string): void {
    const ws = repo.workspaces.get(workspaceId)
    if (!ws) return
    let w = this.envWatchers.get(workspaceId)
    if (!w) {
      w = new EnvSyncWatcher(ws.repoPath, ws.envSyncPatterns)
      this.envWatchers.set(workspaceId, w)
      w.start()
    } else {
      w.updatePatterns(ws.envSyncPatterns)
    }
    // (Re)register every worktree Flight of this workspace.
    for (const f of repo.flights.list()) {
      if (f.workspaceId === workspaceId && f.kind === 'worktree') w.register(f.worktreePath)
    }
  }

  removeEnvWatcher(workspaceId: string): void {
    const w = this.envWatchers.get(workspaceId)
    if (w) {
      w.stop()
      this.envWatchers.delete(workspaceId)
    }
  }

  shutdown(): void {
    for (const t of this.pendingBroadcasts.values()) clearTimeout(t)
    this.pendingBroadcasts.clear()
    this.terminals.killAll()
    this.gitWatcher.stop()
    this.control.stop()
    for (const w of this.envWatchers.values()) w.stop()
    this.envWatchers.clear()
  }
}

export const runtime = new Runtime()
export { repo }
