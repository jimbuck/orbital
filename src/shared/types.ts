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

/** The three kinds of tab a Flight pane can host (PRD §6). */
export type TabType = 'terminal' | 'browser' | 'editor'

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
  /** User-editable wildcard list for env-file sync (PRD §5). */
  envSyncPatterns: string[]
  addedAt: number
}

export interface TabConfig {
  /** terminal: working directory the PTY was spawned in. */
  cwd?: string
  /** browser: current URL. */
  url?: string
  /** editor: path (relative to flight working dir) of the open file. */
  filePath?: string
  /** display title override. */
  title?: string
}

export interface Tab {
  id: string
  flightId: string
  paneId: string
  type: TabType
  /** Terminals carry a status; browser/editor tabs are null. */
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
}

/** Full application state pushed to / pulled by the renderer. */
export interface AppState {
  workspaces: Workspace[]
  flights: Flight[]
  tasks: Task[]
  settings: Settings
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
  status?: TaskStatus
  /** Reassign the task to another workspace (e.g. dragged across board swim-lanes). */
  workspaceId?: string
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
 * IPC channels (renderer <-> main)
 * ========================================================================== */

export const IPC = {
  // state
  getState: 'orbital:getState',
  getSettings: 'orbital:getSettings',
  setSettings: 'orbital:setSettings',
  // workspaces
  addWorkspace: 'orbital:addWorkspace',
  removeWorkspace: 'orbital:removeWorkspace',
  updateEnvPatterns: 'orbital:updateEnvPatterns',
  // flights / panes / tabs
  createFlight: 'orbital:createFlight',
  removeFlight: 'orbital:removeFlight',
  renameFlight: 'orbital:renameFlight',
  listBranches: 'orbital:listBranches',
  createTab: 'orbital:createTab',
  closeTab: 'orbital:closeTab',
  setActiveTab: 'orbital:setActiveTab',
  moveTab: 'orbital:moveTab',
  splitPane: 'orbital:splitPane',
  closePane: 'orbital:closePane',
  moveTabToEdge: 'orbital:moveTabToEdge',
  setSplitRatio: 'orbital:setSplitRatio',
  setTerminalStatus: 'orbital:setTerminalStatus',
  // terminals (renderer -> main, fire-and-forget)
  terminalInput: 'orbital:terminalInput',
  terminalResize: 'orbital:terminalResize',
  terminalBuffer: 'orbital:terminalBuffer',
  // git
  gitStatus: 'orbital:gitStatus',
  gitStage: 'orbital:gitStage',
  gitUnstage: 'orbital:gitUnstage',
  gitCommit: 'orbital:gitCommit',
  gitPush: 'orbital:gitPush',
  gitPull: 'orbital:gitPull',
  gitFetch: 'orbital:gitFetch',
  gitDiff: 'orbital:gitDiff',
  fileTree: 'orbital:fileTree',
  readFile: 'orbital:readFile',
  writeFile: 'orbital:writeFile',
  // tasks
  createTask: 'orbital:createTask',
  updateTask: 'orbital:updateTask',
  deleteTask: 'orbital:deleteTask',
  startFlightFromTask: 'orbital:startFlightFromTask',
  // browser
  openExternal: 'orbital:openExternal',
  // window
  windowMinimize: 'orbital:windowMinimize',
  windowMaximize: 'orbital:windowMaximize',
  windowClose: 'orbital:windowClose',
  toggleDevTools: 'orbital:toggleDevTools',
  // events (main -> renderer)
  evtStateChanged: 'orbital:evt:stateChanged',
  evtTerminalData: 'orbital:evt:terminalData',
  evtTerminalExit: 'orbital:evt:terminalExit',
  evtAlert: 'orbital:evt:alert'
} as const

/* ============================================================================
 * Renderer-facing API (exposed on window.orbital by the preload bridge)
 * ========================================================================== */

export interface OrbitalApi {
  // state
  getState(): Promise<AppState>
  getSettings(): Promise<Settings>
  setSettings(settings: Settings): Promise<Settings>

  // workspaces
  addWorkspace(): Promise<Workspace | null>
  removeWorkspace(workspaceId: string): Promise<void>
  updateEnvPatterns(workspaceId: string, patterns: string[]): Promise<void>

  // flights / panes / tabs
  createFlight(workspaceId: string, opts: CreateFlightOptions): Promise<Flight>
  removeFlight(flightId: string, opts: RemoveFlightOptions): Promise<void>
  renameFlight(flightId: string, name: string): Promise<void>
  /** Branches of a workspace's repo + what HEAD points at (for the New Flight base-ref picker). */
  listBranches(workspaceId: string): Promise<BranchInfo>
  createTab(flightId: string, paneId: string | null, type: TabType, config?: TabConfig): Promise<Tab>
  closeTab(tabId: string): Promise<void>
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
  setTerminalStatus(tabId: string, status: TerminalStatus): Promise<void>

  // terminals
  terminalInput(tabId: string, data: string): void
  terminalResize(tabId: string, cols: number, rows: number): void
  /** Current scrollback buffer + sequence cut-point, for replay when a tab remounts. */
  terminalBuffer(tabId: string): Promise<TerminalBuffer>

  // git
  gitStatus(flightId: string): Promise<GitStatus>
  gitStage(flightId: string, path: string): Promise<void>
  gitUnstage(flightId: string, path: string): Promise<void>
  gitCommit(flightId: string, message: string): Promise<void>
  gitPush(flightId: string): Promise<void>
  gitPull(flightId: string): Promise<void>
  gitFetch(flightId: string): Promise<void>
  gitDiff(flightId: string, path: string, staged: boolean): Promise<FileDiff>
  fileTree(flightId: string): Promise<FileNode[]>
  readFile(flightId: string, path: string): Promise<string>
  writeFile(flightId: string, path: string, content: string): Promise<void>

  // tasks
  createTask(workspaceId: string, title: string, description?: string): Promise<Task>
  updateTask(taskId: string, patch: TaskPatch): Promise<Task>
  deleteTask(taskId: string): Promise<void>
  startFlightFromTask(taskId: string): Promise<Flight>

  // browser / window
  openExternal(url: string): Promise<void>
  windowMinimize(): void
  windowMaximize(): void
  windowClose(): void
  toggleDevTools(): void

  // events — each returns an unsubscribe function
  onStateChanged(cb: (state: AppState) => void): () => void
  onTerminalData(cb: (evt: TerminalDataEvent) => void): () => void
  onTerminalExit(cb: (evt: TerminalExitEvent) => void): () => void
  onAlert(cb: (evt: AlertEvent) => void): () => void
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
