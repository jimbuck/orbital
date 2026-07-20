import type { BrowserWindow } from 'electron'
import { TerminalManager } from './services/terminals'
import { GitWatcher, git } from './services/git'
import { ControlChannel } from './services/control-channel'
import { AlertManager } from './services/alerts'
import { EnvSyncWatcher } from './services/env-sync'
import * as repo from './db/repositories'
import { deleteBriefing } from './services/agents/briefing'
import { getSettings } from './services/settings'
import { IPC, isPtyTabType, type AppState } from '@shared/types'

/**
 * The main-process service hub. Owns the long-lived service singletons and the
 * helpers that push state/terminal/alert events down to the renderer. Importing
 * this module never touches Electron until `init()` is called.
 */
class Runtime {
  private static readonly COALESCE_MS = 50
  /** How often the background fetcher runs `git fetch` per project. */
  private static readonly FETCH_INTERVAL_MS = 3 * 60_000

  window: BrowserWindow | null = null
  readonly terminals = new TerminalManager()
  readonly gitWatcher = new GitWatcher()
  readonly control = new ControlChannel()
  alerts!: AlertManager
  /** One env-sync watcher per project, watching its root checkout. */
  readonly envWatchers = new Map<string, EnvSyncWatcher>()
  /** Live dev servers per worktree (from `orbital server add`) — runtime-only state. */
  private readonly devServers = new Map<string, Set<string>>()
  /** Worktrees still doing background setup (node_modules copy) — runtime-only. */
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
      () => getSettings()
    )

    this.terminals.on('data', (e) => this.send(IPC.evtTerminalData, e))
    this.terminals.on('exit', (e) => {
      this.send(IPC.evtTerminalExit, e)
      const tab = repo.tabs.get(e.tabId)
      if (!tab) return
      // An agent (Claude) session that exits on its own closes its tab. Note that
      // TerminalManager.kill() does NOT emit 'exit', so this fires only on a real
      // process exit (e.g. `/exit` or a crash), never on worktree/app teardown.
      if (tab.type === 'agent') {
        deleteBriefing(tab.worktreeId, tab.id)
        repo.tabs.remove(tab.id)
        repo.worktrees.recomputeStatus(tab.worktreeId)
        this.broadcastState()
        this.broadcastAlert()
        return
      }
      // A dead terminal PTY keeps its tab but must stop contributing a stale status
      // to the Worktree aggregate (else the rail/taskbar stay stuck on working/needs-you).
      if (isPtyTabType(tab.type)) {
        repo.tabs.updateStatus(e.tabId, 'idle')
        repo.worktrees.recomputeStatus(tab.worktreeId)
        this.broadcastState()
        this.broadcastAlert()
      }
    })

    // External git activity (commits, checkouts) -> resync branch names, refresh the renderer.
    this.gitWatcher.on('change', (repoPath: string) => {
      void this.refreshBranch(repoPath).finally(() => this.broadcastState())
    })

    // Background `git fetch` so ahead/behind stays current without a manual Fetch.
    // Reads projects live each tick, so this is safe before projects are resumed.
    this.configureFetch()
  }

  setWindow(win: BrowserWindow | null): void {
    this.window = win
    this.refreshWindowTitle()
  }

  /**
   * The OS window title (taskbar, Alt-Tab) carries the workspace name so
   * side-by-side instances are tellable apart. The implicit "Default" workspace
   * stays plain "Orbital" — same convention as the title-bar breadcrumb.
   */
  refreshWindowTitle(): void {
    if (!this.window || this.window.isDestroyed()) return
    const name = repo.workspaces.active().name
    this.window.setTitle(name !== 'Default' ? `${name} - Orbital` : 'Orbital')
  }

  send(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload)
    }
  }

  /**
   * Persisted DB state plus the split-store settings, this instance's workspace
   * identity, and the runtime-only dev-server registry and setting-up flags.
   */
  appState(): AppState {
    const devServers: Record<string, string[]> = {}
    for (const [worktreeId, urls] of this.devServers) {
      if (urls.size > 0) devServers[worktreeId] = [...urls]
    }
    return {
      ...repo.getAppState(),
      settings: getSettings(),
      workspace: repo.workspaces.active(),
      devServers,
      settingUpWorktrees: [...this.settingUp]
    }
  }

  /** Flag a worktree as setting up (background prep) so the rail shows a spinner. */
  markSettingUp(worktreeId: string): void {
    if (this.settingUp.has(worktreeId)) return
    this.settingUp.add(worktreeId)
    this.broadcastState()
  }

  /** Clear a worktree's setting-up flag once its background prep finishes. */
  clearSettingUp(worktreeId: string): void {
    if (this.settingUp.delete(worktreeId)) this.broadcastState()
  }

  /** Register a live dev server for a worktree; returns the worktree's server list. */
  addDevServer(worktreeId: string, url: string): string[] {
    let set = this.devServers.get(worktreeId)
    if (!set) {
      set = new Set()
      this.devServers.set(worktreeId, set)
    }
    set.add(url)
    this.broadcastState()
    return [...set]
  }

  /** Deregister a dev server (by exact URL, or by port when `url` is port-only). */
  removeDevServer(worktreeId: string, url: string): string[] {
    const set = this.devServers.get(worktreeId)
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
    if (set.size === 0) this.devServers.delete(worktreeId)
    this.broadcastState()
    return [...(this.devServers.get(worktreeId) ?? [])]
  }

  devServersFor(worktreeId: string): string[] {
    return [...(this.devServers.get(worktreeId) ?? [])]
  }

  clearDevServers(worktreeId: string): void {
    if (this.devServers.delete(worktreeId)) this.broadcastState()
  }

  /**
   * Re-read HEAD for a checkout and persist it onto its worktrees. `worktree.branch`
   * is captured at creation and otherwise never updated, so without this the rail
   * shows a stale name after any external checkout — especially for root worktrees,
   * whose checkout is the shared main repo where the user moves HEAD freely.
   */
  async refreshBranch(path: string): Promise<void> {
    const branch = await git.currentBranch(path).catch(() => null)
    if (branch) repo.worktrees.updateBranchByPath(path, branch)
  }

  /** Push the full hydrated app state to the renderer (coalesced). */
  broadcastState(): void {
    this.coalesce('state', () => this.send(IPC.evtStateChanged, this.appState()))
  }

  /** Recompute needs-attention, update the taskbar badge, notify the renderer (coalesced). */
  broadcastAlert(): void {
    if (!this.alerts) return
    this.coalesce('alert', () => this.send(IPC.evtAlert, this.alerts.update(repo.worktrees.listStatuses())))
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

  /** Ensure an env-sync watcher exists & is running for a project (patterns are a workspace setting). */
  ensureEnvWatcher(projectId: string): void {
    const project = repo.projects.get(projectId)
    if (!project) return
    const patterns = getSettings().envSyncPatterns
    let w = this.envWatchers.get(projectId)
    if (!w) {
      w = new EnvSyncWatcher(project.repoPath, patterns)
      this.envWatchers.set(projectId, w)
      w.start()
    } else {
      w.updatePatterns(patterns)
    }
    // (Re)register every linked Worktree of this project.
    for (const wt of repo.worktrees.list()) {
      if (wt.projectId === projectId && wt.kind === 'linked') w.register(wt.path)
    }
  }

  removeEnvWatcher(projectId: string): void {
    const w = this.envWatchers.get(projectId)
    if (w) {
      w.stop()
      this.envWatchers.delete(projectId)
    }
  }

  /**
   * Start/stop the background `git fetch` scheduler to match the `periodicFetch`
   * setting. Idempotent — safe to call at startup and again on every settings save.
   * The tick reads the project list live, so this works even before resume.
   */
  configureFetch(): void {
    const enabled = getSettings().periodicFetch
    if (enabled && !this.fetchTimer) {
      this.fetchTimer = setInterval(() => void this.fetchAll(), Runtime.FETCH_INTERVAL_MS)
    } else if (!enabled && this.fetchTimer) {
      clearInterval(this.fetchTimer)
      this.fetchTimer = null
    }
  }

  /**
   * One tick: `git fetch` each project's shared repo. Worktrees share the repo's
   * refs, so one fetch per repoPath updates ahead/behind for all its worktrees. Each
   * fetch is best-effort (an offline remote must not abort the rest), and the whole
   * run is guarded so a slow tick never overlaps the next.
   */
  private async fetchAll(): Promise<void> {
    if (this.fetching) return
    this.fetching = true
    try {
      let changed = false
      for (const project of repo.projects.list()) {
        try {
          await git.fetch(project.repoPath)
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
