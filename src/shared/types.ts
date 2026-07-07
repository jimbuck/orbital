/**
 * Orbital — shared contract.
 *
 * The single source of truth for domain types, IPC channel names, the CLI control
 * protocol, and the renderer-facing API surface (`window.orbital`). Main services,
 * the preload bridge, the `orbital` CLI, and the React renderer all build against
 * this file. Nothing here imports Node or Electron, so it is safe everywhere.
 */

/* ============================================================================
 * Domain enums
 * ========================================================================== */

/** Live agent-activity signal carried by a single terminal (PRD §4). */
export type TerminalStatus = 'idle' | 'working' | 'needs_attention' | 'error' | 'done'

/** Lightweight tracker state for a task (PRD §4, §8). Set by the user only. */
export type TaskStatus = 'todo' | 'in_progress' | 'ready_for_review' | 'done'

/** A Flight is bound to either the repo's root checkout or a git worktree. */
export type FlightKind = 'root' | 'worktree'

/**
 * The kinds of tab a Flight pane can host (PRD §6). `agent` is a PTY-backed tab
 * (like `terminal`) that boots straight into a coding agent — see TabConfig.agentProvider.
 */
export type TabType = 'terminal' | 'browser' | 'editor' | 'agent'

/** Tab types that are backed by a live PTY and carry a TerminalStatus. */
export function isPtyTabType(type: TabType): boolean {
  return type === 'terminal' || type === 'agent'
}

/** Direction a split tiles its two children: row = side-by-side, column = stacked. */
export type SplitDirection = 'row' | 'column'

/** Which side of a new split the freshly created pane goes on. */
export type SplitWhere = 'before' | 'after'

/** Where on a pane a dragged tab is dropped (an edge splits, center moves). */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * A Flight's pane layout: a binary tree. Leaves reference a pane (which owns the
 * tabs); split nodes tile their two children in `dir`, with `ratio` (0.1–0.9)
 * the fraction given to child `a`.
 */
export type LayoutNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; id: string; dir: SplitDirection; ratio: number; a: LayoutNode; b: LayoutNode }

/**
 * Flight aggregate precedence (PRD §5): the Flight surfaces its most
 * attention-worthy terminal. Earlier entries win.
 */
export const STATUS_PRECEDENCE: TerminalStatus[] = [
  'needs_attention',
  'error',
  'working',
  'idle',
  'done'
]

/** Roll a Flight's terminal statuses up into a single aggregate status. */
export function aggregateStatus(statuses: TerminalStatus[]): TerminalStatus {
  if (statuses.length === 0) return 'idle'
  for (const s of STATUS_PRECEDENCE) {
    if (statuses.includes(s)) return s
  }
  return 'idle'
}

/** Map a CLI-style task-status token (`in-progress`) to the canonical enum. */
export function normalizeTaskStatus(token: string): TaskStatus | null {
  const v = token.trim().toLowerCase().replace(/-/g, '_')
  if (v === 'todo' || v === 'in_progress' || v === 'ready_for_review' || v === 'done') {
    return v
  }
  return null
}

/** Map a CLI-style status token (`needs-attention`) to the canonical enum. */
export function normalizeStatus(token: string): TerminalStatus | null {
  const v = token.trim().toLowerCase().replace(/-/g, '_')
  if (v === 'idle' || v === 'working' || v === 'needs_attention' || v === 'error' || v === 'done') {
    return v
  }
  return null
}

/* ============================================================================
 * Domain entities (hydrated shapes returned across IPC)
 * ========================================================================== */

export interface Workspace {
  id: string
  name: string
  repoPath: string
  /** Provider an `agent` tab launches by default in this workspace (default 'claude'). */
  defaultAgentProvider: string
  /** Optional explicit path to the agent executable, overriding PATH lookup. */
  agentExecPath?: string
  addedAt: number
}

/**
 * Default env-sync globs (a global setting shared by every workspace): env
 * files, agent config directories, and installed dependencies. Directory
 * patterns use `/**` since sync matching runs against relative file paths.
 * `node_modules/**` is copied once when a worktree is created but never
 * live-watched (see env-sync.ts).
 */
export const DEFAULT_ENV_SYNC_PATTERNS = [
  '.env',
  '.env.*',
  '.claude/**',
  '.codex/**',
  '.cursor/**',
  '.gemini/**',
  '.cline/**',
  '.roo/**',
  'node_modules/**'
]

export interface TabConfig {
  /** terminal: working directory the PTY was spawned in. */
  cwd?: string
  /** browser: current URL. */
  url?: string
  /** editor: path (relative to flight working dir) of the open file. */
  filePath?: string
  /** editor: open `filePath` as a diff of its staged (index) version, not the worktree. */
  diffStaged?: boolean
  /** agent: which provider this tab launches (e.g. 'claude'); defaults to the workspace's. */
  agentProvider?: string
  /** display title override. */
  title?: string
}

export interface Tab {
  id: string
  flightId: string
  paneId: string
  type: TabType
  /** Terminal and agent tabs carry a status; browser/editor tabs are null. */
  status: TerminalStatus | null
  position: number
  config: TabConfig
}

export interface Pane {
  id: string
  flightId: string
  activeTabId: string | null
  tabs: Tab[]
}

export interface Flight {
  id: string
  workspaceId: string
  kind: FlightKind
  name: string
  /** Working directory: repo root for `root`, the worktree path otherwise. */
  worktreePath: string
  branch: string
  /** Cached aggregate of the Flight's terminal statuses. */
  status: TerminalStatus
  /** Originating task, if started from one (PRD §8). */
  taskId: string | null
  /** Binary split-tree describing how `panes` are tiled in the Flight body. */
  layout: LayoutNode
  createdAt: number
  panes: Pane[]
}

export interface Task {
  id: string
  workspaceId: string
  title: string
  description: string
  tags: string[]
  status: TaskStatus
  /** Linked Flight once "start a Flight from this task" has been used. */
  flightId: string | null
  createdAt: number
  updatedAt: number
}

export interface Settings {
  defaultShell: string
  alerts: {
    indicator: boolean
    sound: boolean
    taskbarBadge: boolean
  }
  /** Whether Orbital's Claude status hooks are installed in ~/.claude/settings.json. */
  claudeHooksInstalled: boolean
  /** Global wildcard list for env-file sync, applied to every workspace (PRD §5). */
  envSyncPatterns: string[]
}

/** Full application state pushed to / pulled by the renderer. */
export interface AppState {
  workspaces: Workspace[]
  flights: Flight[]
  tasks: Task[]
  settings: Settings
  /**
   * Live dev servers registered via `orbital server add`, keyed by flightId.
   * Runtime-only state (not persisted) — servers die with their terminals.
   */
  devServers: Record<string, string[]>
}

/* ============================================================================
 * Git
 * ========================================================================== */

export type GitFileState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'copied'

export interface GitFileStatus {
  path: string
  state: GitFileState
  staged: boolean
}

export interface GitStatus {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  clean: boolean
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
}

/** Branch list for a workspace plus the branch HEAD currently points at. */
export interface BranchInfo {
  branches: string[]
  /** What "HEAD" resolves to right now (the checked-out branch). */
  head: string
}

export type DiffLineType = 'add' | 'del' | 'context' | 'hunk' | 'meta'

export interface DiffLine {
  type: DiffLineType
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface FileDiff {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
  /** binary or otherwise non-text. */
  binary: boolean
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  /** git status badge for files, when changed. */
  gitState?: GitFileState
  children?: FileNode[]
}

/* ============================================================================
 * Options used by API calls
 * ========================================================================== */

export interface CreateFlightOptions {
  /** Existing branch to check out, or a new branch name to create. */
  branch?: string
  /** Create a worktree (default) or attach to an existing path. */
  name?: string
  taskId?: string
  /** When true a worktree + branch is created; otherwise it is a plain dir Flight. */
  worktree?: boolean
  /** base ref the new branch/worktree forks from (defaults to HEAD). */
  baseRef?: string
}

export interface RemoveFlightOptions {
  /** Also `git worktree remove` the backing worktree. */
  removeWorktree?: boolean
  force?: boolean
}

export interface TaskPatch {
  title?: string
  description?: string
  tags?: string[]
  status?: TaskStatus
  /** Reassign the task to another workspace (e.g. dragged across board swim-lanes). */
  workspaceId?: string
}

/** Per-workspace agent settings update. */
export interface WorkspaceAgentPatch {
  defaultAgentProvider?: string
  agentExecPath?: string
}

/** State of Orbital's opt-in Claude status hooks. */
export interface ClaudeHooksStatus {
  installed: boolean
  /** Absolute path of the settings.json the hooks live in. */
  settingsPath: string
}

/** Preview of exactly what Orbital will merge into settings.json, for confirmation. */
export interface ClaudeHooksPlan {
  settingsPath: string
  /** Pretty-printed JSON of just Orbital's hook additions. */
  json: string
}

/* ============================================================================
 * Events pushed from main -> renderer
 * ========================================================================== */

export interface TerminalDataEvent {
  tabId: string
  data: string
  /** Cumulative bytes emitted by this terminal up to and including this chunk. */
  seq: number
}

/** Scrollback snapshot plus the sequence cut-point it represents (PRD §5 replay). */
export interface TerminalBuffer {
  data: string
  /** Cumulative bytes the snapshot covers; live chunks with seq <= this are dupes. */
  seq: number
}

export interface TerminalExitEvent {
  tabId: string
  exitCode: number
}

export interface AlertEvent {
  /** Flights currently needing attention. */
  count: number
  /** The Flight that most recently flipped to needs-attention, if any. */
  flightId: string | null
  /** True when this transition should chime / re-badge. */
  rising: boolean
}

/* ============================================================================
 * Auto-update (electron-updater over GitHub releases)
 * ========================================================================== */

/**
 * Where the updater currently is. `disabled` = unpackaged dev build (there is
 * nothing to update against); `ready` = downloaded, restart installs it.
 */
export type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** Version of the update being downloaded / ready to install. */
  version?: string
  /** Download progress 0–100 while `downloading`. */
  percent?: number
  error?: string
}

/* ============================================================================
 * IPC channels (renderer <-> main)
 * ========================================================================== */

export const IPC = {
  // state
  getState: 'orbital:getState',
  setSettings: 'orbital:setSettings',
  // workspaces
  addWorkspace: 'orbital:addWorkspace',
  removeWorkspace: 'orbital:removeWorkspace',
  renameWorkspace: 'orbital:renameWorkspace',
  // flights / panes / tabs
  createFlight: 'orbital:createFlight',
  removeFlight: 'orbital:removeFlight',
  renameFlight: 'orbital:renameFlight',
  clearFlightStatus: 'orbital:clearFlightStatus',
  listBranches: 'orbital:listBranches',
  setWorkspaceAgent: 'orbital:setWorkspaceAgent',
  claudeHooksStatus: 'orbital:claudeHooksStatus',
  claudeHooksPlan: 'orbital:claudeHooksPlan',
  installClaudeHooks: 'orbital:installClaudeHooks',
  removeClaudeHooks: 'orbital:removeClaudeHooks',
  createTab: 'orbital:createTab',
  closeTab: 'orbital:closeTab',
  renameTab: 'orbital:renameTab',
  setActiveTab: 'orbital:setActiveTab',
  moveTab: 'orbital:moveTab',
  splitPane: 'orbital:splitPane',
  closePane: 'orbital:closePane',
  moveTabToEdge: 'orbital:moveTabToEdge',
  setSplitRatio: 'orbital:setSplitRatio',
  // terminals (renderer -> main, fire-and-forget)
  terminalInput: 'orbital:terminalInput',
  terminalResize: 'orbital:terminalResize',
  terminalBuffer: 'orbital:terminalBuffer',
  // git
  gitStatus: 'orbital:gitStatus',
  gitStage: 'orbital:gitStage',
  gitUnstage: 'orbital:gitUnstage',
  gitStageAll: 'orbital:gitStageAll',
  gitUnstageAll: 'orbital:gitUnstageAll',
  gitDiscard: 'orbital:gitDiscard',
  gitDiscardAll: 'orbital:gitDiscardAll',
  gitCommit: 'orbital:gitCommit',
  gitLastCommitMessage: 'orbital:gitLastCommitMessage',
  gitPush: 'orbital:gitPush',
  gitPull: 'orbital:gitPull',
  gitFetch: 'orbital:gitFetch',
  gitCheckout: 'orbital:gitCheckout',
  gitDiff: 'orbital:gitDiff',
  fileTree: 'orbital:fileTree',
  readFile: 'orbital:readFile',
  readFileBase64: 'orbital:readFileBase64',
  writeFile: 'orbital:writeFile',
  // tasks
  createTask: 'orbital:createTask',
  updateTask: 'orbital:updateTask',
  deleteTask: 'orbital:deleteTask',
  // browser
  openExternal: 'orbital:openExternal',
  // window
  windowMinimize: 'orbital:windowMinimize',
  windowMaximize: 'orbital:windowMaximize',
  windowClose: 'orbital:windowClose',
  toggleDevTools: 'orbital:toggleDevTools',
  // updates
  getVersion: 'orbital:getVersion',
  updateStatus: 'orbital:updateStatus',
  updateCheck: 'orbital:updateCheck',
  updateInstall: 'orbital:updateInstall',
  // events (main -> renderer)
  evtStateChanged: 'orbital:evt:stateChanged',
  evtTerminalData: 'orbital:evt:terminalData',
  evtTerminalExit: 'orbital:evt:terminalExit',
  evtAlert: 'orbital:evt:alert',
  evtUpdate: 'orbital:evt:update'
} as const

/* ============================================================================
 * Renderer-facing API (exposed on window.orbital by the preload bridge)
 * ========================================================================== */

export interface OrbitalApi {
  // state
  getState(): Promise<AppState>
  setSettings(settings: Settings): Promise<Settings>

  // workspaces
  addWorkspace(): Promise<Workspace | null>
  removeWorkspace(workspaceId: string): Promise<void>
  renameWorkspace(workspaceId: string, name: string): Promise<void>

  // flights / panes / tabs
  createFlight(workspaceId: string, opts: CreateFlightOptions): Promise<Flight>
  removeFlight(flightId: string, opts: RemoveFlightOptions): Promise<void>
  renameFlight(flightId: string, name: string): Promise<void>
  /** Force-reset a Flight's terminals (and its aggregate) to idle when the status is out of sync. */
  clearFlightStatus(flightId: string): Promise<void>
  /** Branches of a workspace's repo + what HEAD points at (for the New Flight base-ref picker). */
  listBranches(workspaceId: string): Promise<BranchInfo>
  /** Update a workspace's default agent provider / explicit executable path. */
  setWorkspaceAgent(workspaceId: string, patch: WorkspaceAgentPatch): Promise<void>
  /** Whether Orbital's Claude status hooks are installed, and where. */
  claudeHooksStatus(): Promise<ClaudeHooksStatus>
  /** The exact JSON Orbital would merge into settings.json (for the confirm dialog). */
  claudeHooksPlan(): Promise<ClaudeHooksPlan>
  /** Merge Orbital's hook entries into ~/.claude/settings.json (idempotent). */
  installClaudeHooks(): Promise<ClaudeHooksStatus>
  /** Strip only Orbital's hook entries from ~/.claude/settings.json. */
  removeClaudeHooks(): Promise<ClaudeHooksStatus>
  createTab(flightId: string, paneId: string | null, type: TabType, config?: TabConfig): Promise<Tab>
  closeTab(tabId: string): Promise<void>
  /** Set a tab's explicit title override; an empty title reverts to the derived one. */
  renameTab(tabId: string, title: string): Promise<void>
  setActiveTab(paneId: string, tabId: string): Promise<void>
  moveTab(tabId: string, targetPaneId: string): Promise<void>
  /** Split `paneId` in `dir`, putting a new empty pane on the `where` side. */
  splitPane(flightId: string, paneId: string, dir: SplitDirection, where: SplitWhere): Promise<Pane>
  /** Close a pane (and its tabs); the layout collapses to its sibling. */
  closePane(flightId: string, paneId: string): Promise<void>
  /** Split a target pane toward an edge and move the dragged tab into the new pane. */
  moveTabToEdge(tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom'): Promise<void>
  /** Resize a split node (fraction for child a, clamped 0.1–0.9). */
  setSplitRatio(flightId: string, splitId: string, ratio: number): Promise<void>

  // terminals
  terminalInput(tabId: string, data: string): void
  terminalResize(tabId: string, cols: number, rows: number): void
  /** Current scrollback buffer + sequence cut-point, for replay when a tab remounts. */
  terminalBuffer(tabId: string): Promise<TerminalBuffer>
  /** Read the system clipboard (Electron clipboard module) — used for terminal paste. */
  readClipboard(): string

  // git
  gitStatus(flightId: string): Promise<GitStatus>
  gitStage(flightId: string, path: string): Promise<void>
  gitUnstage(flightId: string, path: string): Promise<void>
  gitStageAll(flightId: string): Promise<void>
  gitUnstageAll(flightId: string): Promise<void>
  /** Revert a file's unstaged changes (tracked: restore from index; untracked: delete). */
  gitDiscard(flightId: string, path: string): Promise<void>
  /** Revert ALL unstaged changes and delete untracked files; staged changes survive. */
  gitDiscardAll(flightId: string): Promise<void>
  gitCommit(flightId: string, message: string, amend?: boolean): Promise<void>
  /** HEAD's full commit message ('' on an empty repo) — for the amend prefill. */
  gitLastCommitMessage(flightId: string): Promise<string>
  gitPush(flightId: string): Promise<void>
  gitPull(flightId: string): Promise<void>
  gitFetch(flightId: string): Promise<void>
  /** Switch to `branch` (`create` forks it from HEAD first). Root Flights only. */
  gitCheckout(flightId: string, branch: string, create?: boolean): Promise<void>
  gitDiff(flightId: string, path: string, staged: boolean): Promise<FileDiff>
  fileTree(flightId: string): Promise<FileNode[]>
  readFile(flightId: string, path: string): Promise<string>
  /** Raw file bytes as base64 — for rendering binary content (images) in the editor. */
  readFileBase64(flightId: string, path: string): Promise<string>
  writeFile(flightId: string, path: string, content: string): Promise<void>

  // tasks
  createTask(workspaceId: string, title: string, description?: string, tags?: string[]): Promise<Task>
  updateTask(taskId: string, patch: TaskPatch): Promise<Task>
  deleteTask(taskId: string): Promise<void>

  // browser / window
  openExternal(url: string): Promise<void>
  windowMinimize(): void
  windowMaximize(): void
  windowClose(): void
  toggleDevTools(): void

  // updates
  /** The running app's version (package.json version of the packaged build). */
  getVersion(): Promise<string>
  /** Current updater status (seed for the store; live changes arrive via onUpdateStatus). */
  updateStatus(): Promise<UpdateStatus>
  /** Trigger a check now; progress/result arrive via onUpdateStatus events. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Quit and install the downloaded update (no-op unless phase is `ready`). */
  installUpdate(): void

  // events — each returns an unsubscribe function
  onStateChanged(cb: (state: AppState) => void): () => void
  onTerminalData(cb: (evt: TerminalDataEvent) => void): () => void
  onTerminalExit(cb: (evt: TerminalExitEvent) => void): () => void
  onAlert(cb: (evt: AlertEvent) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}

/* ============================================================================
 * CLI control protocol (orbital CLI <-> main, over a local named pipe)
 * ========================================================================== */

/** Environment variables Orbital injects into every Flight terminal (PRD §9). */
export const ENV = {
  terminalId: 'ORBITAL_TERMINAL_ID',
  flightId: 'ORBITAL_FLIGHT_ID',
  workspaceId: 'ORBITAL_WORKSPACE_ID',
  /** Named-pipe path the CLI connects to. */
  socket: 'ORBITAL_SOCKET'
} as const

export type ControlCommand =
  | 'status'
  | 'flights'
  | 'flight-new'
  | 'tab-new'
  | 'task-add'
  | 'task-list'
  | 'task-show'
  | 'task-update'
  | 'task-delete'
  | 'server-add'
  | 'server-remove'
  | 'server-list'
  | 'hook'

export interface ControlRequest {
  cmd: ControlCommand
  /** Identity injected into the terminal env, echoed back by the CLI. */
  terminalId?: string
  flightId?: string
  workspaceId?: string
  args: Record<string, unknown>
}

export interface ControlResponse {
  ok: boolean
  data?: unknown
  error?: string
}

/** Stable pipe name so the CLI can find the running app without discovery. */
export function controlPipePath(): string {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\orbital-control'
    : `${process.env.TMPDIR || '/tmp'}/orbital-control.sock`
}
