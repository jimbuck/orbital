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
export type TaskStatus = 'draft' | 'todo' | 'in_progress' | 'ready_for_review' | 'done'

/**
 * A Worktree is bound to either a project's main checkout (`root`) or an
 * additional git worktree (`linked`).
 */
export type WorktreeKind = 'root' | 'linked'

/** App color theme. `system` follows the OS's prefers-color-scheme; the others are explicit. */
export type ThemeMode = 'system' | 'light' | 'dark'

/**
 * The kinds of tab a Worktree pane can host (PRD §6). `agent` is a PTY-backed tab
 * (like `terminal`) that boots straight into a coding agent — see TabConfig.agentProvider.
 */
export type TabType = 'terminal' | 'browser' | 'editor' | 'agent'

/** Agent providers Orbital can launch, in menu order. Keep in sync with AGENT_PROVIDERS (main). */
export const SUPPORTED_AGENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' }
]

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
 * A Worktree's pane layout: a binary tree. Leaves reference a pane (which owns the
 * tabs); split nodes tile their two children in `dir`, with `ratio` (0.1–0.9)
 * the fraction given to child `a`.
 */
export type LayoutNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; id: string; dir: SplitDirection; ratio: number; a: LayoutNode; b: LayoutNode }

/**
 * Worktree aggregate precedence (PRD §5): the Worktree surfaces its most
 * attention-worthy terminal. Earlier entries win.
 */
export const STATUS_PRECEDENCE: TerminalStatus[] = [
  'needs_attention',
  'error',
  'working',
  'idle',
  'done'
]

/** Roll a Worktree's terminal statuses up into a single aggregate status. */
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
  if (v === 'draft' || v === 'todo' || v === 'in_progress' || v === 'ready_for_review' || v === 'done') {
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

/**
 * A Project is a local git repo Orbital tracks (previously called a
 * "workspace"). It surfaces one `root` Worktree on the repo's main checkout plus
 * any additional `linked` Worktrees.
 */
export interface Project {
  id: string
  name: string
  repoPath: string
  /** Provider an `agent` tab launches by default in this project (default 'claude'). */
  defaultAgentProvider: string
  /** Optional explicit path to the agent executable, overriding PATH lookup. */
  agentExecPath?: string
  addedAt: number
}

/**
 * Default env-sync globs (a global setting shared by every project): env
 * files, agent config directories, and installed dependencies. Directory
 * patterns use `/**` since sync matching runs against relative file paths.
 * Env-file patterns are prefixed with `**` so nested files (e.g.
 * `apps/web/.env`) sync too; the directory patterns stay root-scoped —
 * agent config dirs live at the repo root, and `node_modules/**` must keep
 * its exact spelling for env-sync.ts's targetsNodeModules() check.
 * `node_modules/**` is copied once when a worktree is created but never
 * live-watched (see env-sync.ts).
 */
export const DEFAULT_ENV_SYNC_PATTERNS = [
  '**/.env',
  '**/.env.*',
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
  /** editor: path (relative to worktree working dir) of the open file. */
  filePath?: string
  /** editor: open `filePath` as a diff of its staged (index) version, not the worktree. */
  diffStaged?: boolean
  /** agent: which provider this tab launches (e.g. 'claude'); defaults to the project's. */
  agentProvider?: string
  /** display title override. */
  title?: string
}

export interface Tab {
  id: string
  worktreeId: string
  paneId: string
  type: TabType
  /** Terminal and agent tabs carry a status; browser/editor tabs are null. */
  status: TerminalStatus | null
  position: number
  config: TabConfig
}

export interface Pane {
  id: string
  worktreeId: string
  activeTabId: string | null
  tabs: Tab[]
}

export interface Worktree {
  id: string
  projectId: string
  kind: WorktreeKind
  name: string
  /** Working directory: the repo root for `root`, the linked worktree path otherwise. */
  path: string
  branch: string
  /** Cached aggregate of the Worktree's terminal statuses. */
  status: TerminalStatus
  /** Originating task, if started from one (PRD §8). */
  taskId: string | null
  /** Binary split-tree describing how `panes` are tiled in the Worktree body. */
  layout: LayoutNode
  createdAt: number
  panes: Pane[]
}

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  tags: string[]
  status: TaskStatus
  /** Linked Worktree once "start a Worktree from this task" has been used. */
  worktreeId: string | null
  createdAt: number
  updatedAt: number
}

/**
 * The renderer-facing settings shape. Behind this flat object the fields live in
 * two stores: {@link WORKSPACE_SETTING_KEYS workspace-scoped} fields persist in
 * the workspace's YAML config, everything else in the machine-global store —
 * the renderer never needs to know which is which.
 */
export interface Settings {
  defaultShell: string
  alerts: {
    indicator: boolean
    sound: boolean
    taskbarBadge: boolean
  }
  /** Whether Orbital's Claude status hooks are installed in ~/.claude/settings.json. */
  claudeHooksInstalled: boolean
  /** Wildcard list for env-file sync, applied to every project in the workspace (PRD §5). */
  envSyncPatterns: string[]
  /** Auto-run `git fetch` per project on an interval so ahead/behind stays current. */
  periodicFetch: boolean
  /** Opt-in verbose file logging of CLI calls, UI actions, and errors, with rotation. Off by default. */
  debugLogging: boolean
  /** Agent providers offered in the new-tab menus; hide the ones you don't use. */
  enabledAgents: string[]
  /** App color theme: 'system' follows the OS, else an explicit 'light'/'dark'. Defaults to 'dark'. */
  theme: ThemeMode
}

/** Settings that belong to a workspace (persisted in its YAML config file). */
export const WORKSPACE_SETTING_KEYS = ['envSyncPatterns', 'periodicFetch', 'enabledAgents'] as const

/** The workspace-scoped slice of {@link Settings}. */
export type WorkspaceSettings = Pick<Settings, (typeof WORKSPACE_SETTING_KEYS)[number]>

/** The machine-global slice of {@link Settings} (persisted in the global store). */
export type GlobalSettings = Omit<Settings, keyof WorkspaceSettings>

/** Full application state pushed to / pulled by the renderer. */
export interface AppState {
  projects: Project[]
  worktrees: Worktree[]
  tasks: Task[]
  settings: Settings
  /** The workspace this instance is running (id/name/config file location). */
  workspace: WorkspaceInfo
  /**
   * Live dev servers registered via `orbital server add`, keyed by worktreeId.
   * Runtime-only state (not persisted) — servers die with their terminals.
   */
  devServers: Record<string, string[]>
  /**
   * Worktree ids still setting up (background node_modules copy after
   * creation). Runtime-only; the rail shows a "setting up…" spinner while a
   * worktree is listed here.
   */
  settingUpWorktrees: string[]
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

/** Branch list for a project plus the branch HEAD currently points at. */
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

export interface CreateWorktreeOptions {
  /** Existing branch to check out, or a new branch name to create. */
  branch?: string
  /** Create a worktree (default) or attach to an existing path. */
  name?: string
  taskId?: string
  /** When true a worktree + branch is created; otherwise it is a plain dir Worktree. */
  worktree?: boolean
  /** base ref the new branch/worktree forks from (defaults to HEAD). */
  baseRef?: string
}

export interface RemoveWorktreeOptions {
  /** Also `git worktree remove` the backing worktree. */
  removeWorktree?: boolean
  force?: boolean
}

export interface TaskPatch {
  title?: string
  description?: string
  tags?: string[]
  status?: TaskStatus
  /** Reassign the task to another project (e.g. dragged across board swim-lanes). */
  projectId?: string
}

/** Per-project agent settings update. */
export interface ProjectAgentPatch {
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
  /** Worktrees currently needing attention. */
  count: number
  /** The Worktree that most recently flipped to needs-attention, if any. */
  worktreeId: string | null
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
  listWorkspaces: 'orbital:listWorkspaces',
  openWorkspace: 'orbital:openWorkspace',
  createWorkspace: 'orbital:createWorkspace',
  removeRecentWorkspace: 'orbital:removeRecentWorkspace',
  // projects
  addProject: 'orbital:addProject',
  removeProject: 'orbital:removeProject',
  renameProject: 'orbital:renameProject',
  // worktrees / panes / tabs
  createWorktree: 'orbital:createWorktree',
  removeWorktree: 'orbital:removeWorktree',
  renameWorktree: 'orbital:renameWorktree',
  clearWorktreeStatus: 'orbital:clearWorktreeStatus',
  listBranches: 'orbital:listBranches',
  setProjectAgent: 'orbital:setProjectAgent',
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
  pasteClipboardImage: 'orbital:pasteClipboardImage',
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
  registerBrowserView: 'orbital:registerBrowserView',
  openPath: 'orbital:openPath',
  openInTerminal: 'orbital:openInTerminal',
  openLogFolder: 'orbital:openLogFolder',
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
  /** Recently-opened workspaces from the global store (current one included). */
  listWorkspaces(): Promise<WorkspaceInfo[]>
  /**
   * Launch a separate instance for the workspace at `configPath`; with no path,
   * a native file picker chooses the YAML. Opening the current workspace just
   * refocuses this window. Null when the picker is cancelled.
   */
  openWorkspace(configPath?: string): Promise<WorkspaceInfo | null>
  /** Create a fresh workspace YAML via a native save dialog, then launch it. */
  createWorkspace(): Promise<WorkspaceInfo | null>
  /** Drop an entry from the recents registry (does not touch the file). */
  removeRecentWorkspace(configPath: string): Promise<WorkspaceInfo[]>

  // projects
  addProject(): Promise<Project | null>
  removeProject(projectId: string): Promise<void>
  renameProject(projectId: string, name: string): Promise<void>

  // worktrees / panes / tabs
  createWorktree(projectId: string, opts: CreateWorktreeOptions): Promise<Worktree>
  removeWorktree(worktreeId: string, opts: RemoveWorktreeOptions): Promise<void>
  renameWorktree(worktreeId: string, name: string): Promise<void>
  /** Force-reset a Worktree's terminals (and its aggregate) to idle when the status is out of sync. */
  clearWorktreeStatus(worktreeId: string): Promise<void>
  /** Branches of a project's repo + what HEAD points at (for the New Worktree base-ref picker). */
  listBranches(projectId: string): Promise<BranchInfo>
  /** Update a project's default agent provider / explicit executable path. */
  setProjectAgent(projectId: string, patch: ProjectAgentPatch): Promise<void>
  /** Whether Orbital's Claude status hooks are installed, and where. */
  claudeHooksStatus(): Promise<ClaudeHooksStatus>
  /** The exact JSON Orbital would merge into settings.json (for the confirm dialog). */
  claudeHooksPlan(): Promise<ClaudeHooksPlan>
  /** Merge Orbital's hook entries into ~/.claude/settings.json (idempotent). */
  installClaudeHooks(): Promise<ClaudeHooksStatus>
  /** Strip only Orbital's hook entries from ~/.claude/settings.json. */
  removeClaudeHooks(): Promise<ClaudeHooksStatus>
  createTab(worktreeId: string, paneId: string | null, type: TabType, config?: TabConfig): Promise<Tab>
  closeTab(tabId: string): Promise<void>
  /** Set a tab's explicit title override; an empty title reverts to the derived one. */
  renameTab(tabId: string, title: string): Promise<void>
  setActiveTab(paneId: string, tabId: string): Promise<void>
  moveTab(tabId: string, targetPaneId: string): Promise<void>
  /** Split `paneId` in `dir`, putting a new empty pane on the `where` side. */
  splitPane(worktreeId: string, paneId: string, dir: SplitDirection, where: SplitWhere): Promise<Pane>
  /** Close a pane (and its tabs); the layout collapses to its sibling. */
  closePane(worktreeId: string, paneId: string): Promise<void>
  /** Split a target pane toward an edge and move the dragged tab into the new pane. */
  moveTabToEdge(tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom'): Promise<void>
  /** Resize a split node (fraction for child a, clamped 0.1–0.9). */
  setSplitRatio(worktreeId: string, splitId: string, ratio: number): Promise<void>

  // terminals
  terminalInput(tabId: string, data: string): void
  terminalResize(tabId: string, cols: number, rows: number): void
  /** Current scrollback buffer + sequence cut-point, for replay when a tab remounts. */
  terminalBuffer(tabId: string): Promise<TerminalBuffer>
  /** Read the system clipboard (Electron clipboard module) — used for terminal paste. */
  readClipboard(): string
  /** Write text to the system clipboard — used for terminal/Edit-menu copy. */
  writeClipboard(text: string): void
  /** Save the clipboard image (if any) to a scratch PNG and return its absolute path — used for terminal image paste. */
  pasteClipboardImage(): Promise<string | null>

  // git
  gitStatus(worktreeId: string): Promise<GitStatus>
  gitStage(worktreeId: string, path: string): Promise<void>
  gitUnstage(worktreeId: string, path: string): Promise<void>
  gitStageAll(worktreeId: string): Promise<void>
  gitUnstageAll(worktreeId: string): Promise<void>
  /** Revert a file's unstaged changes (tracked: restore from index; untracked: delete). */
  gitDiscard(worktreeId: string, path: string): Promise<void>
  /** Revert ALL unstaged changes and delete untracked files; staged changes survive. */
  gitDiscardAll(worktreeId: string): Promise<void>
  gitCommit(worktreeId: string, message: string, amend?: boolean): Promise<void>
  /** HEAD's full commit message ('' on an empty repo) — for the amend prefill. */
  gitLastCommitMessage(worktreeId: string): Promise<string>
  gitPush(worktreeId: string): Promise<void>
  gitPull(worktreeId: string): Promise<void>
  gitFetch(worktreeId: string): Promise<void>
  /** Switch to `branch` (`create` forks it from HEAD first). Root Worktrees only. */
  gitCheckout(worktreeId: string, branch: string, create?: boolean): Promise<void>
  gitDiff(worktreeId: string, path: string, staged: boolean): Promise<FileDiff>
  fileTree(worktreeId: string): Promise<FileNode[]>
  readFile(worktreeId: string, path: string): Promise<string>
  /** Raw file bytes as base64 — for rendering binary content (images) in the editor. */
  readFileBase64(worktreeId: string, path: string): Promise<string>
  writeFile(worktreeId: string, path: string, content: string): Promise<void>

  // tasks
  createTask(projectId: string, title: string, description?: string, tags?: string[]): Promise<Task>
  updateTask(taskId: string, patch: TaskPatch): Promise<Task>
  deleteTask(taskId: string): Promise<void>

  // browser / window
  openExternal(url: string): Promise<void>
  /**
   * Register a browser tab's <webview> guest so main can route its popup /
   * new-window requests (Ctrl/Cmd-click, target=_blank, window.open) to a new
   * internal browser tab instead of a real OS popup window.
   */
  registerBrowserView(webContentsId: number, worktreeId: string, paneId: string): Promise<void>
  /** Reveal a folder in the OS file manager (Explorer on Windows). */
  openPath(path: string): Promise<void>
  /** Open an external terminal window at a folder (Windows Terminal / PowerShell on Windows). */
  openInTerminal(path: string): Promise<void>
  /** Reveal the debug-log folder in the OS file manager (for the Settings "Open log folder" action). */
  openLogFolder(): Promise<void>
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

/** Environment variables Orbital injects into every Worktree terminal (PRD §9). */
export const ENV = {
  terminalId: 'ORBITAL_TERMINAL_ID',
  worktreeId: 'ORBITAL_WORKTREE_ID',
  projectId: 'ORBITAL_PROJECT_ID',
  /** Named-pipe path the CLI connects to. */
  socket: 'ORBITAL_SOCKET'
} as const

export type ControlCommand =
  | 'status'
  | 'worktrees'
  | 'worktree-new'
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
  worktreeId?: string
  projectId?: string
  args: Record<string, unknown>
}

export interface ControlResponse {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * Pipe/socket path the CLI connects to. A per-workspace `key` disambiguates the
 * name so multiple instances (one per workspace) never collide on a single pipe;
 * the CLI receives the already-resolved path via `ORBITAL_SOCKET`, so it never
 * needs the key itself. An absent/empty key yields the legacy global name — used
 * for the single-workspace case and for a CLI invoked outside an Orbital
 * terminal, which has no instance to address.
 */
export function controlPipePath(key?: string): string {
  const safe = (key ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 16)
  const suffix = safe ? `-${safe}` : ''
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orbital-control${suffix}`
    : `${process.env.TMPDIR || '/tmp'}/orbital-control${suffix}.sock`
}

/* ============================================================================
 * Workspace configuration
 *
 * A "workspace" is a collection of projects defined by a YAML config file. The
 * file is the source of truth for which projects the workspace contains (and,
 * in a later phase, for workspace-scoped settings); the SQLite `projects` table
 * is a reconciled projection of it. Each workspace maps to its own profile
 * directory (its own DB + control pipe), so instances run side by side.
 * ========================================================================== */

/** Bump when the on-disk config shape changes in a non-additive way. */
export const WORKSPACE_CONFIG_VERSION = 1

/** One project entry in a workspace config file. */
export interface WorkspaceProjectConfig {
  /** Stable id — worktree and task rows in the DB reference it. */
  id: string
  name: string
  /** Absolute path to the git repo. */
  path: string
  /** Provider an `agent` tab launches by default (default 'claude'). */
  agentProvider?: string
  /** Optional explicit agent executable path, overriding PATH lookup. */
  agentExecPath?: string
}

/** The parsed contents of a workspace's YAML config file. */
export interface WorkspaceConfig {
  version: number
  /** Stable workspace id — also keys this instance's control pipe. */
  id: string
  /** Human-facing workspace name (shown in the picker / title bar). */
  name: string
  /**
   * Workspace-scoped settings. Absent in configs written before the settings
   * split (or hand-authored without one) — the settings service seeds/merges
   * defaults, so every field is optional here.
   */
  settings?: Partial<WorkspaceSettings>
  projects: WorkspaceProjectConfig[]
}

/** A workspace as listed in the picker (the global store's recents registry). */
export interface WorkspaceInfo {
  id: string
  name: string
  /** Absolute path to the workspace's YAML config file. */
  configPath: string
  lastOpenedAt: number
}
