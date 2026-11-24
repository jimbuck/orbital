/**
 * Orbital — shared types.
 *
 * The single source of truth for domain types and the CLI control protocol.
 * Main services, the preload bridge, the `orbital` CLI, and the React renderer
 * all build against this file. The renderer-facing API surface
 * (`window.orbital`) and its IPC channels live next door in `contract.ts`.
 * Nothing here imports Electron, so it is safe everywhere.
 */

import type { ThemeId } from './themes'

/* ============================================================================
 * Domain enums
 * ========================================================================== */

/** Live agent-activity signal carried by a single terminal (PRD §4). */
export type TerminalStatus = 'idle' | 'working' | 'needs_attention' | 'error' | 'done'

/** Lightweight tracker state for a task (PRD §4, §8). Set by the user only. */
export type TaskStatus = 'draft' | 'todo' | 'in_progress' | 'ready_for_review' | 'done'

/**
 * A Worktree is bound to a repo's main checkout (`root`), an additional git
 * worktree (`linked`), or, for a project with no home repo, the project's
 * root folder (`folder`): a session with terminals and agents but no git.
 */
export type WorktreeKind = 'root' | 'linked' | 'folder'

/**
 * The persisted theme setting: a theme id from the registry, or `system` to
 * follow the OS's prefers-color-scheme (which resolves to the built-in Orbital
 * Dark / Orbital Light). The two original values, 'light' and 'dark', are the
 * built-ins' ids, so installs predating the registry need no migration.
 */
export type ThemeMode = 'system' | ThemeId

/**
 * Where a tab opened from OUTSIDE the pane area lands — the command palette, a
 * git-panel diff, a dev-server link. `active` is the pane the user last worked
 * in; the four directions name the pane on that side of it, and are created by
 * splitting the active pane when nothing is there yet (see
 * `renderer/lib/paneTarget.ts`).
 */
export type OpenAction = 'active' | 'right' | 'left' | 'top' | 'bottom'

/** The Default Open Action choices, in the order Settings offers them. */
export const OPEN_ACTIONS: ReadonlyArray<{ value: OpenAction; label: string }> = [
  { value: 'active', label: 'Active Pane' },
  { value: 'right', label: 'Right Pane' },
  { value: 'left', label: 'Left Pane' },
  { value: 'bottom', label: 'Bottom Pane' },
  { value: 'top', label: 'Top Pane' }
]

/** Display label for an open action, falling back to the raw value. */
export function openActionLabel(action: OpenAction): string {
  return OPEN_ACTIONS.find((a) => a.value === action)?.label ?? action
}

/** Coerce a stored (or hand-edited) value to a known OpenAction, else null. */
export function normalizeOpenAction(value: unknown): OpenAction | null {
  return OPEN_ACTIONS.some((a) => a.value === value) ? (value as OpenAction) : null
}

/**
 * The kinds of tab a Worktree pane can host (PRD §6). `agent` is a PTY-backed tab
 * (like `terminal`) that boots straight into a coding agent — see TabConfig.agentId.
 */
export type TabType = 'terminal' | 'browser' | 'editor' | 'agent' | 'search'

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
 * `id` rather than by provider. That id is what tabs and repo defaults
 * reference, and what the hook/skill/instruction installers act on — those
 * write into THIS profile's directory, so two profiles need two installs.
 */
export interface AgentConfig {
  /** Stable key for this profile (e.g. 'claude', 'claude-2'); referenced by tabs and repos. */
  id: string
  /** User-facing label shown in the menus, tab titles, and Settings. */
  name: string
  /** Provider that launches it (an id from SUPPORTED_AGENTS, e.g. 'claude'). */
  provider: string
  /** Profile/config directory, exported via the provider's configDirEnvVar at launch. */
  configDir?: string
  /** Explicit executable path, overriding PATH lookup (a repo-level path still wins). */
  execPath?: string
  /** Extra CLI arguments appended to the launch command. */
  args?: string[]
  /** Extra environment variables set in the agent's terminal. */
  env?: Record<string, string>
}

/**
 * One untweaked profile per supported provider — the default agent lineup.
 * Their ids deliberately EQUAL the provider ids, so references stored before
 * profiles were named (a tab's `agentProvider`, a repo's default) keep
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
 * repo defaulting to `'codex'`) pointing at the right agent.
 */
export function findAgentConfig(agents: AgentConfig[], ref: string | undefined): AgentConfig | undefined {
  if (!ref) return undefined
  return agents.find((a) => a.id === ref) ?? agents.find((a) => a.provider === ref)
}

/**
 * The first of several references that still resolves — a tab's own profile,
 * then its legacy provider id, then the repo's default. A reference to a
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
 * A Repo is a local git repo Orbital tracks (first called a "workspace", then a
 * "project"). It surfaces one `root` Worktree on the repo's main checkout plus
 * any additional `linked` Worktrees.
 */
export interface Repo {
  id: string
  name: string
  repoPath: string
  /** Agent profile an `agent` tab launches by default in this repo (default 'claude'). */
  defaultAgentId: string
  /** Optional explicit path to the agent executable, overriding PATH lookup. */
  agentExecPath?: string
  addedAt: number
  /** The {@link Project} this repo belongs to. Every repo is in exactly one. */
  projectId: string
}

/**
 * A Project is a root folder plus the repos that belong together under it:
 * one or more member repos and, optionally, a home repo among them. Every repo
 * is in exactly one project; a repo added on its own gets a project of its own
 * (named after it, rooted at its path), which the rail draws as a plain repo
 * row. The rail arranges projects, not repos.
 */
export interface Project {
  id: string
  name: string
  /** The folder the project lives in. For a one-repo project, that repo's path. */
  rootPath: string
  /** The member repo that is the project's home, or null. Always one of `repoIds`. */
  homeRepoId: string | null
  /** Whether Orbital may write its managed block into the home repo's agent files. */
  managedBlock: boolean
  /**
   * Whether Orbital keeps a VS Code / Cursor multi-root `<name>.code-workspace`
   * listing the project's repos (in the home repo, else the root folder). Off by default.
   */
  codeWorkspace: boolean
  /** The member repos in hand order, the home included. */
  repoIds: string[]
  createdAt: number
}

/**
 * A folder in the rail: a named, collapsible group of rows.
 *
 * A folder lives in one of two places. With `projectId` null it is a folder of
 * projects, somewhere in the rail's own list. With `projectId` set it is a
 * folder of that project's repos, drawn under the project's header. Either
 * kind nests: a folder holds folders of its own kind beside its rows.
 *
 * It arranges the Projects panel and does nothing else. A project's repos,
 * root, worktree locations, agent defaults and settings are the same in a
 * folder as out of one, which is why membership lives here and not as a field
 * on {@link Project} or {@link Repo}; folders are also left out of the
 * workspace export.
 */
export interface RailFolder {
  id: string
  name: string
  /** Whether its rows are hidden. Persisted, so the rail comes back as it was left. */
  collapsed: boolean
  /** The project whose repos it arranges, or null for a folder of projects. */
  projectId: string | null
  /** The folder it sits in, or null at the top of its list (the rail's, or its project's). */
  parentId: string | null
  /**
   * What is filed here, in the order the rail lists it: folders of the same
   * kind, and projects (`projectId` null) or the project's repos. A row is in
   * at most one folder.
   */
  items: RailItem[]
}

/**
 * One row of a list the rail orders by hand: a folder, a project (in the
 * rail's own lists) or a repo (in a project's). Folders share the order with
 * the rows beside them, so one can sit anywhere among them.
 */
export interface RailItem {
  kind: 'folder' | 'project' | 'repo'
  id: string
}

/**
 * Where a new rail folder goes. Without one it is a folder of projects, last
 * in the rail.
 *
 * - `holding`: it takes that row's place and holds it. A project makes a
 *   folder of projects; a repo makes a folder among its project's repos.
 * - `parentId`: last inside that folder, as a folder of the same kind.
 * - `projectId`: last among that project's repos.
 */
export type RailFolderSpot = { holding: RailItem } | { parentId: string } | { projectId: string }

/**
 * Default env-sync globs (a global setting shared by every repo): env
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
  /** agent: which configured profile this tab launches; defaults to the repo's. */
  agentId?: string
  /**
   * agent, LEGACY: the provider id tabs stored before profiles were named.
   * Written by no current code — read only so old tabs still resolve (see
   * {@link findAgentConfig}).
   */
  agentProvider?: string
  /**
   * agent: the provider's id for the conversation this tab is running, so a
   * respawn (app restart, workspace reopen) resumes it instead of starting a
   * blank session. Minted by Orbital at launch and refreshed from the agent's
   * hook events, so a `/clear` mid-session is tracked too. Only providers that
   * can resume by id set it (Claude today).
   */
  agentSessionId?: string
  /**
   * agent: a prompt to start the session with (`orbital tab new agent --prompt`).
   * Used on the tab's first launch only and cleared once that launch is under
   * way, so a respawn resumes the conversation rather than sending it again.
   */
  agentPrompt?: string
  /**
   * search: what this Search tab is searching for. Persisted so a tab restored
   * after a restart comes back on the query you left it on.
   */
  search?: SearchQuery
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
  /** The repo this checks out. Null for a `folder` session, which belongs to a project and no repo. */
  repoId: string | null
  /**
   * The project it is in: a folder session's own project, else its repo's
   * (so it follows the repo when the repo moves).
   */
  projectId: string
  kind: WorktreeKind
  name: string
  /** Working directory: the repo root for `root`, the project root for `folder`, the linked worktree path otherwise. */
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

/**
 * Who filed a task: a person in the cockpit UI, or an agent through the
 * `orbital` CLI's control channel.
 */
export type TaskCreator = 'user' | 'agent'

export interface Task {
  id: string
  /** Human-facing task number: globally unique, assigned in creation order, never reused. */
  seq: number
  /** The {@link Project} that owns it. Every task is in exactly one. */
  projectId: string
  /**
   * The repo it is filed under, one of its project's repos, or null for work
   * that spans the project. A tag, not an owner: removing the repo clears it,
   * and while the task has a live worktree it follows that worktree's repo.
   */
  repoId: string | null
  title: string
  description: string
  tags: string[]
  status: TaskStatus
  /** Linked Worktree once "start a Worktree from this task" has been used. */
  worktreeId: string | null
  /** Who filed it; null for tasks that predate provenance tracking. */
  createdBy: TaskCreator | null
  /** Unix ms. */
  createdAt: number
  /** Unix ms; bumped by every field edit, status change, worktree link and (un)archive. */
  updatedAt: number
  /** Unix ms when archived; null while active. Archived tasks are hidden from the default views. */
  archivedAt: number | null
}

/**
 * The renderer-facing settings shape. Every field belongs to the workspace and
 * persists on its row. Defaults and validation live in `settings.ts`.
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
  /** Wildcard list for env-file sync, applied to every repo in the workspace (PRD §5). */
  envSyncPatterns: string[]
  /** Auto-run `git fetch` per repo on an interval so ahead/behind stays current. */
  periodicFetch: boolean
  /** Opt-in verbose file logging of CLI calls, UI actions, and errors, with rotation. Off by default. */
  debugLogging: boolean
  /** Configured agent profiles: what the new-tab menus offer, plus each one's launch tweaks. */
  agents: AgentConfig[]
  /**
   * App color theme: 'system' follows the OS, else a theme id. Defaults to 'dark'.
   * Workspace-scoped, like the accent: each workspace runs in its own window,
   * and a different theme per window is another way to tell them apart.
   */
  theme: ThemeMode
  /**
   * What `theme: 'system'` resolves to on a dark and on a light OS.
   *
   * Two fields rather than one, because following the OS is a choice of PAIR:
   * the whole point is that the window changes when the OS does, and a single
   * "system theme" could only ever be right half the time. Kept separate from
   * `theme` so pinning a theme for an afternoon and switching back to System
   * does not lose the pair — and so setting the light half is possible without
   * first switching to it and being blinded.
   *
   * Each must name a theme OF ITS OWN APPEARANCE; see normalizeSystemTheme.
   * Workspace-scoped along with `theme`, since the two only mean anything together.
   */
  systemDarkTheme: ThemeId
  systemLightTheme: ThemeId
  /**
   * Whether the mono font draws its coding ligatures — JetBrains Mono turning
   * `!=` and `=>` into one glyph. On by default, because that is the font's own
   * look and what the app has always shipped. Workspace-scoped along with the
   * theme, so the whole look of a window is set in one place.
   */
  fontLigatures: boolean
  /**
   * Where a tab opened from outside the pane area lands (command palette, git
   * panel, dev-server link). Defaults to `right`, so an opened file sits beside
   * what you were doing rather than on top of it.
   */
  defaultOpenAction: OpenAction
  /**
   * The workspace's accent colour as `#rrggbb`, or null for the theme's built-in
   * blue. Workspace-scoped on purpose: each workspace runs in its own window,
   * and a different accent per window is what lets the eye tell them apart
   * without reading the title bar.
   */
  accentColor: string | null
  /**
   * The command "Open in External Editor" launches with the file's absolute
   * path: a name looked up on PATH (`code`, `cursor`, `subl`) or a full path to
   * the executable. Empty means VS Code's `code`.
   */
  externalEditor: string
  /**
   * What goes in front of the branch name made for a new Worktree: `feature/`
   * turns "Login flow" into `feature/login-flow`. The separator is part of it
   * (`jb-` works as well as `team/`), and empty means no prefix. It names the
   * branch Orbital makes from a Worktree's name; a branch asked for by name,
   * or an existing one being opened, is used as it is. See shared/worktree-branch.ts.
   */
  worktreeBranchPrefix: string
}

/**
 * Coerce a stored or imported accent value to `#rrggbb` lowercase, or null when
 * it is not one. Storage is shared with hand-edited YAML and other builds, so
 * this is checked on the way OUT of storage rather than trusted.
 */
export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim())
  return m ? `#${m[1].toLowerCase()}` : null
}

/** What a workspace row stores: every field of {@link Settings}. */
export type WorkspaceSettings = Settings

/**
 * A settings write: only the keys the caller actually changed.
 *
 * A writer that sends its whole in-memory copy reverts whatever changed in the
 * meantime (the View menu, the palette, an import). Naming the changed keys and
 * nothing else is what makes concurrent edits to different keys compose. Being a
 * `Partial` of {@link Settings} rather than a loose bag also catches most unknown
 * keys at the call site — but only where the patch is written inline, since
 * excess-property checking is a rule about object LITERALS: `setSettings({ theme,
 * bogus })` is a compile error, while `const p = { theme, bogus }` followed by
 * `setSettings(p)` compiles clean. The type is a good early warning, not a
 * guarantee; the guarantee is that main drops anything unrecognized before it
 * reaches storage.
 */
export type SettingsPatch = Partial<Settings>

/** Full application state pushed to / pulled by the renderer. */
export interface AppState {
  repos: Repo[]
  /** Every project in the workspace; each repo's `projectId` names one of these. */
  projects: Project[]
  /** Every rail folder, of projects and of a project's repos alike, each with what is filed in it. */
  railFolders: RailFolder[]
  /** The rail's top level, in order: every folder of projects and every project that is in none. */
  railItems: RailItem[]
  /**
   * For each project that has folders among its repos: the top of that list,
   * in order (its folders, and its repos that are in none). The home repo is
   * listed like any other, though the rail draws it as the project's header.
   * A project with no folders is not listed: its repos read as `repoIds` has them.
   */
  railProjectItems: Record<string, RailItem[]>
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

/** Branch list for a repo plus the branch HEAD currently points at. */
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

/** One commit in the current branch's history (the list view's row). */
export interface GitCommit {
  /** Full hash. */
  hash: string
  /** Parent hashes, first parent first; more than one means a merge. */
  parents: string[]
  author: string
  email: string
  /** Author date, unix seconds. */
  timestamp: number
  /** First line of the message. */
  subject: string
  /**
   * Branches and tags pointing here, as git decorates them (`main`,
   * `origin/main`, `tag: v1.2.0`), with the HEAD marker lifted into `isHead`.
   */
  refs: string[]
  isHead: boolean
}

/** A page of history: `hasMore` says whether asking with a larger skip yields more. */
export interface GitLogPage {
  commits: GitCommit[]
  hasMore: boolean
}

/** One file as a commit changed it. */
export interface GitCommitFile {
  path: string
  /** Set for renames/copies: where the file came from. */
  oldPath?: string
  state: GitFileState
  additions: number
  deletions: number
  binary: boolean
}

/** A selected commit's full message and change list. */
export interface GitCommitDetail {
  hash: string
  /** The whole message, subject line included, trailing whitespace trimmed. */
  body: string
  files: GitCommitFile[]
}

/**
 * One file matched by the command palette's search, across every Worktree in
 * the workspace. `worktreeId` is what makes the hit openable (and what the
 * palette labels with the owning repo ▸ Worktree); `path` is
 * checkout-relative, like every other path crossing this bridge.
 */
export interface FileSearchHit {
  worktreeId: string
  path: string
  /** Fuzzy score, descending across the returned list (see shared/fuzzy.ts). */
  score: number
}

/* ----------------------------------------------------------------------------
 * Content search (the Search tab and the palette's `/` view)
 *
 * Distinct from {@link FileSearchHit}, which matches file NAMES. This searches
 * file CONTENTS, and is served by `git grep` per checkout — see
 * main/services/search.ts for why that rather than an index.
 * -------------------------------------------------------------------------- */

/** How wide a content search casts: one checkout, one repo's checkouts, or all of them. */
export type SearchScope = 'worktree' | 'repo' | 'workspace'

/** The scopes in the order the Search tab offers them, with their labels. */
export const SEARCH_SCOPES: ReadonlyArray<{ value: SearchScope; label: string }> = [
  { value: 'worktree', label: 'This Worktree' },
  { value: 'repo', label: 'This repo' },
  { value: 'workspace', label: 'All repos' }
]

export interface SearchQuery {
  /** The pattern. A literal by default; a PCRE regular expression when `regex`. */
  query: string
  caseSensitive?: boolean
  /** Match only at word boundaries (git grep -w). */
  wholeWord?: boolean
  regex?: boolean
  /** Default: `worktree` when `worktreeId` is given, else `workspace`. */
  scope?: SearchScope
  /** The checkout the `worktree` and `repo` scopes are anchored on. */
  worktreeId?: string
  /**
   * Comma-separated globs limiting which files are searched, e.g.
   * `src/**,*.ts`. Empty means every file the checkout tracks.
   */
  include?: string
  /** Cap on total matches returned; the palette's peek asks for far fewer than the tab. */
  limit?: number
}

/** One matching line. */
export interface SearchMatch {
  /** 1-based line number in the file. */
  line: number
  /** The line's text. A very long line is clipped around its first match. */
  text: string
  /** `[start, end)` character offsets into `text` for each match on the line. */
  ranges: [number, number][]
  /** Characters cut from the START of the line when clipping; 0 when whole. */
  clippedStart: number
}

/** One file's matches. */
export interface SearchFileResult {
  worktreeId: string
  /** Checkout-relative, `/`-separated — the same spelling the file API takes. */
  path: string
  matches: SearchMatch[]
  /** The per-file cap was reached; this file has more matches than are listed. */
  truncated: boolean
}

export interface SearchResults {
  files: SearchFileResult[]
  totalMatches: number
  /** A cap was reached, so the result set is partial. */
  truncated: boolean
  /**
   * Per-checkout failures — a bad regex, a checkout whose directory is gone.
   * One failing checkout must not take the whole search down, so they are
   * reported alongside whatever the others found.
   */
  errors: { worktreeId: string; message: string }[]
  /** True when the search was superseded or cancelled; `files` is meaningless. */
  cancelled: boolean
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
  /**
   * File the task under another repo of its project (e.g. dragged across board
   * lanes), or null to clear it. Refused while the task has a live worktree in
   * a different repo. A task's project never changes through a patch.
   */
  repoId?: string | null
}

/** Per-repo agent settings update. */
export interface RepoAgentPatch {
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
  /**
   * Installed, but not what this build would write — an older Orbital's copy.
   * Orbital updates in place, so the answer is one button rather than a remove
   * and a reinstall; see the Update path in Settings.
   */
  outdated: boolean
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
  /** Installed, but not byte-for-byte what this build would write. */
  outdated: boolean
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
  /** The block is there, but not the one this build would write. */
  outdated: boolean
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

/**
 * A terminal's state for a tab that is (re)mounting, plus the sequence
 * cut-point it represents (PRD §5 replay). `data` is not the raw output: it is
 * the screen, scrollback, cursor and modes written out so that a fresh xterm
 * of the same size, given it, ends up where the terminal is now.
 */
export interface TerminalBuffer {
  data: string
  /** Cumulative bytes the snapshot covers; live chunks with seq <= this are dupes. */
  seq: number
  /** The size `data` was drawn at, to write it back at. 0 when there is no screen (a notice, an unknown tab). */
  cols: number
  rows: number
}

export interface TerminalExitEvent {
  tabId: string
  exitCode: number
}

/**
 * Something about a checkout's git state (working tree, index, HEAD, remote
 * refs) may have changed. Sent for the git watcher's debounced signal, after
 * the app's own git and file mutations, and after a background fetch — and for
 * nothing else, so the git panel / file tree / commit history can re-read
 * without spawning git on every unrelated state broadcast (terminal status
 * flips, task edits, ...).
 */
export interface GitChangedEvent {
  /** Worktrees whose checkout is affected. */
  worktreeIds: string[]
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
 * CLI control protocol (orbital CLI <-> main, over a local named pipe)
 * ========================================================================== */

/** Environment variables Orbital injects into every Worktree terminal (PRD §9). */
export const ENV = {
  terminalId: 'ORBITAL_TERMINAL_ID',
  worktreeId: 'ORBITAL_WORKTREE_ID',
  /** The terminal's repo; set but empty in a project's folder session, which has no repo. */
  repoId: 'ORBITAL_REPO_ID',
  /**
   * The terminal's PROJECT. Before projects existed this carried the repo id,
   * so a CLI reading a terminal opened by an older build falls back to it for
   * the repo only when {@link ENV.repoId} is absent altogether.
   */
  projectId: 'ORBITAL_PROJECT_ID',
  /** Named-pipe path the CLI connects to. */
  socket: 'ORBITAL_SOCKET'
} as const

export type ControlCommand =
  | 'status'
  | 'whoami'
  | 'repos'
  | 'project'
  | 'worktrees'
  | 'worktree-new'
  | 'worktree-sync'
  | 'tab-new'
  | 'task-add'
  | 'task-list'
  | 'task-show'
  | 'task-update'
  | 'task-archive'
  | 'task-unarchive'
  /** Legacy alias for 'task-archive' (tasks are never hard-deleted). */
  | 'task-delete'
  | 'server-add'
  | 'server-remove'
  | 'server-list'
  /** `orbital folder ...`: the rail's folders, read and arranged from a terminal. */
  | 'folder-list'
  | 'folder-add'
  | 'folder-move'
  | 'folder-rename'
  | 'folder-remove'
  | 'hook'
  /** App-to-app, not a CLI verb: another instance is installing an update. */
  | 'quit-for-update'

export interface ControlRequest {
  cmd: ControlCommand
  /** Identity injected into the terminal env, echoed back by the CLI. */
  terminalId?: string
  worktreeId?: string
  repoId?: string
  /** The terminal's project (ORBITAL_PROJECT_ID); absent from older terminals. */
  projectId?: string
  /**
   * Command arguments. `repo` (a repo name or id, from `--repo`)
   * retargets a repo-scoped command at a sibling repo in the same
   * workspace; main resolves it into `repoId` before dispatch.
   */
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
 * A "workspace" is a collection of repos defined by a YAML config file. The
 * file is the source of truth for which repos the workspace contains (and,
 * in a later phase, for workspace-scoped settings); the SQLite `repos` table
 * is a reconciled projection of it. Each workspace maps to its own profile
 * directory (its own DB + control pipe), so instances run side by side.
 * ========================================================================== */

/** Bump when the on-disk config shape changes in a non-additive way. */
export const WORKSPACE_CONFIG_VERSION = 1

/** One repo entry in a workspace config file. */
export interface WorkspaceRepoConfig {
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
 * One project entry in a workspace config file: how the file's repos are
 * grouped. A repo no entry lists gets a project of its own on import.
 */
export interface WorkspaceProjectConfig {
  id: string
  name: string
  /** Absolute path to the project's root folder. */
  root: string
  /** The home repo's id, one of `repos`. */
  home?: string
  /** Member repo ids, in order. */
  repos: string[]
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
  repos: WorkspaceRepoConfig[]
  /** How the repos are grouped. Absent (older files): one project per repo. */
  projects?: WorkspaceProjectConfig[]
}

/** A workspace as listed in the picker (a row of the global `workspaces` table). */
export interface WorkspaceInfo {
  id: string
  name: string
  lastOpenedAt: number
  /** How many repos the workspace holds (picker display). */
  repoCount: number
}
