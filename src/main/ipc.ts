import { delimiter as PATH_DELIM } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { ipcMain, dialog, shell, app, BrowserWindow, webContents, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  ENV,
  SUPPORTED_AGENTS,
  findAgentConfig,
  resolveAgentRef,
  normalizeStatus,
  normalizeTaskStatus,
  isPtyTabType,
  type CreateWorktreeOptions,
  type RemoveWorktreeOptions,
  type TabType,
  type TabConfig,
  type TerminalStatus,
  type TaskStatus,
  type SplitDirection,
  type SplitWhere,
  type TaskPatch,
  type ProjectAgentPatch,
  type SettingsPatch,
  type Worktree,
  type Tab,
  type ControlRequest,
  type ControlResponse
} from '@shared/types'
import { runtime, repo } from './runtime'
import { git } from './services/git'
import { createLinkedWorktree, removeWorktree } from './services/worktree'
import { planWorktreeSync, pathsBeingCreated, WorktreesWatcher } from './services/worktree-scan'
import { copyNodeModulesTree, targetsNodeModules } from './services/env-sync'
import { splitAt, removePane, setRatio, edgeToSplit } from './services/layout'
import { cliDir } from './services/agents/paths'
import { getProvider } from './services/agents/provider'
import { agentProfileDir, inspectProfileDir, resolveAgent } from './services/agents/profiles'
import { writeBriefing, deleteBriefing, pruneBriefings, briefingKey } from './services/agents/briefing'
import { savePastedImage, prunePastedImages } from './services/pasted-images'
import * as claudeHooks from './services/agents/claude-hooks'
import * as claudeSkill from './services/agents/claude-skill'
import * as codexInstructions from './services/agents/codex-instructions'
import { updater } from './services/updater'
import { logger, summarizeArgs } from './services/logger'
import { activeControlPipePath, exportWorkspaceToFile, importWorkspaceFromFile } from './services/workspaces'
import { getSettings, patchTouches, setSettings } from './services/settings'
import { refreshJumpList } from './services/jump-list'

/* ---- helpers ----------------------------------------------------------- */

/**
 * Kick off a freshly created linked Worktree's background setup: bulk-copy
 * node_modules off the critical path (awaiting it would block worktree creation
 * for minutes), flagging the worktree as "setting up" so the rail shows a
 * spinner until the copy finishes. No-op for root Worktrees or when
 * node_modules isn't a sync target.
 */
function beginWorktreeSetup(worktree: Worktree, repoPath: string): void {
  if (worktree.kind !== 'linked') return
  if (!targetsNodeModules(getSettings().envSyncPatterns)) return
  runtime.markSettingUp(worktree.id)
  void copyNodeModulesTree(repoPath, worktree.path).finally(() => runtime.clearSettingUp(worktree.id))
}

function terminalEnv(worktree: Worktree, tabId: string): Record<string, string> {
  const path = `${cliDir()}${PATH_DELIM}${process.env.PATH ?? ''}`
  return {
    [ENV.terminalId]: tabId,
    [ENV.worktreeId]: worktree.id,
    [ENV.projectId]: worktree.projectId,
    [ENV.socket]: activeControlPipePath(),
    PATH: path,
    Path: path
  }
}

function spawnTerminal(worktree: Worktree, tab: Tab): void {
  const shellPref = getSettings().defaultShell || undefined
  runtime.terminals.prepare({
    tabId: tab.id,
    cwd: worktree.path,
    shell: shellPref,
    env: terminalEnv(worktree, tab.id)
  })
}

/**
 * Boot a coding agent (e.g. Claude) directly as the tab's PTY. Resolution is async
 * (it shells out to `where`/`which`); on failure the tab shows a clear notice and
 * flips to `error` instead of sitting as a silent dead pane.
 */
async function spawnAgent(worktree: Worktree, tab: Tab): Promise<void> {
  const project = repo.projects.get(worktree.projectId)
  if (!project) return
  // The configured profile this tab launches (profile dir, exec path, args, env).
  // Each reference is tried in turn, so a tab whose profile was deleted falls
  // back to the project's default rather than to a bare provider. `agentProvider`
  // is what tabs created before profiles had ids stored.
  const agentConfig = resolveAgentRef(
    getSettings().agents,
    tab.config.agentId,
    tab.config.agentProvider,
    project.defaultAgentId
  )
  const provider = getProvider(agentConfig?.provider)
  try {
    // Only providers that can be handed a briefing get one written — the rest
    // would leave an unread file behind on every launch.
    const briefingPath = provider.acceptsBriefingFile
      ? writeBriefing({
          project,
          worktree,
          tabId: tab.id,
          providerName: provider.id === 'claude' ? 'Claude Code' : provider.displayName,
          // The status hooks are CLAUDE's: another provider's session reports
          // nothing on its own, so it always needs the self-report instructions.
          // Read the settings.json of THIS profile (the source of truth) — a
          // sibling Claude profile's install says nothing about this one.
          hooksInstalled:
            provider.id === 'claude' && !!agentConfig && claudeHooks.status(agentConfig).installed
        })
      : null
    const command = await provider.resolveCommand({
      project,
      worktree,
      briefingPath,
      // A project-level path is the more specific override; the workspace
      // agent's path fills in when the project doesn't set one.
      execPath: project.agentExecPath || agentConfig?.execPath
    })
    if (agentConfig?.args?.length) command.args.push(...agentConfig.args)
    // The tab may have been closed during the async executable lookup; don't spawn
    // a PTY nothing references (it could never be killed before app exit).
    if (!repo.tabs.get(tab.id)) {
      deleteBriefing(worktree.id, tab.id)
      return
    }
    const envVar = SUPPORTED_AGENTS.find((a) => a.id === provider.id)?.configDirEnvVar
    runtime.terminals.prepare({
      tabId: tab.id,
      cwd: worktree.path,
      env: {
        // Entry env first: the dedicated profile-dir field beats a hand-typed
        // duplicate, and Orbital's control vars (ids, socket, PATH) stay authoritative.
        ...agentConfig?.env,
        // The EXPANDED directory, which is also what the installers write into —
        // exporting the raw `~/…` would point the CLI at the worktree instead.
        ...(envVar && agentConfig?.configDir ? { [envVar]: agentProfileDir(agentConfig) } : {}),
        ...terminalEnv(worktree, tab.id)
      },
      command
    })
  } catch (err) {
    if (!repo.tabs.get(tab.id)) return // tab gone during resolution — nothing to report
    const msg = err instanceof Error ? err.message : String(err)
    runtime.terminals.notify(
      tab.id,
      `\r\n\x1b[31mOrbital could not launch ${provider.displayName}:\x1b[0m\r\n  ${msg}\r\n`
    )
    repo.tabs.updateStatus(tab.id, 'error')
    repo.worktrees.recomputeStatus(worktree.id)
    runtime.broadcastState()
    runtime.broadcastAlert()
  }
}

/** Start the PTY for a freshly created PTY-backed tab (terminal or agent). */
function startPtyTab(worktree: Worktree, tab: Tab): void {
  if (tab.type === 'agent') void spawnAgent(worktree, tab)
  else if (tab.type === 'terminal') spawnTerminal(worktree, tab)
}

/** Create a tab in a Worktree (resolving the target pane) and start its PTY if PTY-backed. */
function createTabInWorktree(worktreeId: string, paneId: string | null, type: TabType, config?: TabConfig): Tab {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) throw new Error(`worktree ${worktreeId} not found`)
  const targetPane = paneId ?? repo.panes.firstPaneId(worktreeId)
  if (!targetPane) throw new Error(`worktree ${worktreeId} has no pane`)
  const tab = repo.tabs.create({ worktreeId, paneId: targetPane, type, config })
  startPtyTab(worktree, tab)
  return tab
}

function killWorktreeTerminals(worktreeId: string): void {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) return
  for (const pane of worktree.panes) {
    for (const tab of pane.tabs) {
      if (isPtyTabType(tab.type)) runtime.terminals.kill(tab.id)
    }
  }
}

function killPaneTerminals(paneId: string): void {
  for (const tab of repo.tabs.inPane(paneId)) {
    if (isPtyTabType(tab.type)) runtime.terminals.kill(tab.id)
  }
}

/** Drop an empty pane, collapsing the layout to its sibling — never the Worktree's last pane. */
function collapseIfEmpty(worktreeId: string, paneId: string): void {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree || worktree.panes.length <= 1) return
  const pane = worktree.panes.find((p) => p.id === paneId)
  if (!pane || pane.tabs.length > 0) return
  const next = removePane(worktree.layout, paneId)
  if (next) repo.worktrees.setLayout(worktreeId, next)
  repo.panes.remove(paneId)
}

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

/** Register a project: create its root Worktree and start its watchers. */
async function registerProject(repoPath: string): Promise<Worktree | null> {
  const existing = repo.projects.getByPath(repoPath)
  if (existing) {
    runtime.gitWatcher.watch(repoPath)
    runtime.ensureEnvWatcher(existing.id)
    ensureWorktreesWatcher(existing)
    return repo.worktrees.list().find((w) => w.projectId === existing.id && w.kind === 'root') ?? null
  }
  const name = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath
  const project = repo.projects.create({ name, repoPath })
  const branch = await git.currentBranch(repoPath).catch(() => 'main')
  const root = repo.worktrees.create({
    projectId: project.id,
    kind: 'root',
    name: 'main',
    path: repoPath,
    branch
  })
  runtime.gitWatcher.watch(repoPath)
  runtime.ensureEnvWatcher(project.id)
  ensureWorktreesWatcher(project)
  return root
}

/* ---- git worktree auto-discovery ---------------------------------------- */

/** One admin-dir watcher per project so external worktree add/remove shows live. */
const worktreesWatchers = new Map<string, WorktreesWatcher>()

function ensureWorktreesWatcher(project: { id: string; repoPath: string }): void {
  if (worktreesWatchers.has(project.id)) return
  const watcher = new WorktreesWatcher(project.repoPath)
  worktreesWatchers.set(project.id, watcher)
  watcher.on('changed', () => void reconcileProjectWorktrees(project.id))
  void watcher.start()
}

function removeWorktreesWatcher(projectId: string): void {
  worktreesWatchers.get(projectId)?.stop()
  worktreesWatchers.delete(projectId)
}

/** Stop every discovery watcher (app shutdown). */
export function stopWorktreesWatchers(): void {
  for (const watcher of worktreesWatchers.values()) watcher.stop()
  worktreesWatchers.clear()
}

/** Tear down everything the runtime holds for a Worktree (PTYs, watchers, servers, briefings). */
function releaseWorktreeRuntime(worktree: Worktree): void {
  killWorktreeTerminals(worktree.id)
  runtime.clearDevServers(worktree.id)
  if (worktree.kind === 'linked') {
    runtime.gitWatcher.unwatch(worktree.path)
    runtime.envWatchers.get(worktree.projectId)?.unregister(worktree.path)
  }
  for (const pane of worktree.panes) {
    for (const tab of pane.tabs) if (tab.type === 'agent') deleteBriefing(worktree.id, tab.id)
  }
}

/**
 * Make a project's Worktrees match `git worktree list`: adopt checkouts created
 * outside Orbital, drop rows whose checkout is gone (their tabs/layout go too —
 * UI state is keyed to a live checkout), and resync branches. Broadcasts only
 * when something actually changed.
 */
export async function reconcileProjectWorktrees(projectId: string): Promise<void> {
  const project = repo.projects.get(projectId)
  if (!project) return
  let entries
  try {
    entries = await git.worktreeList(project.repoPath)
  } catch {
    return // repo dir missing or not a git repo — leave the stored rows alone
  }
  // Everything from here to the end of the apply below is synchronous, so it sees
  // one consistent picture: no create can slip in between the rows snapshot, the
  // in-flight list, and the writes.
  const rows = repo.worktrees.list().filter((w) => w.projectId === projectId)
  // A checkout that IS another project belongs to that project's rail entry; one
  // Orbital is still creating gets its row from createLinkedWorktree, not here.
  const skip = [
    ...repo.projects
      .list()
      .filter((p) => p.id !== projectId)
      .map((p) => p.repoPath),
    ...pathsBeingCreated()
  ]
  const plan = planWorktreeSync(project, rows, entries, skip)
  if (!plan.createRoot && plan.adopt.length === 0 && plan.remove.length === 0 && plan.branchUpdates.length === 0) {
    return
  }

  // A project that entered via the workspace YAML starts without a root row.
  if (plan.createRoot) {
    repo.worktrees.create({
      projectId,
      kind: 'root',
      name: 'main',
      path: project.repoPath,
      branch: plan.createRoot.branch
    })
  }
  for (const a of plan.adopt) {
    repo.worktrees.create({ projectId, kind: 'linked', name: a.name, path: a.path, branch: a.branch })
    runtime.gitWatcher.watch(a.path)
  }
  // Registers every linked checkout (including the just-adopted) for env sync.
  if (plan.adopt.length > 0) runtime.ensureEnvWatcher(projectId)
  for (const row of plan.remove) {
    releaseWorktreeRuntime(row)
    repo.worktrees.remove(row.id)
  }
  for (const u of plan.branchUpdates) repo.worktrees.updateBranchByPath(u.path, u.branch)

  runtime.broadcastState()
  runtime.broadcastAlert()
}

/* ---- status-event ordering ---------------------------------------------- */

/**
 * Fire time of the last status event applied per terminal (runtime-only state).
 *
 * Claude hooks are registered async, so each event arrives from its own
 * short-lived `orbital hook` process and pipe DELIVERY order is not fire order:
 * the PostToolUse of a turn's final tool call regularly lands after the Stop
 * that ended the turn, wedging an idle worktree on the "working" spinner. Every
 * status-bearing request carries the moment it was fired (stamped by the CLI
 * before its stdin wait); an event older than the last one applied is stale.
 */
const statusAppliedAt = new Map<string, number>()

/** Record a status event's fire time; false when a later-fired event already landed. */
function acceptStatusEvent(terminalId: string, firedAt: unknown): boolean {
  const ts = typeof firedAt === 'number' && Number.isFinite(firedAt) ? firedAt : Date.now()
  if (ts < (statusAppliedAt.get(terminalId) ?? 0)) return false
  statusAppliedAt.set(terminalId, ts)
  return true
}

/**
 * Why each needs-attention tab is blocked, keyed by tab id: the Notification
 * hook's notification_type ('permission_prompt' | 'idle_prompt'), recorded when
 * that status lands and cleared when it resolves. Human input consults this to
 * pick the right next status — answering a permission prompt puts Claude
 * straight to work, while typing at an idle prompt is just composing.
 */
const attentionKind = new Map<string, string>()

/**
 * Notification types that mean Claude is blocked on a human. Beyond the two
 * prompt kinds, Claude raises elicitation dialogs (a question or a URL to visit)
 * and agent-input requests — all of them a stopped agent waiting for a person,
 * which is exactly what the rail badge and the chime exist to surface.
 */
const BLOCKING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input'
])

/** Notification types that mean such a block just resolved and Claude carries on. */
const RESOLVED_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response'])

/**
 * Where a tab goes when the human types into it while it is blocked. Answering
 * something Claude ASKED — a permission prompt, an elicitation dialog, a request
 * for input — puts it straight back to work (and a long approved tool emits no
 * hook until it finishes). The exception is an idle prompt: nobody asked
 * anything, so typing there is just composing the next instruction and the tab
 * stays idle until the UserPromptSubmit hook fires on send.
 */
function statusAfterHumanInput(kind: string | undefined): TerminalStatus {
  return kind && kind !== 'idle_prompt' && BLOCKING_NOTIFICATIONS.has(kind) ? 'working' : 'idle'
}

// Focus-in/out reports and mouse-tracking sequences a TUI subscribed to — sent
// by merely clicking into or scrolling a terminal, so not a human response.
// eslint-disable-next-line no-control-regex
const TERMINAL_REPORTS = /\x1b\[(?:I|O|<\d+;\d+;\d+[Mm]|M[\s\S]{3})/g

/** True when terminal input contains an actual keystroke/paste, not just reports. */
function isHumanKeystroke(data: string): boolean {
  return data.replace(TERMINAL_REPORTS, '').length > 0
}

/**
 * Open the platform's external terminal application with `dir` as its working
 * directory, detached so it outlives Orbital.
 *
 * Shared by the Worktree-scoped and project-scoped hand-offs so the Windows
 * "Windows Terminal, else a PowerShell window" fallback is written once —
 * `wt` is absent on stock Windows Server and on machines where the user
 * removed it, and the two entry points must degrade identically.
 *
 * `dir` is always a path MAIN derived (from a stored Worktree or project), so
 * whatever containment applies has already been applied by the caller.
 */
function spawnExternalTerminal(dir: string): void {
  if (process.platform === 'win32') {
    const wt = spawn('wt', ['-d', dir], { detached: true, stdio: 'ignore' })
    wt.on('error', () => {
      const ps = spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit'], {
        cwd: dir,
        detached: true,
        stdio: 'ignore'
      })
      ps.unref()
    })
    wt.unref()
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
  }
}

/* ---- registration ------------------------------------------------------ */

export function registerIpc(): void {
  // Every UI action funnels through this wrapper so the debug logger sees each
  // invoke (channel + summarized args) and any thrown error, without touching
  // the individual handler call sites below. It delegates to ipcMain.handle and
  // re-throws so the renderer still sees the original rejection. Logging is a
  // no-op unless debug logging is enabled, so this is free in the common case.
  const h = (
    channel: string,
    fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void => {
    ipcMain.handle(channel, async (e, ...args) => {
      // Guard so summarizeArgs (allocates a mapped copy) never runs when logging
      // is off — this wrapper is on every UI invoke's path.
      if (logger.isEnabled()) logger.ui(channel, summarizeArgs(args))
      try {
        return await fn(e, ...args)
      } catch (err) {
        logger.error(`ipc ${channel} failed`, {
          message: err instanceof Error ? err.message : String(err)
        })
        throw err // preserve the existing rejection surfaced to the renderer
      }
    })
  }
  const broadcast = (): void => runtime.broadcastState()
  const broadcastAll = (): void => {
    runtime.broadcastState()
    runtime.broadcastAlert()
  }

  // ---- state / settings ----
  h(IPC.getState, () => runtime.appState())
  h(IPC.setSettings, (_e, patch: SettingsPatch) => {
    // Merges the patch's keys across the global store and the workspace YAML
    // behind the facade, leaving every key the renderer did not send untouched.
    const s = setSettings(patch)
    // Each side effect is gated on the key that actually drives it. Patches are
    // now single-key and frequent — a theme click sends { theme }, an untouched
    // Save sends {} — and running all three unconditionally meant every one of
    // those stopped and restarted the FS watcher of every project
    // (ensureEnvWatcher -> updatePatterns) to re-apply patterns that had not
    // changed.
    //
    // Env-sync patterns are a workspace setting — refresh every project's watcher.
    if (patchTouches(patch, 'envSyncPatterns')) {
      for (const project of repo.projects.list()) runtime.ensureEnvWatcher(project.id)
    }
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
    runtime.removeEnvWatcher(projectId)
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

  // ---- worktrees / panes / tabs ----
  h(IPC.createWorktree, async (_e, projectId: string, opts: CreateWorktreeOptions) => {
    const project = repo.projects.get(projectId)
    if (!project) throw new Error(`project ${projectId} not found`)
    const branch = (opts.branch || opts.name || `worktree-${Date.now()}`).trim()
    const worktree = await createLinkedWorktree({
      project,
      branch,
      existingBranch: opts.existingBranch,
      name: opts.name,
      baseRef: opts.baseRef,
      taskId: opts.taskId
    })
    // Link the originating task to this Worktree (so it shows the Worktree ref and
    // drops out of the "unlinked tasks" picker).
    if (opts.taskId) repo.tasks.setWorktree(opts.taskId, worktree.id)
    runtime.gitWatcher.watch(worktree.path)
    runtime.ensureEnvWatcher(projectId)
    beginWorktreeSetup(worktree, project.repoPath)
    broadcastAll()
    return repo.worktrees.get(worktree.id)!
  })

  h(IPC.removeWorktree, async (_e, worktreeId: string, opts: RemoveWorktreeOptions) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    if (worktree.kind === 'root') throw new Error('the root Worktree cannot be removed')
    if (opts.removeWorktree) {
      const project = repo.projects.get(worktree.projectId)
      if (project) {
        // Dirty guard BEFORE tearing anything down, so a refused removal leaves
        // the Worktree fully intact and its unpushed work is not silently
        // orphaned (PRD §5 unpushed-work guard).
        if (!opts.force && !(await git.status(worktree.path)).clean) {
          throw new Error('The worktree has uncommitted changes.')
        }
        // Release everything holding handles inside the worktree before git
        // deletes it — on Windows a PTY cwd'd there (or a directory watcher)
        // locks the folder and makes the removal fail on the first attempt.
        runtime.gitWatcher.unwatch(worktree.path)
        runtime.envWatchers.get(project.id)?.unregister(worktree.path)
        killWorktreeTerminals(worktreeId)
        try {
          await removeWorktree(project.repoPath, worktree.path, opts.force)
        } catch (err) {
          // Removal still failed — restore the Worktree to a usable state
          // (watchers back on, fresh PTYs) before surfacing the error.
          runtime.gitWatcher.watch(worktree.path)
          runtime.ensureEnvWatcher(project.id)
          for (const pane of worktree.panes) {
            for (const tab of pane.tabs) if (isPtyTabType(tab.type)) startPtyTab(worktree, tab)
          }
          broadcastAll()
          throw err
        }
      }
    }
    runtime.gitWatcher.unwatch(worktree.path)
    runtime.clearDevServers(worktreeId)
    killWorktreeTerminals(worktreeId)
    for (const pane of worktree.panes) {
      for (const t of pane.tabs) if (t.type === 'agent') deleteBriefing(worktreeId, t.id)
    }
    repo.worktrees.remove(worktreeId)
    broadcastAll()
  })

  h(IPC.renameWorktree, (_e, worktreeId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    repo.worktrees.rename(worktreeId, trimmed)
    broadcast()
  })

  h(IPC.clearWorktreeStatus, (_e, worktreeId: string) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    for (const pane of worktree.panes) {
      for (const tab of pane.tabs) {
        if (!isPtyTabType(tab.type)) continue
        // The user's force-clear supersedes anything already in flight: hook
        // events fired before this moment must not re-set the status below.
        statusAppliedAt.set(tab.id, Date.now())
        attentionKind.delete(tab.id)
        repo.tabs.updateStatus(tab.id, 'idle')
      }
    }
    repo.worktrees.recomputeStatus(worktreeId)
    broadcastAll()
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

  h(IPC.inspectProfileDir, (_e, provider: string, configDir: string) => inspectProfileDir(provider, configDir))

  // ---- Claude status hooks (opt-in, per agent profile's settings.json) ----
  // Every channel below names the agent profile it acts on: the files live in
  // that profile's directory, so two Claude profiles are two independent installs.
  h(IPC.claudeHooksStatus, (_e, agentId: string) => claudeHooks.status(resolveAgent(agentId)))
  h(IPC.claudeHooksPlan, (_e, agentId: string) => claudeHooks.plan(resolveAgent(agentId)))
  h(IPC.installClaudeHooks, (_e, agentId: string) => claudeHooks.install(resolveAgent(agentId)))
  h(IPC.removeClaudeHooks, (_e, agentId: string) => claudeHooks.remove(resolveAgent(agentId)))

  // ---- the `orbital` Agent Skill (opt-in, per Claude profile) ----
  h(IPC.claudeSkillStatus, (_e, agentId: string) => claudeSkill.status(resolveAgent(agentId)))
  h(IPC.claudeSkillPlan, (_e, agentId: string) => claudeSkill.plan(resolveAgent(agentId)))
  h(IPC.installClaudeSkill, (_e, agentId: string) => claudeSkill.install(resolveAgent(agentId)))
  h(IPC.removeClaudeSkill, (_e, agentId: string) => claudeSkill.remove(resolveAgent(agentId)))

  // ---- Codex instructions (opt-in, a managed block in the profile's AGENTS.md) ----
  h(IPC.codexInstructionsStatus, (_e, agentId: string) => codexInstructions.status(resolveAgent(agentId)))
  h(IPC.codexInstructionsPlan, (_e, agentId: string) => codexInstructions.plan(resolveAgent(agentId)))
  h(IPC.installCodexInstructions, (_e, agentId: string) => codexInstructions.install(resolveAgent(agentId)))
  h(IPC.removeCodexInstructions, (_e, agentId: string) => codexInstructions.remove(resolveAgent(agentId)))

  h(IPC.createTab, (_e, worktreeId: string, paneId: string | null, type: TabType, config?: TabConfig) => {
    const tab = createTabInWorktree(worktreeId, paneId, type, config)
    broadcast()
    return tab
  })

  h(IPC.closeTab, (_e, tabId: string) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    if (isPtyTabType(tab.type)) runtime.terminals.kill(tabId)
    if (tab.type === 'agent') deleteBriefing(tab.worktreeId, tabId)
    repo.tabs.remove(tabId)
    // Closing the last tab leaves the (now empty) pane in place — it shows the
    // "Open a terminal" prompt. Panes only collapse when a tab is dragged out.
    repo.worktrees.recomputeStatus(tab.worktreeId)
    broadcastAll()
  })

  h(IPC.renameTab, (_e, tabId: string, title: string) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    // An empty title clears the override; JSON.stringify drops the undefined key.
    repo.tabs.updateConfig(tabId, { ...tab.config, title: title.trim() || undefined })
    broadcast()
  })

  h(IPC.setActiveTab, (_e, paneId: string, tabId: string) => {
    repo.tabs.setActive(paneId, tabId)
    broadcast()
  })

  /**
   * A tab belongs to exactly one worktree for its whole life. EditorTab and
   * TerminalTab read `tab.worktreeId` on that basis, and `tabs.move` updates
   * only `pane_id` — so a move into another worktree's pane would leave a tab
   * whose stored worktree disagrees with the pane rendering it. The renderer
   * cannot produce such a drag today (PaneGroup only shows one worktree's
   * panes), but an invariant main depends on is main's to enforce.
   */
  const assertPaneInWorktree = (tab: Tab, paneId: string): void => {
    const owner = repo.panes.worktreeIdOf(paneId)
    if (!owner) throw new Error(`pane ${paneId} not found`)
    if (owner !== tab.worktreeId) throw new Error('a tab cannot move to a pane in another worktree')
  }

  h(IPC.moveTab, (_e, tabId: string, targetPaneId: string) => {
    const tab = repo.tabs.get(tabId)
    if (!tab || tab.paneId === targetPaneId) return
    assertPaneInWorktree(tab, targetPaneId)
    const source = tab.paneId
    repo.tabs.move(tabId, targetPaneId)
    collapseIfEmpty(tab.worktreeId, source)
    broadcast()
  })

  h(IPC.splitPane, (_e, worktreeId: string, paneId: string, dir: SplitDirection, where: SplitWhere) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) throw new Error(`worktree ${worktreeId} not found`)
    const pane = repo.panes.create(worktreeId)
    repo.worktrees.setLayout(worktreeId, splitAt(worktree.layout, paneId, dir, where, pane.id))
    broadcast()
    return pane
  })

  h(IPC.closePane, (_e, worktreeId: string, paneId: string) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    if (worktree.panes.length <= 1) throw new Error('cannot close the last pane')
    killPaneTerminals(paneId)
    const next = removePane(worktree.layout, paneId)
    if (next) repo.worktrees.setLayout(worktreeId, next)
    repo.panes.remove(paneId) // cascades the pane's tabs
    repo.worktrees.recomputeStatus(worktreeId)
    broadcastAll()
  })

  h(IPC.moveTabToEdge, (_e, tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom') => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    const worktree = repo.worktrees.get(tab.worktreeId)
    if (!worktree) return
    // Splitting at a pane from another worktree would be a no-op on this
    // worktree's layout, leaving the fresh pane orphaned outside it.
    assertPaneInWorktree(tab, targetPaneId)
    const source = tab.paneId
    const { dir, where } = edgeToSplit(edge)
    const pane = repo.panes.create(worktree.id)
    repo.worktrees.setLayout(worktree.id, splitAt(worktree.layout, targetPaneId, dir, where, pane.id))
    repo.tabs.move(tabId, pane.id)
    collapseIfEmpty(worktree.id, source)
    broadcast()
  })

  h(IPC.setSplitRatio, (_e, worktreeId: string, splitId: string, ratio: number) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    repo.worktrees.setLayout(worktreeId, setRatio(worktree.layout, splitId, ratio))
    broadcast()
  })

  // ---- terminals ----
  ipcMain.on(IPC.terminalInput, (_e, tabId: string, data: string) => {
    runtime.terminals.write(tabId, data)
    // If the human types into a PTY flagged needs-attention, they've responded —
    // so it is no longer blocked on a human. This covers agent tabs AND plain
    // terminal tabs (an agent launched by hand, or `orbital status`, flags those
    // just the same). Where it goes depends on why it was blocked — see
    // statusAfterHumanInput. Uses INPUT only — never scrapes terminal output (req 7).
    const tab = repo.tabs.get(tabId)
    if (tab && isPtyTabType(tab.type) && tab.status === 'needs_attention' && isHumanKeystroke(data)) {
      // The human's response supersedes anything already in flight: hook events
      // fired before this moment must not overwrite the flip below.
      statusAppliedAt.set(tabId, Date.now())
      const next = statusAfterHumanInput(attentionKind.get(tabId))
      attentionKind.delete(tabId)
      repo.tabs.updateStatus(tabId, next)
      repo.worktrees.recomputeStatus(tab.worktreeId)
      runtime.broadcastState()
      runtime.broadcastAlert()
    }
  })
  ipcMain.on(IPC.terminalResize, (_e, tabId: string, cols: number, rows: number) =>
    runtime.terminals.resize(tabId, cols, rows)
  )
  h(IPC.terminalBuffer, (_e, tabId: string) => runtime.terminals.buffer(tabId))
  h(IPC.terminalAlive, (_e, tabId: string) => runtime.terminals.isAlive(tabId))
  h(IPC.pasteClipboardImage, () => savePastedImage())

  // ---- git ----
  const worktreeRepoPath = (worktreeId: string): string => {
    const w = repo.worktrees.get(worktreeId)
    if (!w) throw new Error(`worktree ${worktreeId} not found`)
    return w.path
  }
  h(IPC.gitStatus, (_e, worktreeId: string) => git.status(worktreeRepoPath(worktreeId)))
  h(IPC.gitStage, async (_e, worktreeId: string, path: string) => {
    await git.stage(worktreeRepoPath(worktreeId), path)
    broadcast()
  })
  h(IPC.gitUnstage, async (_e, worktreeId: string, path: string) => {
    await git.unstage(worktreeRepoPath(worktreeId), path)
    broadcast()
  })
  h(IPC.gitStageAll, async (_e, worktreeId: string) => {
    await git.stageAll(worktreeRepoPath(worktreeId))
    broadcast()
  })
  h(IPC.gitUnstageAll, async (_e, worktreeId: string) => {
    await git.unstageAll(worktreeRepoPath(worktreeId))
    broadcast()
  })
  h(IPC.gitDiscard, async (_e, worktreeId: string, path: string) => {
    await git.discard(worktreeRepoPath(worktreeId), path)
    broadcast()
  })
  h(IPC.gitDiscardAll, async (_e, worktreeId: string) => {
    await git.discardAll(worktreeRepoPath(worktreeId))
    broadcast()
  })
  h(IPC.gitCommit, async (_e, worktreeId: string, message: string, amend?: boolean) => {
    await git.commit(worktreeRepoPath(worktreeId), message, amend)
    broadcast()
  })
  h(IPC.gitLastCommitMessage, (_e, worktreeId: string) => git.lastCommitMessage(worktreeRepoPath(worktreeId)))
  h(IPC.gitPush, (_e, worktreeId: string) => git.push(worktreeRepoPath(worktreeId)))
  h(IPC.gitPull, async (_e, worktreeId: string) => {
    await git.pull(worktreeRepoPath(worktreeId))
    broadcast()
  })
  h(IPC.gitFetch, (_e, worktreeId: string) => git.fetch(worktreeRepoPath(worktreeId)))
  h(IPC.gitCheckout, async (_e, worktreeId: string, branch: string, create?: boolean) => {
    const w = repo.worktrees.get(worktreeId)
    if (!w) throw new Error(`worktree ${worktreeId} not found`)
    // Linked Worktrees are pinned to their branch; only the root checkout may move HEAD.
    if (w.kind !== 'root') throw new Error('branches can only be switched on the root Worktree')
    await git.checkout(w.path, branch, create)
    // Persist the new HEAD onto the Worktree so the rail/panel reflect it immediately.
    await runtime.refreshBranch(w.path)
    broadcast()
  })
  h(IPC.gitDiff, (_e, worktreeId: string, path: string, staged: boolean) =>
    git.diff(worktreeRepoPath(worktreeId), path, staged)
  )
  h(IPC.fileTree, (_e, worktreeId: string) => git.fileTree(worktreeRepoPath(worktreeId)))
  // Every handler from here down is given a checkout-relative path chosen by
  // the renderer, and every one of them resolves it through the git service's
  // containment gate rather than joining it onto the checkout root and hoping.
  // Which half of the gate each uses (lexical, or lexical plus a real-path
  // check of the ancestors) is argued in git.ts beside the functions.
  h(IPC.listDir, (_e, worktreeId: string, path: string) => git.listDir(worktreeRepoPath(worktreeId), path))
  h(IPC.readFile, (_e, worktreeId: string, path: string) => git.readFile(worktreeRepoPath(worktreeId), path))
  h(IPC.readFileBase64, (_e, worktreeId: string, path: string) => git.readFileBase64(worktreeRepoPath(worktreeId), path))
  h(IPC.writeFile, async (_e, worktreeId: string, path: string, content: string) => {
    await git.writeFile(worktreeRepoPath(worktreeId), path, content)
    broadcast()
  })
  // The four mutating file operations behind the editor tree's context menu.
  // Like writeFile above, each is checked lexically AND against the real
  // filesystem, so a symlinked directory can't lead one out of the checkout;
  // an escaping path is rejected before anything touches disk. The read-only
  // resolvePath below stops at the lexical check — it hands back a string and
  // writes nothing.
  h(IPC.createFile, async (_e, worktreeId: string, parentDir: string, name: string) => {
    const path = await git.createFile(worktreeRepoPath(worktreeId), parentDir, name)
    broadcast()
    return path
  })
  h(IPC.createDirectory, async (_e, worktreeId: string, parentDir: string, name: string) => {
    const path = await git.createDirectory(worktreeRepoPath(worktreeId), parentDir, name)
    broadcast()
    return path
  })
  h(IPC.renamePath, async (_e, worktreeId: string, path: string, newName: string) => {
    const next = await git.renamePath(worktreeRepoPath(worktreeId), path, newName)
    broadcast()
    return next
  })
  h(IPC.trashPath, async (_e, worktreeId: string, path: string) => {
    await git.trashPath(worktreeRepoPath(worktreeId), path)
    broadcast()
  })
  h(IPC.resolvePath, (_e, worktreeId: string, path: string) =>
    git.resolveInRepo(worktreeRepoPath(worktreeId), path)
  )

  // ---- tasks ----
  h(IPC.createTask, (_e, projectId: string, title: string, description?: string, tags?: string[]) => {
    const t = repo.tasks.create({ projectId, title, description, tags })
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

  // ---- browser / window ----
  h(IPC.openExternal, (_e, url: string) => shell.openExternal(url))
  // A <webview>'s popups (Ctrl/Cmd-click, target=_blank, window.open) can only be
  // intercepted on the guest's webContents in main. Route them to a NEW internal
  // browser tab in the same worktree/pane and deny the real popup window.
  h(IPC.registerBrowserView, (_e, webContentsId: number, worktreeId: string, paneId: string) => {
    const wc = webContents.fromId(webContentsId)
    if (!wc) return
    wc.setWindowOpenHandler((details) => {
      const url = details.url
      if (/^https?:\/\//i.test(url) && repo.worktrees.get(worktreeId)) {
        createTabInWorktree(worktreeId, paneId, 'browser', { url })
        runtime.broadcastState()
      }
      return { action: 'deny' }
    })
  })
  /* ---- OS hand-offs ------------------------------------------------------
   *
   * These three used to take an absolute path straight from the renderer, so
   * `shell.openPath('C:\\evil.exe')` was one compromised-renderer message
   * away — the strongest of the three, since openPath LAUNCHES whatever it is
   * given with its registered application. They now take the same
   * `(worktreeId, path)` pair as every other file operation and do the
   * resolution here, so the absolute path handed to Electron is one main
   * derived itself from a checkout it knows about.
   *
   * The gate is the LEXICAL `resolveInRepo`, on all three, and that is a
   * decision rather than an oversight — so it is worth writing down what it
   * does not catch. A symlink or junction committed inside the checkout is a
   * directory entry like any other; the OS follows it, so `link/app.exe` (or
   * `link` itself) can resolve anywhere on the machine and still be handed to
   * `shell.openPath`. `resolveInRepoReal` was weighed for this and turned down:
   *
   *  - It would only half-close it. That gate resolves the ANCESTORS and leaves
   *    the final segment alone on purpose (so a link entry can be renamed and
   *    binned like the ordinary directory entry it is), which means the natural
   *    shape here — one committed symlink aimed at an executable, named
   *    directly — sails straight through it. Only a target NESTED under a
   *    linked directory would be refused. A leaf-resolving variant would close
   *    that, at the cost below, and it exists nowhere else in the codebase.
   *  - The cost is a false rejection of exactly what the user clicked. These
   *    three act on an entry the tree is showing, and some of those entries are
   *    links out of the checkout by design: a junction-backed folder someone
   *    dropped in the working copy, a package pulled in by `npm link` /
   *    `pnpm link --global`, a yarn `link:`/`portal:` dependency, or a monorepo
   *    workspace rooted ABOVE the checkout. (Not, note, an ordinary install:
   *    pnpm's default hoisted layout leaves no symlinks under `node_modules` at
   *    all, and even `node-linker=isolated` points its links back INTO the
   *    checkout, at `node_modules/.pnpm/…`. Its link to the global store is a
   *    HARDLINK, which `realpath` does not follow — so real-path containment
   *    would not have rejected a plain `pnpm install` tree. The escaping cases
   *    are real but narrower than "every node_modules".) Refusing to reveal a
   *    file the tree just drew is still a bug the user meets; the escape is one
   *    they have to be attacked with.
   *  - And it would not buy the guarantee it looks like it buys. Containment
   *    here is least-authority scoping — main never takes an absolute path from
   *    the renderer on faith — not an exploit barrier, because there isn't one
   *    to be had at this layer: a payload committed IN the checkout satisfies
   *    every containment gate there is, so real-path resolution changes which
   *    file can be launched, not whether one can be. And a renderer compromised
   *    enough to call these unattended already has `IPC.createTab` +
   *    `IPC.terminalInput`, i.e. arbitrary commands in a PTY, by design —
   *    Orbital is a terminal multiplexer. Nothing decided here narrows that.
   *
   * What the gate does earn is real: the renderer can only name entries in a
   * checkout main already knows about, `..` and absolute paths are refused with
   * a message, and every caller is an explicit click on a visible entry.
   *
   * An empty `path` means the checkout root, which is what a Worktree row's
   * "Open in Explorer" / "Open in External Terminal" want. A PROJECT header's
   * two equivalents do not come through here at all — see the project-scoped
   * pair below, which need no Worktree to exist.
   */
  const worktreePath = (worktreeId: string, path: string): string =>
    git.resolveInRepo(worktreeRepoPath(worktreeId), path)

  h(IPC.openPath, async (_e, worktreeId: string, path: string) => {
    // `shell.openPath` reports failure by RESOLVING with a message rather than
    // rejecting, so without this an unopenable file is a silent no-op — the
    // context menu closes and nothing happens. Rethrowing puts the OS's own
    // words in front of the user from the file context menu; the rail's
    // callers have no error line and route through `fireAndForget`, so there
    // the rejection lands in the app log (the handler wrapper logs it) instead.
    const err = await shell.openPath(worktreePath(worktreeId, path))
    if (err) throw new Error(err)
  })
  // showItemInFolder, not openPath: this opens the CONTAINING folder with the
  // item selected, which is what "Reveal in File Explorer" means for a file
  // (openPath on a file would launch its default application instead).
  h(IPC.revealPath, (_e, worktreeId: string, path: string) => {
    shell.showItemInFolder(worktreePath(worktreeId, path))
  })
  h(IPC.openLogFolder, async () => {
    // Reveal the rotating debug-log folder in Explorer so users can grab the file.
    // No containment check: the path is `logger.dir`, main's own, not the
    // renderer's — there is nothing here for a caller to influence.
    await shell.openPath(logger.dir)
  })
  h(IPC.openInTerminal, (_e, worktreeId: string, path: string) => {
    spawnExternalTerminal(worktreePath(worktreeId, path))
  })

  /* ---- Project-scoped hand-offs -------------------------------------------
   *
   * The rail's project header offers "Open in Explorer" and "Open in External
   * Terminal" too, and those cannot route through the pair above. Both of those
   * need a Worktree id, and a project does not always have one: the root row is
   * created by `reconcileProjectWorktrees`, which returns without touching the
   * stored rows when `git worktree list` fails — a directory that was never a
   * repo, or is no longer readable. That is a PERMANENT state, not a gap before
   * the first scan, and it is precisely the state in which a user reaches for
   * "open the folder and let me look at why".
   *
   * So these two take a project id and NOTHING else. The directory comes from
   * `project.repoPath`, which main stored when the user picked the folder — the
   * same provenance as `worktreeRepoPath`'s `w.path`, and equally not something
   * the renderer can influence. With no renderer-supplied path in the call
   * there is nothing to contain, which is why `resolveInRepo` is absent here
   * rather than skipped: it would be gating a string main wrote itself. The
   * alternative — letting the renderer pass the absolute path it can see in the
   * rail — is the exact shape this PR removed, and is not coming back.
   */
  const projectRepoPath = (projectId: string): string => {
    const p = repo.projects.get(projectId)
    if (!p) throw new Error(`project ${projectId} not found`)
    return p.repoPath
  }

  h(IPC.openProjectPath, async (_e, projectId: string) => {
    // Same resolve-with-a-message quirk as `IPC.openPath` above; rethrowing is
    // what puts "the folder is gone" in front of a user whose repo moved.
    const err = await shell.openPath(projectRepoPath(projectId))
    if (err) throw new Error(err)
  })
  h(IPC.openProjectInTerminal, (_e, projectId: string) => {
    spawnExternalTerminal(projectRepoPath(projectId))
  })

  ipcMain.on(IPC.windowMinimize, () => runtime.window?.minimize())
  ipcMain.on(IPC.windowMaximize, () => {
    const w = runtime.window
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on(IPC.windowClose, () => runtime.window?.close())
  ipcMain.on(IPC.toggleDevTools, () => runtime.window?.webContents.toggleDevTools())

  // ---- updates ----
  h(IPC.getVersion, () => app.getVersion())
  h(IPC.updateStatus, () => updater.status())
  h(IPC.updateCheck, () => updater.check())
  ipcMain.on(IPC.updateInstall, () => updater.install())
}

/* ---- CLI control channel dispatcher ------------------------------------ */

/**
 * Map a Claude Code hook event (+ its stdin payload) to a terminal status, or
 * null to ignore. This is the single source of the event→status policy — the
 * global settings.json just lists which events to forward.
 */
function hookEventToStatus(event: string, payload: Record<string, unknown>): TerminalStatus | null {
  switch (event) {
    case 'Notification': {
      // The load-bearing signal: Claude is blocked waiting on a human.
      const kind = String(payload.notification_type ?? '')
      if (BLOCKING_NOTIFICATIONS.has(kind)) return 'needs_attention'
      // A dialog answered somewhere other than this terminal (a URL elicitation
      // opened in the browser) produces no keystroke here, so without this the
      // worktree would sit on needs-attention until the next tool call.
      if (RESOLVED_NOTIFICATIONS.has(kind)) return 'working'
      // Everything else — auth_success, agent_completed, types added in future
      // Claude versions — says nothing about whether a human is needed.
      return null
    }
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
      return 'idle'
    case 'StopFailure':
      return 'error'
    case 'SessionStart':
      return 'idle'
    case 'SessionEnd':
      return 'done'
    default:
      return null
  }
}

/**
 * Normalize a CLI dev-server argument to a full URL: `3000` and `localhost:3000`
 * become `http://localhost:3000/`; explicit schemes pass through.
 */
function normalizeServerUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const candidate = /^\d+$/.test(s) ? `http://localhost:${s}` : /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

/** Parse a comma-separated tag list ("bug, ui") into trimmed, non-empty tags. */
function parseTagList(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Resolve a task by number (`12` / `#12`), full id, or unique id prefix within a project. */
function resolveTask(projectId: string, idArg: string): { task?: ReturnType<typeof repo.tasks.get>; error?: string } {
  const inProject = repo.tasks.list().filter((t) => t.projectId === projectId)
  if (/^#?\d+$/.test(idArg)) {
    const seq = Number.parseInt(idArg.replace('#', ''), 10)
    const task = inProject.find((t) => t.seq === seq)
    return task ? { task } : { error: `no task matches number '${idArg}'` }
  }
  const candidates = inProject.filter((t) => t.id === idArg || t.id.startsWith(idArg))
  if (candidates.length === 0) return { error: `no task matches id '${idArg}'` }
  if (candidates.length > 1) return { error: `id '${idArg}' is ambiguous (${candidates.length} matches)` }
  return { task: candidates[0] }
}

export async function handleControl(req: ControlRequest): Promise<ControlResponse> {
  // Record every incoming CLI command up front so a crash mid-dispatch still
  // leaves a trail of what the CLI was asking the app to do.
  logger.cli(req.cmd, { args: req.args, worktreeId: req.worktreeId, projectId: req.projectId })
  try {
    switch (req.cmd) {
      case 'status': {
        const status = normalizeStatus(String(req.args.status ?? ''))
        if (!status) return { ok: false, error: `unknown status '${req.args.status}'` }
        if (!req.terminalId) return { ok: false, error: 'no ORBITAL_TERMINAL_ID in environment' }
        const tab = repo.tabs.get(req.terminalId)
        if (!tab) return { ok: false, error: 'terminal not found' }
        if (acceptStatusEvent(req.terminalId, req.args.firedAt)) {
          // CLI-set needs-attention has no prompt kind — typing then resets to idle.
          attentionKind.delete(req.terminalId)
          repo.tabs.updateStatus(req.terminalId, status)
          repo.worktrees.recomputeStatus(tab.worktreeId)
          runtime.broadcastState()
          runtime.broadcastAlert()
        }
        return { ok: true, data: { status } }
      }
      case 'whoami': {
        // Self-inspection: an agent knows its ids from the env, but not what they
        // mean. One call answers "where am I, and what does the cockpit think I'm doing".
        if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
        const worktree = repo.worktrees.get(req.worktreeId)
        if (!worktree) return { ok: false, error: 'worktree not found' }
        const project = repo.projects.get(worktree.projectId)
        const tab = req.terminalId ? repo.tabs.get(req.terminalId) : undefined
        const task = worktree.taskId ? repo.tasks.get(worktree.taskId) : undefined
        return {
          ok: true,
          data: {
            project: project?.name ?? '',
            projectId: worktree.projectId,
            repoPath: project?.repoPath ?? '',
            worktree: worktree.name,
            worktreeId: worktree.id,
            kind: worktree.kind,
            branch: worktree.branch,
            path: worktree.path,
            status: tab?.status ?? worktree.status,
            terminalId: req.terminalId ?? '',
            task: task ? { seq: task.seq, title: task.title, status: task.status } : null,
            servers: runtime.devServersFor(worktree.id)
          }
        }
      }
      case 'worktrees': {
        const pid = req.projectId
        const list = repo.worktrees
          .list()
          .filter((w) => !pid || w.projectId === pid)
          .map((w) => ({
            id: w.id,
            name: w.name,
            branch: w.branch,
            status: w.status,
            kind: w.kind,
            path: w.path
          }))
        return { ok: true, data: list }
      }
      case 'worktree-new': {
        if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
        const project = repo.projects.get(req.projectId)
        if (!project) return { ok: false, error: 'project not found' }
        // A task number/id may come along, both to seed the branch name and to
        // link the task — same as the cockpit's "start a worktree from a task".
        let task: ReturnType<typeof repo.tasks.get> | undefined
        if (req.args.task !== undefined) {
          const resolved = resolveTask(req.projectId, String(req.args.task).trim())
          if (!resolved.task) return { ok: false, error: resolved.error }
          task = resolved.task
        }
        const existingBranch = req.args.existingBranch ? String(req.args.existingBranch) : undefined
        const branch = String(req.args.worktree ?? req.args.name ?? task?.title ?? `worktree-${Date.now()}`)
        const worktree = await createLinkedWorktree({
          project,
          branch,
          existingBranch,
          name: req.args.name ? String(req.args.name) : task?.title,
          baseRef: req.args.base ? String(req.args.base) : undefined,
          taskId: task?.id ?? null
        })
        // Link the task both ways and start it, matching the play-button flow.
        if (task) {
          repo.tasks.setWorktree(task.id, worktree.id)
          if (task.status !== 'in_progress' && task.status !== 'done') {
            repo.tasks.update(task.id, { status: 'in_progress' })
          }
        }
        runtime.gitWatcher.watch(worktree.path)
        runtime.ensureEnvWatcher(project.id)
        beginWorktreeSetup(worktree, project.repoPath)
        runtime.broadcastState()
        return {
          ok: true,
          data: {
            id: worktree.id,
            name: worktree.name,
            branch: worktree.branch,
            path: worktree.path,
            task: task ? { seq: task.seq, title: task.title } : null
          }
        }
      }
      case 'tab-new': {
        if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
        const type = String(req.args.type ?? 'terminal') as TabType
        if (!['terminal', 'browser', 'editor', 'agent'].includes(type)) {
          return { ok: false, error: `unknown tab type '${type}'` }
        }
        const arg = req.args.arg ? String(req.args.arg) : undefined
        // For agents the argument names a configured profile — its id, its name
        // (as typed in Settings, case-insensitively), or a provider id.
        if (type === 'agent' && arg) {
          const agents = getSettings().agents
          const agent =
            findAgentConfig(agents, arg) ?? agents.find((a) => a.name.toLowerCase() === arg.toLowerCase())
          if (!agent) {
            return { ok: false, error: `no agent '${arg}' is configured (try: ${agents.map((a) => a.name).join(', ')})` }
          }
          const tab = createTabInWorktree(req.worktreeId, null, type, { agentId: agent.id })
          runtime.broadcastState()
          return { ok: true, data: { id: tab.id, type: tab.type } }
        }
        const config: TabConfig =
          type === 'browser' ? { url: arg } : type === 'editor' ? { filePath: arg } : {}
        const tab = createTabInWorktree(req.worktreeId, null, type, config)
        runtime.broadcastState()
        return { ok: true, data: { id: tab.id, type: tab.type } }
      }
      case 'hook': {
        // Invoked by Claude Code hooks via `orbital hook <event>`. The CLI only
        // reaches here for Orbital-spawned sessions (it guards on ORBITAL_WORKTREE_ID).
        if (!req.terminalId) return { ok: true }
        const tab = repo.tabs.get(req.terminalId)
        if (!tab) return { ok: true }
        const event = String(req.args.event ?? '')
        const payload = (req.args.payload ?? {}) as Record<string, unknown>
        const status = hookEventToStatus(event, payload)
        if (!status) return { ok: true }
        // Async hooks race over the pipe — drop an event a later-fired one beat here.
        if (!acceptStatusEvent(req.terminalId, req.args.firedAt)) return { ok: true }
        if (status === 'needs_attention') {
          attentionKind.set(req.terminalId, String(payload.notification_type ?? ''))
        } else {
          attentionKind.delete(req.terminalId)
        }
        repo.tabs.updateStatus(req.terminalId, status)
        repo.worktrees.recomputeStatus(tab.worktreeId)
        runtime.broadcastState()
        runtime.broadcastAlert()
        return { ok: true, data: { status } }
      }
      case 'task-add': {
        if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
        const title = String(req.args.title ?? '').trim()
        if (!title) return { ok: false, error: 'task title required' }
        const task = repo.tasks.create({
          projectId: req.projectId,
          title,
          description: req.args.description ? String(req.args.description) : undefined,
          tags: req.args.tags ? parseTagList(String(req.args.tags)) : undefined
        })
        runtime.broadcastState()
        return { ok: true, data: { id: task.id, seq: task.seq, title: task.title } }
      }
      case 'task-list': {
        if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
        const all = req.args.all === true || req.args.all === 'true'
        // Explicit --status implies --all: asking for `done` and getting nothing
        // because the default hides done tasks would just be confusing.
        let wanted: TaskStatus | null = null
        if (req.args.status !== undefined) {
          wanted = normalizeTaskStatus(String(req.args.status))
          if (!wanted) return { ok: false, error: `unknown task status '${req.args.status}'` }
        }
        const tag = req.args.tag !== undefined ? String(req.args.tag).trim().toLowerCase() : null
        const list = repo.tasks
          .list()
          .filter((t) => t.projectId === req.projectId && (all || wanted !== null || t.status !== 'done'))
          .filter((t) => wanted === null || t.status === wanted)
          .filter((t) => !tag || t.tags.some((x) => x.toLowerCase() === tag))
          .map((t) => ({
            id: t.id,
            seq: t.seq,
            status: t.status,
            title: t.title,
            description: t.description,
            tags: t.tags,
            worktreeId: t.worktreeId
          }))
        return { ok: true, data: list }
      }
      case 'task-show': {
        if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
        const idArg = String(req.args.id ?? '').trim()
        if (!idArg) return { ok: false, error: 'task id required' }
        const { task, error } = resolveTask(req.projectId, idArg)
        if (!task) return { ok: false, error }
        return {
          ok: true,
          data: {
            id: task.id,
            seq: task.seq,
            status: task.status,
            title: task.title,
            description: task.description,
            tags: task.tags,
            worktreeId: task.worktreeId
          }
        }
      }
      case 'task-update': {
        if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
        const idArg = String(req.args.id ?? '').trim()
        if (!idArg) return { ok: false, error: 'task id required' }
        const { task, error } = resolveTask(req.projectId, idArg)
        if (!task) return { ok: false, error }
        const patch: TaskPatch = {}
        if (req.args.status !== undefined) {
          const status = normalizeTaskStatus(String(req.args.status))
          if (!status) return { ok: false, error: `unknown task status '${req.args.status}'` }
          patch.status = status
        }
        if (req.args.title !== undefined) patch.title = String(req.args.title)
        if (req.args.description !== undefined) patch.description = String(req.args.description)
        if (req.args.tags !== undefined) patch.tags = parseTagList(String(req.args.tags))
        if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' }
        const updated = repo.tasks.update(task.id, patch)
        runtime.broadcastState()
        return { ok: true, data: { id: updated.id, seq: updated.seq, status: updated.status, title: updated.title } }
      }
      case 'task-delete': {
        if (!req.projectId) return { ok: false, error: 'no ORBITAL_PROJECT_ID in environment' }
        const idArg = String(req.args.id ?? '').trim()
        if (!idArg) return { ok: false, error: 'task id required' }
        const { task, error } = resolveTask(req.projectId, idArg)
        if (!task) return { ok: false, error }
        repo.tasks.remove(task.id)
        runtime.broadcastState()
        return { ok: true, data: { id: task.id, seq: task.seq, title: task.title } }
      }
      case 'server-add': {
        if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
        const url = normalizeServerUrl(String(req.args.url ?? ''))
        if (!url) return { ok: false, error: `invalid server url '${req.args.url}'` }
        const servers = runtime.addDevServer(req.worktreeId, url)
        return { ok: true, data: { url, servers } }
      }
      case 'server-remove': {
        if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
        const url = normalizeServerUrl(String(req.args.url ?? ''))
        if (!url) return { ok: false, error: `invalid server url '${req.args.url}'` }
        const servers = runtime.removeDevServer(req.worktreeId, url)
        return { ok: true, data: { url, servers } }
      }
      case 'server-list': {
        if (!req.worktreeId) return { ok: false, error: 'no ORBITAL_WORKTREE_ID in environment' }
        return { ok: true, data: runtime.devServersFor(req.worktreeId) }
      }
      default:
        return { ok: false, error: `unknown command '${(req as ControlRequest).cmd}'` }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error(`cli ${req.cmd} failed`, { error })
    return { ok: false, error }
  }
}

/** On startup, resume watchers for already-registered projects and their worktrees. */
export function resumeProjects(): void {
  const checkouts = new Set<string>()
  for (const project of repo.projects.list()) {
    runtime.gitWatcher.watch(project.repoPath)
    runtime.ensureEnvWatcher(project.id)
    ensureWorktreesWatcher(project)
    checkouts.add(project.repoPath)
  }
  for (const w of repo.worktrees.list()) {
    if (w.kind === 'linked' && existsSync(w.path)) {
      runtime.gitWatcher.watch(w.path)
      checkouts.add(w.path)
    }
  }
  // Reconcile every project against `git worktree list` (adopt checkouts created
  // outside Orbital while it was closed, drop vanished ones), then resync
  // branches — they can move while the app is closed.
  void Promise.all(repo.projects.list().map((p) => reconcileProjectWorktrees(p.id)))
    .then(() => Promise.all([...checkouts].map((p) => runtime.refreshBranch(p))))
    .then(() => runtime.broadcastState())
}

/**
 * Terminals start fresh across restarts (PRD §5): scrollback does not persist,
 * so respawn a clean PTY for every terminal tab and reset its status to idle.
 */
export function resumeTerminals(): void {
  const keepBriefings = new Set<string>()
  for (const worktree of repo.worktrees.list()) {
    // Track every current agent tab so the prune below only drops orphans.
    for (const pane of worktree.panes) {
      for (const tab of pane.tabs) {
        if (tab.type === 'agent') keepBriefings.add(briefingKey(worktree.id, tab.id))
      }
    }
    // A worktree may have been removed externally while the app was closed;
    // node-pty throws synchronously on a missing cwd, so skip such Worktrees.
    if (!existsSync(worktree.path)) continue
    for (const pane of worktree.panes) {
      for (const tab of pane.tabs) {
        if (!isPtyTabType(tab.type)) continue
        repo.tabs.updateStatus(tab.id, 'idle')
        try {
          // spawnAgent owns its own error handling; spawnTerminal can throw synchronously.
          startPtyTab(worktree, tab)
        } catch (err) {
          console.error(`failed to respawn ${tab.type} ${tab.id}:`, err)
        }
      }
    }
    repo.worktrees.recomputeStatus(worktree.id)
  }
  // Drop briefing files left behind by tabs/worktrees removed while the app was closed.
  pruneBriefings(keepBriefings)
  prunePastedImages()
}
