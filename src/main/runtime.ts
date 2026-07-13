import type { BrowserWindow } from 'electron'
import { TerminalManager } from './services/terminals'
import { GitWatcher, git } from './services/git'
import { ControlChannel } from './services/control-channel'
import { AlertManager } from './services/alerts'
import { EnvSyncWatcher } from './services/env-sync'
import * as repo from './db/repositories'
import { deleteBriefing } from './services/agents/briefing'
import { IPC, isPtyTabType, type AppState } from '@shared/types'

/**
 * The main-process service hub. Owns the long-lived service singletons and the
 * helpers that push state/terminal/alert events down to the renderer. Importing
 * this module never touches Electron until `init()` is called.
 */
class Runtime {
  private static readonly COALESCE_MS = 50
  /** How often the background fetcher runs `git fetch` per workspace. */
  private static readonly FETCH_INTERVAL_MS = 3 * 60_000

  window: BrowserWindow | null = null
  readonly terminals = new TerminalManager()
  readonly gitWatcher = new GitWatcher()
  readonly control = new ControlChannel()
  alerts!: AlertManager
  /** One env-sync watcher per workspace, watching its root checkout. */
  readonly envWatchers = new Map<string, EnvSyncWatcher>()
  /** Live dev servers per flight (from `orbital server add`) — runtime-only state. */
  private readonly devServers = new Map<string, Set<string>>()
  /** Flights whose worktree is still doing background setup (node_modules copy) — runtime-only. */
  private readonly settingUp = new Set<string>()
  private readonly pendingBroadcasts = new Map<string, NodeJS.Timeout>()
  private readonly lastBroadcastAt = new Map<string, number>()
  /** Background `git fetch` scheduler — null when the setting is off. */
  private fetchTimer: NodeJS.Timeout | null = null
  /** Guards against overlapping ticks when a previous fetch run is still going. */
  private fetching = false

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

    // External git activity (commits, checkouts) -> resync branch names, refresh the renderer.
    this.gitWatcher.on('change', (repoPath: string) => {
      void this.refreshBranch(repoPath).finally(() => this.broadcastState())
    })

    // Background `git fetch` so ahead/behind stays current without a manual Fetch.
    // Reads workspaces live each tick, so this is safe before workspaces are resumed.
    this.configureFetch()
  }

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  send(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload)
    }
  }

  /** Persisted state plus the runtime-only dev-server registry and setting-up flags. */
  appState(): AppState {
    const devServers: Record<string, string[]> = {}
    for (const [flightId, urls] of this.devServers) {
      if (urls.size > 0) devServers[flightId] = [...urls]
    }
    return { ...repo.getAppState(), devServers, settingUpFlights: [...this.settingUp] }
  }

  /** Flag a flight as setting up (background worktree prep) so the rail shows a spinner. */
  markSettingUp(flightId: string): void {
    if (this.settingUp.has(flightId)) return
    this.settingUp.add(flightId)
    this.broadcastState()
  }

  /** Clear a flight's setting-up flag once its background prep finishes. */
  clearSettingUp(flightId: string): void {
    if (this.settingUp.delete(flightId)) this.broadcastState()
  }

  /** Register a live dev server for a flight; returns the flight's server list. */
  addDevServer(flightId: string, url: string): string[] {
    let set = this.devServers.get(flightId)
    if (!set) {
      set = new Set()
      this.devServers.set(flightId, set)
    }
    set.add(url)
    this.broadcastState()
    return [...set]
  }

  /** Deregister a dev server (by exact URL, or by port when `url` is port-only). */
  removeDevServer(flightId: string, url: string): string[] {
    const set = this.devServers.get(flightId)
    if (!set) return []
    const port = ((): string => {
      try {
        return new URL(url).port
      } catch {
        return ''
      }
    })()
    for (const existing of [...set]) {
      let samePort = false
      try {
        samePort = !!port && new URL(existing).port === port
      } catch {
        /* unparseable existing entry — exact match only */
      }
      if (existing === url || samePort) set.delete(existing)
    }
    if (set.size === 0) this.devServers.delete(flightId)
    this.broadcastState()
    return [...(this.devServers.get(flightId) ?? [])]
  }

  devServersFor(flightId: string): string[] {
    return [...(this.devServers.get(flightId) ?? [])]
  }

  clearDevServers(flightId: string): void {
    if (this.devServers.delete(flightId)) this.broadcastState()
  }

  /**
   * Re-read HEAD for a checkout and persist it onto its flights. `flights.branch`
   * is captured at creation and otherwise never updated, so without this the rail
   * shows a stale name after any external checkout — especially for root flights,
   * whose checkout is the shared main repo where the user moves HEAD freely.
   */
  async refreshBranch(worktreePath: string): Promise<void> {
    const branch = await git.currentBranch(worktreePath).catch(() => null)
    if (branch) repo.flights.updateBranchByWorktree(worktreePath, branch)
  }

  /** Push the full hydrated app state to the renderer (coalesced). */
  broadcastState(): void {
    this.coalesce('state', () => this.send(IPC.evtStateChanged, this.appState()))
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

  /** Ensure an env-sync watcher exists & is running for a workspace (patterns come from global settings). */
  ensureEnvWatcher(workspaceId: string): void {
    const ws = repo.workspaces.get(workspaceId)
    if (!ws) return
    const patterns = repo.settings.get().envSyncPatterns
    let w = this.envWatchers.get(workspaceId)
    if (!w) {
      w = new EnvSyncWatcher(ws.repoPath, patterns)
      this.envWatchers.set(workspaceId, w)
      w.start()
    } else {
      w.updatePatterns(patterns)
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

  /**
   * Start/stop the background `git fetch` scheduler to match the `periodicFetch`
   * setting. Idempotent — safe to call at startup and again on every settings save.
   * The tick reads the workspace list live, so this works even before resume.
   */
  configureFetch(): void {
    const enabled = repo.settings.get().periodicFetch
    if (enabled && !this.fetchTimer) {
      this.fetchTimer = setInterval(() => void this.fetchAll(), Runtime.FETCH_INTERVAL_MS)
    } else if (!enabled && this.fetchTimer) {
      clearInterval(this.fetchTimer)
      this.fetchTimer = null
    }
  }

  /**
   * One tick: `git fetch` each workspace's shared repo. Worktrees share the repo's
   * refs, so one fetch per repoPath updates ahead/behind for all its flights. Each
   * fetch is best-effort (an offline remote must not abort the rest), and the whole
   * run is guarded so a slow tick never overlaps the next.
   */
  private async fetchAll(): Promise<void> {
    if (this.fetching) return
    this.fetching = true
    try {
      let changed = false
      for (const ws of repo.workspaces.list()) {
        try {
          await git.fetch(ws.repoPath)
          changed = true
        } catch {
          /* offline / no remote — skip this repo, keep fetching the others */
        }
      }
      // Remote-tracking refs may have moved — nudge the renderer to re-read ahead/behind.
      if (changed) this.broadcastState()
    } finally {
      this.fetching = false
    }
  }

  shutdown(): void {
    for (const t of this.pendingBroadcasts.values()) clearTimeout(t)
    this.pendingBroadcasts.clear()
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer)
      this.fetchTimer = null
    }
    this.terminals.killAll()
    this.gitWatcher.stop()
    this.control.stop()
    for (const w of this.envWatchers.values()) w.stop()
    this.envWatchers.clear()
  }
}

export const runtime = new Runtime()
export { repo }
