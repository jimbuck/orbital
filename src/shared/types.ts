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
 * (like `terminal`) that boots straight into a coding agent — see TabConfig.agentId.
 */
export type TabType = 'terminal' | 'browser' | 'editor' | 'agent'

/**
 * Agent providers Orbital can launch, in menu order. Keep in sync with
 * AGENT_PROVIDERS (main). `configDirEnvVar` is the env var the CLI reads its
 * profile/config directory from; `defaultConfigDir` is where that profile
 * lives when the var is unset (shown as a placeholder in Settings).
 */
export const SUPPORTED_AGENTS: ReadonlyArray<{
  id: string
  label: string
  configDirEnvVar: string
  defaultConfigDir: string
}> = [
  { id: 'claude', label: 'Claude', configDirEnvVar: 'CLAUDE_CONFIG_DIR', defaultConfigDir: '~/.claude' },
  { id: 'codex', label: 'Codex', configDirEnvVar: 'CODEX_HOME', defaultConfigDir: '~/.codex' },
  { id: 'cursor', label: 'Cursor', configDirEnvVar: 'CURSOR_CONFIG_DIR', defaultConfigDir: '~/.cursor' }
]

/**
 * One named agent profile in a workspace. Being listed in Settings.agents is
 * what makes the profile available in the new-tab menus; the optional fields
 * tailor how its CLI is launched — e.g. a personal workspace can point Claude
 * at a personal profile directory while a work workspace uses the work one.
 *
 * A workspace may hold SEVERAL profiles of the same provider ("Claude
 * (personal)" and "Claude (work)"), which is why entries are keyed by their own
 * `id` rather than by provider. That id is what tabs and project defaults
 * reference, and what the hook/skill/instruction installers act on — those
 * write into THIS profile's directory, so two profiles need two installs.
 */
export interface AgentConfig {
  /** Stable key for this profile (e.g. 'claude', 'claude-2'); referenced by tabs and projects. */
  id: string
  /** User-facing label shown in the menus, tab titles, and Settings. */
  name: string
  /** Provider that launches it (an id from SUPPORTED_AGENTS, e.g. 'claude'). */
  provider: string
  /** Profile/config directory, exported via the provider's configDirEnvVar at launch. */
  configDir?: string
  /** Explicit executable path, overriding PATH lookup (a project-level path still wins). */
  execPath?: string
  /** Extra CLI arguments appended to the launch command. */
  args?: string[]
  /** Extra environment variables set in the agent's terminal. */
  env?: Record<string, string>
}

/**
 * One untweaked profile per supported provider — the default agent lineup.
 * Their ids deliberately EQUAL the provider ids, so references stored before
 * profiles were named (a tab's `agentProvider`, a project's default) keep
 * resolving to the same agent.
 */
export function defaultAgentConfigs(): AgentConfig[] {
  return SUPPORTED_AGENTS.map((a) => ({ id: a.id, name: a.label, provider: a.id }))
}

/** Whether an id names a provider Orbital can actually launch. */
function isSupportedProvider(id: string): boolean {
  return SUPPORTED_AGENTS.some((a) => a.id === id)
}

/** Display label for a provider id, falling back to the id itself. */
export function providerLabel(providerId: string): string {
  return SUPPORTED_AGENTS.find((a) => a.id === providerId)?.label ?? providerId
}

/**
 * The profile a stored reference points at: its `id` first, else the first
 * profile of a provider by that name. The second pass is what keeps references
 * written before profiles had ids (tabs carrying `agentProvider: 'claude'`, a
 * project defaulting to `'codex'`) pointing at the right agent.
 */
export function findAgentConfig(agents: AgentConfig[], ref: string | undefined): AgentConfig | undefined {
  if (!ref) return undefined
  return agents.find((a) => a.id === ref) ?? agents.find((a) => a.provider === ref)
}

/**
 * The first of several references that still resolves — a tab's own profile,
 * then its legacy provider id, then the project's default. A reference to a
 * profile that has since been deleted must not stop the fallback: without this
 * the tab would launch the hard-coded default provider with none of the
 * workspace's configuration behind it.
 */
export function resolveAgentRef(agents: AgentConfig[], ...refs: (string | undefined)[]): AgentConfig | undefined {
  for (const ref of refs) {
    const hit = findAgentConfig(agents, ref)
    if (hit) return hit
  }
  return undefined
}

/**
 * Mint an id for a profile that has none (or whose id collides): the provider
 * id, then `-2`, `-3`, … so the FIRST profile of a provider keeps the bare
 * provider id and stays reachable by legacy references.
 */
export function nextAgentId(provider: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(provider)) return provider
  for (let n = 2; ; n++) {
    const candidate = `${provider}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** The same, for the user-facing name: "Claude", then "Claude 2", "Claude 3", … */
export function nextAgentName(provider: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = providerLabel(provider)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * Coerce a raw (hand-edited YAML or legacy DB) value into a clean
 * AgentConfig[]: entries need a provider Orbital supports, ids are minted when
 * missing or duplicated, names default to the provider label, and
 * unknown-typed fields are dropped. Falls back to converting a legacy
 * `enabledAgents` id array; returns undefined when neither value is usable
 * (caller applies the default lineup).
 *
 * Unknown provider ids are dropped rather than passed through: the menus would
 * offer them, but main resolves an unrecognized id to the Claude provider, so
 * picking one would silently launch the wrong agent. An explicit empty list
 * still means "no agents", but a non-empty list that scrubs down to nothing is
 * treated as unusable so a bad hand-edit doesn't leave empty menus.
 */
export function normalizeAgentConfigs(agents: unknown, legacyEnabled?: unknown): AgentConfig[] | undefined {
  if (Array.isArray(agents)) {
    const taken = new Set<string>()
    const takenNames = new Set<string>()
    const out: AgentConfig[] = []
    for (const item of agents) {
      const a = (item ?? {}) as Record<string, unknown>
      const provider = typeof a.provider === 'string' ? a.provider.trim() : ''
      if (!provider || !isSupportedProvider(provider)) continue
      const rawId = typeof a.id === 'string' ? a.id.trim() : ''
      // A duplicate id would make two profiles indistinguishable to every
      // reference; mint a fresh one rather than dropping the profile. An id that
      // spells a DIFFERENT provider is re-minted too: findAgentConfig matches ids
      // before providers, so a Claude profile called `codex` would swallow every
      // legacy reference meant for the real Codex profile.
      const usable = rawId && !taken.has(rawId) && !(isSupportedProvider(rawId) && rawId !== provider)
      const id = usable ? rawId : nextAgentId(provider, taken)
      taken.add(id)
      // A minted name is numbered off the ones already used ("Claude", "Claude
      // 2"): two unnamed profiles of a provider would otherwise be
      // indistinguishable in the menus and to `orbital tab new agent <name>`.
      // A name the user typed is left as they typed it, duplicate or not.
      const name =
        typeof a.name === 'string' && a.name.trim() ? a.name.trim() : nextAgentName(provider, takenNames)
      takenNames.add(name)
      const entry: AgentConfig = { id, name, provider }
      if (typeof a.configDir === 'string' && a.configDir.trim()) entry.configDir = a.configDir.trim()
      if (typeof a.execPath === 'string' && a.execPath.trim()) entry.execPath = a.execPath.trim()
      if (Array.isArray(a.args) && a.args.length > 0 && a.args.every((x) => typeof x === 'string')) {
        entry.args = a.args
      }
      if (a.env && typeof a.env === 'object' && !Array.isArray(a.env)) {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(a.env)) {
          if (k && typeof v === 'string') env[k] = v
        }
        if (Object.keys(env).length > 0) entry.env = env
      }
      out.push(entry)
    }
    // Everything scrubbed out of a non-empty list means the stored value was
    // junk, not a deliberate "no agents" — let the caller apply the default.
    return out.length > 0 || agents.length === 0 ? out : undefined
  }
  if (Array.isArray(legacyEnabled) && legacyEnabled.every((x) => typeof x === 'string')) {
    const ids = [...new Set(legacyEnabled)].filter(isSupportedProvider)
    return ids.length > 0 || legacyEnabled.length === 0
      ? ids.map((provider) => ({ id: provider, name: providerLabel(provider), provider }))
      : undefined
  }
  return undefined
}

/**
 * Split a user-typed argument string into argv entries, honoring single/double
 * quotes for arguments containing spaces (no escapes — this is a settings
 * field, not a shell).
 */
export function parseArgsString(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3])
  }
  return out
}

/**
 * Inverse of {@link parseArgsString} for display: quote args containing spaces,
 * picking the quote style the argument itself doesn't use so it reads back the
 * same. An argument needing quotes that contains *both* styles can't be
 * represented — the format has no escapes — and won't round-trip.
 */
export function formatArgsString(args: string[]): string {
  return args
    .map((a) => {
      if (a !== '' && !/\s/.test(a)) return a
      return a.includes('"') ? `'${a}'` : `"${a}"`
    })
    .join(' ')
}

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
  /** Agent profile an `agent` tab launches by default in this project (default 'claude'). */
  defaultAgentId: string
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
  /** agent: which configured profile this tab launches; defaults to the project's. */
  agentId?: string
  /**
   * agent, LEGACY: the provider id tabs stored before profiles were named.
   * Written by no current code — read only so old tabs still resolve (see
   * {@link findAgentConfig}).
   */
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
  /** Human-facing task number: globally unique, assigned in creation order, never reused. */
  seq: number
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
    /** Flash the taskbar button (FlashWindow) when a Worktree flips to needs-attention. */
    taskbarFlash: boolean
  }
  /** Wildcard list for env-file sync, applied to every project in the workspace (PRD §5). */
  envSyncPatterns: string[]
  /** Auto-run `git fetch` per project on an interval so ahead/behind stays current. */
  periodicFetch: boolean
  /** Opt-in verbose file logging of CLI calls, UI actions, and errors, with rotation. Off by default. */
  debugLogging: boolean
  /** Configured agent profiles: what the new-tab menus offer, plus each one's launch tweaks. */
  agents: AgentConfig[]
  /** App color theme: 'system' follows the OS, else an explicit 'light'/'dark'. Defaults to 'dark'. */
  theme: ThemeMode
}

/** Settings that belong to a workspace (persisted in its YAML config file). */
export const WORKSPACE_SETTING_KEYS = ['envSyncPatterns', 'periodicFetch', 'agents'] as const

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
  /** Remote-tracking branches (e.g. `origin/pr-42`) with no matching local branch. */
  remotes: string[]
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
  /** Matched by .gitignore — rendered dimmed. Ignored dirs come without
   *  `children`; their contents are fetched lazily via `listDir` on expand. */
  ignored?: boolean
  children?: FileNode[]
}

/* ============================================================================
 * Options used by API calls
 * ========================================================================== */

export interface CreateWorktreeOptions {
  /** Existing branch to check out, or a new branch name to create. */
  branch?: string
  /** Check out this existing branch (local, or `origin/x` remote) instead of creating one. */
  existingBranch?: string
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
  defaultAgentId?: string
  agentExecPath?: string
}

/** Where a typed profile-directory value actually points, and whether it is there. */
export interface ProfileDirInfo {
  /** The expanded absolute path the agent (and its installs) will use. */
  path: string
  /** False when no directory is there yet — the agent would start a fresh profile. */
  exists: boolean
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

/**
 * State of the opt-in `orbital` Agent Skill — a personal skill teaching Claude
 * the `orbital` CLI, so sessions Orbital did NOT boot as agent tabs (a hand-run
 * `claude` in a terminal tab) still know the cockpit is there.
 */
export interface ClaudeSkillStatus {
  installed: boolean
  /** Absolute path of the SKILL.md Orbital manages. */
  skillPath: string
  /** True when the file exists but was not written by Orbital (we never overwrite it). */
  foreign: boolean
}

/** Preview of exactly what Orbital will write, for confirmation. */
export interface ClaudeSkillPlan {
  skillPath: string
  /** The full SKILL.md Orbital would write. */
  markdown: string
}

/**
 * State of the opt-in Codex instructions — a managed block in the Codex
 * profile's AGENTS.md, which is Codex's only always-loaded instructions file
 * (it takes no per-launch briefing).
 */
export interface CodexInstructionsStatus {
  installed: boolean
  /** Absolute path of the AGENTS.md holding Orbital's block. */
  path: string
}

/** Preview of the block Orbital would merge into that AGENTS.md. */
export interface CodexInstructionsPlan {
  path: string
  markdown: string
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
  renameWorkspace: 'orbital:renameWorkspace',
  removeWorkspace: 'orbital:removeWorkspace',
  exportWorkspace: 'orbital:exportWorkspace',
  importWorkspace: 'orbital:importWorkspace',
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
  inspectProfileDir: 'orbital:inspectProfileDir',
  claudeHooksStatus: 'orbital:claudeHooksStatus',
  claudeHooksPlan: 'orbital:claudeHooksPlan',
  installClaudeHooks: 'orbital:installClaudeHooks',
  removeClaudeHooks: 'orbital:removeClaudeHooks',
  claudeSkillStatus: 'orbital:claudeSkillStatus',
  claudeSkillPlan: 'orbital:claudeSkillPlan',
  installClaudeSkill: 'orbital:installClaudeSkill',
  removeClaudeSkill: 'orbital:removeClaudeSkill',
  codexInstructionsStatus: 'orbital:codexInstructionsStatus',
  codexInstructionsPlan: 'orbital:codexInstructionsPlan',
  installCodexInstructions: 'orbital:installCodexInstructions',
  removeCodexInstructions: 'orbital:removeCodexInstructions',
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
  terminalAlive: 'orbital:terminalAlive',
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
  listDir: 'orbital:listDir',
  readFile: 'orbital:readFile',
  readFileBase64: 'orbital:readFileBase64',
  writeFile: 'orbital:writeFile',
  createFile: 'orbital:createFile',
  createDirectory: 'orbital:createDirectory',
  renamePath: 'orbital:renamePath',
  trashPath: 'orbital:trashPath',
  resolvePath: 'orbital:resolvePath',
  // tasks
  createTask: 'orbital:createTask',
  updateTask: 'orbital:updateTask',
  deleteTask: 'orbital:deleteTask',
  // browser
  openExternal: 'orbital:openExternal',
  registerBrowserView: 'orbital:registerBrowserView',
  openPath: 'orbital:openPath',
  revealPath: 'orbital:revealPath',
  openInTerminal: 'orbital:openInTerminal',
  openProjectPath: 'orbital:openProjectPath',
  openProjectInTerminal: 'orbital:openProjectInTerminal',
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
  /** Every workspace in the global DB, most recently opened first. */
  listWorkspaces(): Promise<WorkspaceInfo[]>
  /**
   * Launch a separate instance for the workspace with `workspaceId` (opening
   * the current one just refocuses this window).
   */
  openWorkspace(workspaceId: string): Promise<WorkspaceInfo | null>
  /** Create a new empty workspace named `name`, then launch it. */
  createWorkspace(name: string): Promise<WorkspaceInfo | null>
  renameWorkspace(workspaceId: string, name: string): Promise<void>
  /**
   * Delete a workspace and everything in it (projects/worktrees/tasks rows —
   * nothing on disk). The current workspace can't delete itself.
   */
  removeWorkspace(workspaceId: string): Promise<WorkspaceInfo[]>
  /** Write a workspace (projects + settings) to a shareable YAML via save dialog. */
  exportWorkspace(workspaceId: string): Promise<string | null>
  /** Create a new workspace from a shared YAML via open dialog. */
  importWorkspace(): Promise<WorkspaceInfo | null>

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
  /** Update a project's default agent profile / explicit executable path. */
  setProjectAgent(projectId: string, patch: ProjectAgentPatch): Promise<void>
  /**
   * What a typed profile directory resolves to (`~`/`%VAR%` expanded) and
   * whether it is there yet — so Settings can show the real path before a
   * launch quietly starts a fresh profile somewhere else. A blank `configDir`
   * answers with the provider's machine default.
   */
  inspectProfileDir(provider: string, configDir: string): Promise<ProfileDirInfo>
  /* Hooks / skill / instructions are installed INTO an agent profile's own
     directory, so every call names the profile (an AgentConfig id) it acts on. */
  /** Whether Orbital's Claude status hooks are installed for this profile, and where. */
  claudeHooksStatus(agentId: string): Promise<ClaudeHooksStatus>
  /** The exact JSON Orbital would merge into settings.json (for the confirm dialog). */
  claudeHooksPlan(agentId: string): Promise<ClaudeHooksPlan>
  /** Merge Orbital's hook entries into the profile's settings.json (idempotent). */
  installClaudeHooks(agentId: string): Promise<ClaudeHooksStatus>
  /** Strip only Orbital's hook entries from the profile's settings.json. */
  removeClaudeHooks(agentId: string): Promise<ClaudeHooksStatus>
  /** Whether Orbital's `orbital` skill is installed for this Claude profile. */
  claudeSkillStatus(agentId: string): Promise<ClaudeSkillStatus>
  /** The exact SKILL.md Orbital would write (for the confirm dialog). */
  claudeSkillPlan(agentId: string): Promise<ClaudeSkillPlan>
  /** Write the `orbital` skill into the Claude profile's skills directory. */
  installClaudeSkill(agentId: string): Promise<ClaudeSkillStatus>
  /** Delete the skill Orbital wrote (never one it does not own). */
  removeClaudeSkill(agentId: string): Promise<ClaudeSkillStatus>
  /** Whether Orbital's block is in this Codex profile's AGENTS.md. */
  codexInstructionsStatus(agentId: string): Promise<CodexInstructionsStatus>
  /** The exact block Orbital would merge in (for the confirm dialog). */
  codexInstructionsPlan(agentId: string): Promise<CodexInstructionsPlan>
  /** Merge Orbital's block into the Codex profile's AGENTS.md (idempotent). */
  installCodexInstructions(agentId: string): Promise<CodexInstructionsStatus>
  /** Strip only Orbital's block from that AGENTS.md. */
  removeCodexInstructions(agentId: string): Promise<CodexInstructionsStatus>
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
  /** Whether the tab still has a live PTY process — drives the close-tab confirm. */
  terminalAlive(tabId: string): Promise<boolean>
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
  /*
   * `path` on every file call below is CHECKOUT-RELATIVE, and main refuses any
   * spelling that leaves the Worktree: `../…` traversal, and an absolute path —
   * which is not an escape hatch but an error. It was never honoured (main
   * joins it onto the checkout root, producing `C:\repo\C:\…`, which no
   * filesystem will open) and is now refused with a message that says so.
   *
   * Be precise about how far that reaches. For the reads — `listDir`,
   * `readFile`, `readFileBase64` — the check is LEXICAL: it reasons about the
   * string, so a symlink or junction committed INSIDE the checkout is followed
   * like any other entry, and the bytes finally read can live outside. That is
   * deliberate; `node_modules` is full of such links. `writeFile` additionally
   * resolves the path's ancestors on disk and refuses to write THROUGH a link
   * that leaves the checkout, as do the four mutating calls below it. The
   * argument for the split is in `main/services/git.ts`, beside the functions.
   */
  /** Immediate children of an ignored directory (not enumerated in fileTree). */
  listDir(worktreeId: string, path: string): Promise<FileNode[]>
  readFile(worktreeId: string, path: string): Promise<string>
  /** Raw file bytes as base64 — for rendering binary content (images) in the editor. */
  readFileBase64(worktreeId: string, path: string): Promise<string>
  writeFile(worktreeId: string, path: string, content: string): Promise<void>
  /**
   * Create an empty file `name` inside the checkout-relative directory
   * `parentDir` (`''` = repo root); resolves to the new file's relative path.
   * Rejects when the name isn't a single path segment or the file exists.
   */
  createFile(worktreeId: string, parentDir: string, name: string): Promise<string>
  /** As `createFile`, for a directory. */
  createDirectory(worktreeId: string, parentDir: string, name: string): Promise<string>
  /** Rename a file/directory in place; resolves to its new relative path. */
  renamePath(worktreeId: string, path: string, newName: string): Promise<string>
  /** Send a file/directory to the OS recycle bin (recoverable, unlike unlink). */
  trashPath(worktreeId: string, path: string): Promise<void>
  /**
   * Absolute path of a checkout-relative path, for "Copy Path". Rejects any
   * path that LEXICALLY leaves the Worktree (`../…`, absolute); it does not
   * realpath, so the string handed back can still point through a link
   * committed in the checkout to a target outside it.
   */
  resolvePath(worktreeId: string, path: string): Promise<string>

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
  /**
   * Hand an entry in a Worktree to the OS: open it with its registered
   * application (a folder opens in the file manager).
   *
   * Takes the same checkout-relative `path` as the rest of the file API, NOT an
   * absolute one, and main resolves it against the Worktree — an absolute path
   * from here would be a request for main to launch any file on the machine.
   * `''` means the Worktree root, which is what the rail's "Open in Explorer"
   * asks for.
   *
   * Rejects any `path` that LEXICALLY leaves the Worktree (`../…`, absolute).
   * It does NOT realpath, so this is not a promise that what opens lives inside
   * the checkout: a symlink or junction committed in the repo is followed by
   * the OS like any other entry, and `link/app.exe` — or `link` itself — can
   * resolve anywhere. Deliberate, and argued in the OS hand-off block in
   * `main/ipc.ts`.
   */
  openPath(worktreeId: string, path: string): Promise<void>
  /**
   * Show a file/folder SELECTED in its containing folder (`showItemInFolder`).
   * Distinct from `openPath`, which opens the item itself — for a file that
   * would launch its default application instead of revealing it. Same
   * `(worktreeId, path)` contract, resolved in main behind the same lexical
   * containment check, with the same link caveat as `openPath`.
   */
  revealPath(worktreeId: string, path: string): Promise<void>
  /**
   * Open an external terminal window at a folder in a Worktree (Windows
   * Terminal / PowerShell on Windows). Same `(worktreeId, path)` contract,
   * resolved in main behind the same lexical containment check, with the same
   * link caveat as `openPath` — the path is the new shell's working directory.
   */
  openInTerminal(worktreeId: string, path: string): Promise<void>
  /**
   * Open a PROJECT's repo directory in the OS file manager.
   *
   * The rail's project header offers this, and it cannot go through
   * `openPath(worktreeId, '')`: a project only has a root Worktree row once
   * `reconcileProjectWorktrees` has listed its checkouts, and that returns
   * empty-handed for a path that is not a git repo — permanently, not just
   * until the first scan. "Open the folder and see why" is exactly what the
   * user wants in that state, so the action has to be reachable without a
   * Worktree.
   *
   * There is no `path` parameter, and that is the point: the only thing the
   * renderer names is a project id, and main derives the directory from its own
   * stored `repoPath`. Nothing renderer-supplied reaches the OS, so there is no
   * path to contain — as opposed to re-admitting an absolute path over the
   * bridge, which is the hole the `(worktreeId, path)` shape closed.
   */
  openProjectPath(projectId: string): Promise<void>
  /**
   * Open an external terminal window at a PROJECT's repo directory. Same
   * project-id-only contract, and the same reason for existing, as
   * `openProjectPath`.
   */
  openProjectInTerminal(projectId: string): Promise<void>
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
  | 'whoami'
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
  /** Agent profile an `agent` tab launches by default (default 'claude'). */
  agentId?: string
  /** Optional explicit agent executable path, overriding PATH lookup. */
  agentExecPath?: string
}

/**
 * The Export/Import Workspace file format (YAML). Workspaces themselves live in
 * the global DB; this shape exists purely for sharing a workspace between
 * machines or people.
 */
export interface WorkspaceConfig {
  version: number
  /** The exporting workspace's id (import assigns a fresh one on collision). */
  id: string
  /** Human-facing workspace name (shown in the picker / title bar). */
  name: string
  /** Workspace-scoped settings. Every field optional — defaults fill gaps. */
  settings?: Partial<WorkspaceSettings>
  projects: WorkspaceProjectConfig[]
}

/** A workspace as listed in the picker (a row of the global `workspaces` table). */
export interface WorkspaceInfo {
  id: string
  name: string
  lastOpenedAt: number
  /** How many projects the workspace holds (picker display). */
  projectCount: number
}
