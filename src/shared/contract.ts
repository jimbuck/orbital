import type {
  AlertEvent,
  AppState,
  BranchInfo,
  ClaudeHooksPlan,
  ClaudeHooksStatus,
  ClaudeSkillPlan,
  ClaudeSkillStatus,
  CodexInstructionsPlan,
  CodexInstructionsStatus,
  CreateWorktreeOptions,
  FileDiff,
  FileNode,
  FileSearchHit,
  GitChangedEvent,
  GitCommitDetail,
  GitLogPage,
  GitStatus,
  Pane,
  Project,
  ProfileDirInfo,
  Repo,
  RepoAgentPatch,
  RailFolder,
  RemoveWorktreeOptions,
  SearchQuery,
  SearchResults,
  Settings,
  SettingsPatch,
  SplitDirection,
  SplitWhere,
  Tab,
  TabConfig,
  TabType,
  Task,
  TaskPatch,
  TerminalBuffer,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdateStatus,
  WorkspaceInfo,
  Worktree
} from './types'
import type {
  GithubAccountRef,
  GithubContext,
  GithubCreateRepoOptions,
  GithubCreatedRepo,
  GithubRepoNameCheck,
  GithubRepoSummary
} from './github'

/**
 * The window contract: everything the renderer can ask of the main process,
 * and everything main can push to it. Each operation is stated ONCE, below,
 * as an entry in `contract`. The rest is derived from that entry:
 *
 *  - `OrbitalApi`, the type of `window.orbital`, from its signature;
 *  - its IPC channel (`IPC.<name>`), from its name;
 *  - its line in the preload bridge, from its kind (see preload/index.ts);
 *  - the argument and result types of its handler in main (see
 *    main/ipc/handle.ts), which the compiler checks against the signature.
 *
 * So adding an operation is one entry here plus its handler. Because the
 * contract is a runtime value as well as a type, anything that has to carry
 * the whole surface somewhere else (a forwarder to a remote host, a bridge
 * for a browser client) can iterate it instead of restating it.
 *
 * This module imports types only, so the preload bundle that builds the
 * bridge from it pulls in nothing else.
 */

/** How an operation crosses the process seam. */
export type OperationKind =
  /** Renderer asks, main answers (`ipcRenderer.invoke` / `ipcMain.handle`). */
  | 'invoke'
  /** Renderer tells main, no reply (`ipcRenderer.send` / `ipcMain.on`). */
  | 'send'
  /** Main pushes to the renderer; the API method subscribes and returns an unsubscribe. */
  | 'event'
  /** Implemented in the preload itself; never reaches main. */
  | 'local'

type AnyFn = (...args: any[]) => unknown

export interface Operation<K extends OperationKind = OperationKind, F extends AnyFn = AnyFn> {
  readonly kind: K
  /** Type-level only: the operation's signature as `window.orbital` exposes it. Never set. */
  readonly signature?: F
}

const invoke = <F extends (...args: any[]) => Promise<unknown>>(): Operation<'invoke', F> => ({ kind: 'invoke' })
const send = <F extends (...args: any[]) => void>(): Operation<'send', F> => ({ kind: 'send' })
const event = <P>(): Operation<'event', (cb: (payload: P) => void) => () => void> => ({ kind: 'event' })
const local = <F extends AnyFn>(): Operation<'local', F> => ({ kind: 'local' })

export const contract = {
  // state
  getState: invoke<() => Promise<AppState>>(),
  /** Persist only the changed keys; resolves with the full merged settings. */
  setSettings: invoke<(patch: SettingsPatch) => Promise<Settings>>(),

  // workspaces
  /** Every workspace in the global DB, most recently opened first. */
  listWorkspaces: invoke<() => Promise<WorkspaceInfo[]>>(),
  /**
   * Launch a separate instance for the workspace with `workspaceId` (opening
   * the current one just refocuses this window).
   */
  openWorkspace: invoke<(workspaceId: string) => Promise<WorkspaceInfo | null>>(),
  /** Create a new empty workspace named `name`, then launch it. */
  createWorkspace: invoke<(name: string) => Promise<WorkspaceInfo | null>>(),
  renameWorkspace: invoke<(workspaceId: string, name: string) => Promise<void>>(),
  /**
   * Delete a workspace and everything in it (repos/worktrees/tasks rows —
   * nothing on disk). The current workspace can't delete itself.
   */
  removeWorkspace: invoke<(workspaceId: string) => Promise<WorkspaceInfo[]>>(),
  /** Write a workspace (repos + settings) to a shareable YAML via save dialog. */
  exportWorkspace: invoke<(workspaceId: string) => Promise<string | null>>(),
  /** Create a new workspace from a shared YAML via open dialog. */
  importWorkspace: invoke<() => Promise<WorkspaceInfo | null>>(),

  // repos
  /**
   * Pick a folder and add it as a repo. With `projectId` the repo joins that
   * project (moving there if it was already added elsewhere); otherwise it
   * gets a project of its own.
   */
  addRepo: invoke<(projectId?: string) => Promise<Repo | null>>(),
  removeRepo: invoke<(repoId: string) => Promise<void>>(),
  renameRepo: invoke<(repoId: string, name: string) => Promise<void>>(),
  /** Native folder picker; `null` when cancelled. */
  pickDirectory: invoke<(title?: string) => Promise<string | null>>(),

  // projects: a root folder and the repos that belong together under it.
  // Every repo is in exactly one project.
  /**
   * Move a repo into a project, just before `beforeRepoId` among its repos
   * (last when null). The same project reorders. The project it left is
   * deleted when empty, and reset to its one remaining repo's name and path
   * when it has no home; a one-repo project that gains a second is re-rooted
   * to the folder they share.
   */
  addRepoToProject: invoke<(projectId: string, repoId: string, beforeRepoId: string | null) => Promise<void>>(),
  /**
   * Take a repo out of its project into a new one of its own, placed in the
   * rail like `placeProject`. Resolves to the repo's project (null if the repo
   * is gone).
   */
  detachRepo: invoke<(repoId: string, folderId: string | null, beforeId: string | null) => Promise<Project | null>>(),
  /** Make one of the project's repos its home, or clear the home with null. */
  setProjectHome: invoke<(projectId: string, repoId: string | null) => Promise<void>>(),
  /** Pick the project's root folder with the native picker. Resolves to the new root, or null when cancelled. */
  setProjectRoot: invoke<(projectId: string) => Promise<string | null>>(),
  setProjectManagedBlock: invoke<(projectId: string, on: boolean) => Promise<void>>(),
  /** Turn the project's `.code-workspace` file on or off (off removes the one Orbital wrote). */
  setProjectCodeWorkspace: invoke<(projectId: string, on: boolean) => Promise<void>>(),
  renameProject: invoke<(projectId: string, name: string) => Promise<void>>(),
  /** Clear the home and give every repo a project of its own, where the project was in the rail. */
  ungroupProject: invoke<(projectId: string) => Promise<void>>(),
  /** Remove a project and all its repos from Orbital. Nothing on disk changes. */
  removeProject: invoke<(projectId: string) => Promise<void>>(),
  /**
   * Pick a root folder with the native picker and make an empty project
   * there, named after the folder and listed last. Null when cancelled.
   */
  createProject: invoke<() => Promise<Project | null>>(),

  // rail folders: how the rail groups projects. None of these touch a
  // project's or repo's own row, paths, worktrees or any setting.
  /**
   * Add a folder. With `projectId` it takes that project's place in the rail
   * and holds it; without, it goes at the top.
   */
  createRailFolder: invoke<(name: string, projectId?: string) => Promise<RailFolder>>(),
  renameRailFolder: invoke<(folderId: string, name: string) => Promise<void>>(),
  /** Delete a folder. Its projects stay in Orbital, loose in the rail where the folder was. */
  removeRailFolder: invoke<(folderId: string) => Promise<void>>(),
  setRailFolderCollapsed: invoke<(folderId: string, collapsed: boolean) => Promise<void>>(),
  /**
   * Put a project in `folderId` (`null` = the rail's top level), just before
   * `beforeId` or last when that is null. `beforeId` names a project in that
   * folder or, at the top level, a folder or a loose project.
   */
  placeProject: invoke<(projectId: string, folderId: string | null, beforeId: string | null) => Promise<void>>(),
  /** Put a folder just before the top-level row `beforeId` (a folder or a loose project), or last when null. */
  placeRailFolder: invoke<(folderId: string, beforeId: string | null) => Promise<void>>(),

  // github (via the gh CLI)
  /**
   * Every account gh is signed in as, plus the user / orgs / template lists for
   * `account` (gh's active account when omitted). Rejects when gh is missing
   * or signed out. Every other github* call takes the same `account` so the
   * whole flow acts as one login without switching gh's active account.
   */
  githubContext: invoke<(account?: GithubAccountRef) => Promise<GithubContext>>(),
  /** Repositories under `owner` that `account` can see, most recently pushed first. */
  githubListRepos: invoke<(owner: string, account?: GithubAccountRef) => Promise<GithubRepoSummary[]>>(),
  /** Whether `owner/name` is well-formed and not already taken. */
  githubCheckRepoName: invoke<(owner: string, name: string, account?: GithubAccountRef) => Promise<GithubRepoNameCheck>>(),
  /** Create a repository on GitHub as `opts.account`. Nothing is cloned. */
  githubCreateRepo: invoke<(opts: GithubCreateRepoOptions) => Promise<GithubCreatedRepo>>(),
  /**
   * Clone `owner/repo` into `<parentDir>/<repo>` as `account` and register it
   * as a repo, like `addRepo` does for a folder picked by hand.
   */
  githubCloneRepo: invoke<
    (nameWithOwner: string, parentDir: string, account?: GithubAccountRef, projectId?: string) => Promise<Repo>
  >(),

  // worktrees / panes / tabs
  createWorktree: invoke<(repoId: string, opts: CreateWorktreeOptions) => Promise<Worktree>>(),
  removeWorktree: invoke<(worktreeId: string, opts: RemoveWorktreeOptions) => Promise<void>>(),
  renameWorktree: invoke<(worktreeId: string, name: string) => Promise<void>>(),
  /**
   * Copy the root checkout's env files into a linked Worktree again, overwriting
   * its copies. Resolves with the checkout-relative paths that were copied.
   */
  syncWorktreeEnv: invoke<(worktreeId: string) => Promise<{ copied: string[] }>>(),
  /** Force-reset a Worktree's terminals (and its aggregate) to idle when the status is out of sync. */
  clearWorktreeStatus: invoke<(worktreeId: string) => Promise<void>>(),
  /** Branches of a repo + what HEAD points at (for the New Worktree base-ref picker). */
  listBranches: invoke<(repoId: string) => Promise<BranchInfo>>(),
  /** Update a repo's default agent profile / explicit executable path. */
  setRepoAgent: invoke<(repoId: string, patch: RepoAgentPatch) => Promise<void>>(),
  /**
   * What a typed profile directory resolves to (`~`/`%VAR%` expanded) and
   * whether it is there yet — so Settings can show the real path before a
   * launch quietly starts a fresh profile somewhere else. A blank `configDir`
   * answers with the provider's machine default.
   */
  inspectProfileDir: invoke<(provider: string, configDir: string) => Promise<ProfileDirInfo>>(),
  /* Hooks / skill / instructions are installed INTO an agent profile's own
     directory, so every call names the profile (an AgentConfig id) it acts on. */
  /** Whether Orbital's Claude status hooks are installed for this profile, and where. */
  claudeHooksStatus: invoke<(agentId: string) => Promise<ClaudeHooksStatus>>(),
  /** The exact JSON Orbital would merge into settings.json (for the confirm dialog). */
  claudeHooksPlan: invoke<(agentId: string) => Promise<ClaudeHooksPlan>>(),
  /** Merge Orbital's hook entries into the profile's settings.json (idempotent). */
  installClaudeHooks: invoke<(agentId: string) => Promise<ClaudeHooksStatus>>(),
  /** Strip only Orbital's hook entries from the profile's settings.json. */
  removeClaudeHooks: invoke<(agentId: string) => Promise<ClaudeHooksStatus>>(),
  /** Whether Orbital's `orbital` skill is installed for this Claude profile. */
  claudeSkillStatus: invoke<(agentId: string) => Promise<ClaudeSkillStatus>>(),
  /** The exact SKILL.md Orbital would write (for the confirm dialog). */
  claudeSkillPlan: invoke<(agentId: string) => Promise<ClaudeSkillPlan>>(),
  /** Write the `orbital` skill into the Claude profile's skills directory. */
  installClaudeSkill: invoke<(agentId: string) => Promise<ClaudeSkillStatus>>(),
  /** Delete the skill Orbital wrote (never one it does not own). */
  removeClaudeSkill: invoke<(agentId: string) => Promise<ClaudeSkillStatus>>(),
  /** Whether Orbital's block is in this Codex profile's AGENTS.md. */
  codexInstructionsStatus: invoke<(agentId: string) => Promise<CodexInstructionsStatus>>(),
  /** The exact block Orbital would merge in (for the confirm dialog). */
  codexInstructionsPlan: invoke<(agentId: string) => Promise<CodexInstructionsPlan>>(),
  /** Merge Orbital's block into the Codex profile's AGENTS.md (idempotent). */
  installCodexInstructions: invoke<(agentId: string) => Promise<CodexInstructionsStatus>>(),
  /** Strip only Orbital's block from that AGENTS.md. */
  removeCodexInstructions: invoke<(agentId: string) => Promise<CodexInstructionsStatus>>(),
  createTab: invoke<(worktreeId: string, paneId: string | null, type: TabType, config?: TabConfig) => Promise<Tab>>(),
  closeTab: invoke<(tabId: string) => Promise<void>>(),
  /** Set a tab's explicit title override; an empty title reverts to the derived one. */
  renameTab: invoke<(tabId: string, title: string) => Promise<void>>(),
  /** Merge fields into a tab's persisted config (e.g. the browser's current URL). */
  updateTabConfig: invoke<(tabId: string, patch: Partial<TabConfig>) => Promise<void>>(),
  setActiveTab: invoke<(paneId: string, tabId: string) => Promise<void>>(),
  moveTab: invoke<(tabId: string, targetPaneId: string, slot?: number) => Promise<void>>(),
  /** Split `paneId` in `dir`, putting a new empty pane on the `where` side. */
  splitPane: invoke<(worktreeId: string, paneId: string, dir: SplitDirection, where: SplitWhere) => Promise<Pane>>(),
  /** Close a pane (and its tabs); the layout collapses to its sibling. */
  closePane: invoke<(worktreeId: string, paneId: string) => Promise<void>>(),
  /** Split a target pane toward an edge and move the dragged tab into the new pane. */
  moveTabToEdge: invoke<(tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom') => Promise<void>>(),
  /** Resize a split node (fraction for child a, clamped 0.1–0.9). */
  setSplitRatio: invoke<(worktreeId: string, splitId: string, ratio: number) => Promise<void>>(),

  // terminals
  terminalInput: send<(tabId: string, data: string) => void>(),
  terminalResize: send<(tabId: string, cols: number, rows: number) => void>(),
  /** Current scrollback buffer + sequence cut-point, for replay when a tab remounts. */
  terminalBuffer: invoke<(tabId: string) => Promise<TerminalBuffer>>(),
  /** Whether the tab still has a live PTY process — drives the close-tab confirm. */
  terminalAlive: invoke<(tabId: string) => Promise<boolean>>(),
  /** Read the system clipboard (Electron clipboard module) — used for terminal paste. */
  readClipboard: local<() => string>(),
  /** Write text to the system clipboard — used for terminal/Edit-menu copy. */
  writeClipboard: local<(text: string) => void>(),
  /** Save the clipboard image (if any) to a scratch PNG and return its absolute path — used for terminal image paste. */
  pasteClipboardImage: invoke<() => Promise<string | null>>(),

  // git
  gitStatus: invoke<(worktreeId: string) => Promise<GitStatus>>(),
  gitStage: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  gitUnstage: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  gitStageAll: invoke<(worktreeId: string) => Promise<void>>(),
  gitUnstageAll: invoke<(worktreeId: string) => Promise<void>>(),
  /** Revert a file's unstaged changes (tracked: restore from index; untracked: delete). */
  gitDiscard: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  /** Revert ALL unstaged changes and delete untracked files; staged changes survive. */
  gitDiscardAll: invoke<(worktreeId: string) => Promise<void>>(),
  gitCommit: invoke<(worktreeId: string, message: string, amend?: boolean) => Promise<void>>(),
  /** HEAD's full commit message ('' on an empty repo) — for the amend prefill. */
  gitLastCommitMessage: invoke<(worktreeId: string) => Promise<string>>(),
  gitPush: invoke<(worktreeId: string) => Promise<void>>(),
  gitPull: invoke<(worktreeId: string) => Promise<void>>(),
  gitFetch: invoke<(worktreeId: string) => Promise<void>>(),
  /** Switch to `branch` (`create` forks it from HEAD first). Root Worktrees only. */
  gitCheckout: invoke<(worktreeId: string, branch: string, create?: boolean) => Promise<void>>(),
  gitDiff: invoke<(worktreeId: string, path: string, staged: boolean) => Promise<FileDiff>>(),
  /** A page of the current branch's history, newest first: `limit` commits after skipping `skip`. */
  gitLog: invoke<(worktreeId: string, skip: number, limit: number) => Promise<GitLogPage>>(),
  /** Full message + changed files for one commit (`hash` may be abbreviated). */
  gitCommitDetail: invoke<(worktreeId: string, hash: string) => Promise<GitCommitDetail>>(),
  /** One file's diff as `hash` changed it; `oldPath` is a rename's source. */
  gitCommitDiff: invoke<(worktreeId: string, hash: string, path: string, oldPath?: string) => Promise<FileDiff>>(),
  fileTree: invoke<(worktreeId: string) => Promise<FileNode[]>>(),
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
  listDir: invoke<(worktreeId: string, path: string) => Promise<FileNode[]>>(),
  readFile: invoke<(worktreeId: string, path: string) => Promise<string>>(),
  /** Raw file bytes as base64 — for rendering binary content (images) in the editor. */
  readFileBase64: invoke<(worktreeId: string, path: string) => Promise<string>>(),
  writeFile: invoke<(worktreeId: string, path: string, content: string) => Promise<void>>(),
  /**
   * Create an empty file `name` inside the checkout-relative directory
   * `parentDir` (`''` = repo root); resolves to the new file's relative path.
   * Rejects when the name isn't a single path segment or the file exists.
   */
  createFile: invoke<(worktreeId: string, parentDir: string, name: string) => Promise<string>>(),
  /** As `createFile`, for a directory. */
  createDirectory: invoke<(worktreeId: string, parentDir: string, name: string) => Promise<string>>(),
  /** Rename a file/directory in place; resolves to its new relative path. */
  renamePath: invoke<(worktreeId: string, path: string, newName: string) => Promise<string>>(),
  /** Send a file/directory to the OS recycle bin (recoverable, unlike unlink). */
  trashPath: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  /**
   * Absolute path of a checkout-relative path, for "Copy Path". Rejects any
   * path that LEXICALLY leaves the Worktree (`../…`, absolute); it does not
   * realpath, so the string handed back can still point through a link
   * committed in the checkout to a target outside it.
   */
  resolvePath: invoke<(worktreeId: string, path: string) => Promise<string>>(),
  /**
   * Fuzzy-search tracked files across EVERY Worktree in the workspace, best
   * match first. Main keeps one path list per checkout (git's own file list,
   * so ignored trees are skipped) and rebuilds it when that checkout changes,
   * which is what keeps this fast enough to run on every keystroke.
   */
  searchFiles: invoke<(query: string, limit?: number) => Promise<FileSearchHit[]>>(),
  /**
   * Search file CONTENTS across the scoped checkouts, best-effort: a checkout
   * that fails reports an error rather than failing the whole search.
   *
   * `searchId` identifies the caller's search slot. Issuing a new search with
   * the same id kills whatever was still running under it, which is what makes
   * this safe to fire on every keystroke — the palette uses one slot, and each
   * Search tab uses its own.
   */
  searchContent: invoke<(query: SearchQuery, searchId: string) => Promise<SearchResults>>(),
  /** Kill anything running under `searchId` (a Search tab closing, the palette dismissing). */
  cancelSearch: invoke<(searchId: string) => Promise<void>>(),

  // tasks
  /** File a task in a project, under one of its repos or (null / omitted) none. */
  createTask: invoke<
    (projectId: string, title: string, repoId?: string | null, description?: string, tags?: string[]) => Promise<Task>
  >(),
  updateTask: invoke<(taskId: string, patch: TaskPatch) => Promise<Task>>(),
  /** Tasks are archived, never deleted: hidden from the board and panel, but kept (with their number). */
  archiveTask: invoke<(taskId: string) => Promise<void>>(),
  unarchiveTask: invoke<(taskId: string) => Promise<void>>(),
  /**
   * The active workspace's archived tasks. AppState.tasks carries only active
   * ones, so the archived-tasks table and the task editor's tag suggestions
   * fetch these on demand.
   */
  listArchivedTasks: invoke<() => Promise<Task[]>>(),

  // browser / window
  openExternal: invoke<(url: string) => Promise<void>>(),
  /**
   * Register a browser tab's <webview> guest so main can route its popup /
   * new-window requests (Ctrl/Cmd-click, target=_blank, window.open) to a new
   * internal browser tab instead of a real OS popup window.
   */
  registerBrowserView: invoke<(webContentsId: number, worktreeId: string, paneId: string) => Promise<void>>(),
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
  openPath: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  /**
   * Show a file/folder SELECTED in its containing folder (`showItemInFolder`).
   * Distinct from `openPath`, which opens the item itself — for a file that
   * would launch its default application instead of revealing it. Same
   * `(worktreeId, path)` contract, resolved in main behind the same lexical
   * containment check, with the same link caveat as `openPath`.
   */
  revealPath: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  /**
   * Open an external terminal window at a folder in a Worktree (Windows
   * Terminal / PowerShell on Windows). Same `(worktreeId, path)` contract,
   * resolved in main behind the same lexical containment check, with the same
   * link caveat as `openPath` — the path is the new shell's working directory.
   */
  openInTerminal: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  /**
   * Open a file or folder in a Worktree with the configured external editor
   * (Settings ▸ External editor). Same `(worktreeId, path)` contract and
   * containment as `openPath`; rejects when the editor cannot be found.
   */
  openInEditor: invoke<(worktreeId: string, path: string) => Promise<void>>(),
  /**
   * Open a REPO's repo directory in the OS file manager.
   *
   * The rail's repo header offers this, and it cannot go through
   * `openPath(worktreeId, '')`: a repo only has a root Worktree row once
   * `reconcileRepoWorktrees` has listed its checkouts, and that returns
   * empty-handed for a path that is not a git repo — permanently, not just
   * until the first scan. "Open the folder and see why" is exactly what the
   * user wants in that state, so the action has to be reachable without a
   * Worktree.
   *
   * There is no `path` parameter, and that is the point: the only thing the
   * renderer names is a repo id, and main derives the directory from its own
   * stored `repoPath`. Nothing renderer-supplied reaches the OS, so there is no
   * path to contain — as opposed to re-admitting an absolute path over the
   * bridge, which is the hole the `(worktreeId, path)` shape closed.
   */
  openRepoPath: invoke<(repoId: string) => Promise<void>>(),
  /**
   * Open an external terminal window at a REPO's repo directory. Same
   * repo-id-only contract, and the same reason for existing, as
   * `openRepoPath`.
   */
  openRepoInTerminal: invoke<(repoId: string) => Promise<void>>(),
  /**
   * Open a PROJECT's session directory (its home repo's path, else its root
   * folder) in the OS file manager. Project id only, like `openRepoPath`.
   */
  openProjectPath: invoke<(projectId: string) => Promise<void>>(),
  /** Open an external terminal at a project's session directory. */
  openProjectInTerminal: invoke<(projectId: string) => Promise<void>>(),
  /** Reveal the debug-log folder in the OS file manager (for the Settings "Open log folder" action). */
  openLogFolder: invoke<() => Promise<void>>(),
  windowMinimize: send<() => void>(),
  windowMaximize: send<() => void>(),
  windowClose: send<() => void>(),
  toggleDevTools: send<() => void>(),
  /**
   * UI zoom (View ▸ Zoom, Ctrl +/-/0). Main owns the level — it is applied to
   * the window's webContents and persisted per machine — and reports the
   * resulting factor through onZoomChanged.
   */
  zoomIn: send<() => void>(),
  zoomOut: send<() => void>(),
  zoomReset: send<() => void>(),
  /** The current zoom factor (1 = 100%), for seeding the store. */
  getZoomFactor: invoke<() => Promise<number>>(),

  // updates
  /** The running app's version (package.json version of the packaged build). */
  getVersion: invoke<() => Promise<string>>(),
  /** Current updater status (seed for the store; live changes arrive via onUpdateStatus). */
  updateStatus: invoke<() => Promise<UpdateStatus>>(),
  /** Trigger a check now; progress/result arrive via onUpdateStatus events. */
  checkForUpdates: invoke<() => Promise<UpdateStatus>>(),
  /**
   * Close every Orbital window and install the downloaded update (no-op unless
   * phase is `ready`). Main confirms first when other workspaces are open.
   */
  installUpdate: send<() => void>(),

  // events — each returns an unsubscribe function
  onStateChanged: event<AppState>(),
  onTerminalData: event<TerminalDataEvent>(),
  onTerminalExit: event<TerminalExitEvent>(),
  onAlert: event<AlertEvent>(),
  onUpdateStatus: event<UpdateStatus>(),
  onGitChanged: event<GitChangedEvent>(),
  /** The window's zoom factor changed (a shortcut, a menu action, or the persisted level applied on load). */
  onZoomChanged: event<number>(),
  /**
   * A keyboard shortcut asked for the command palette. Handled in main (like
   * the zoom shortcuts) so it fires even when a terminal has focus and xterm
   * would otherwise swallow the keystroke. `prefix` seeds the query — `>` for
   * commands, `''` for the mixed everything view.
   */
  onOpenPalette: event<string>()
} as const satisfies Record<string, Operation>

/* ---- derived ------------------------------------------------------------- */

type Contract = typeof contract
type SignatureOf<O> = O extends Operation<OperationKind, infer F> ? F : never
type NamesOf<K extends OperationKind> = {
  [N in keyof Contract]: Contract[N] extends Operation<K> ? N : never
}[keyof Contract]

/** The renderer-facing API, exposed on `window.orbital` by the preload bridge. */
export type OrbitalApi = { [N in keyof Contract]: SignatureOf<Contract[N]> }

export type InvokeName = NamesOf<'invoke'>
export type SendName = NamesOf<'send'>
export type EventName = NamesOf<'event'>
export type LocalName = NamesOf<'local'>

/** `onStateChanged` -> `StateChanged`. */
type EventStem<N extends string> = N extends `on${infer Stem}` ? Stem : never

/** What an event carries: the argument its subscribers are called with. */
export type EventPayload<N extends EventName> = OrbitalApi[N] extends (cb: (payload: infer P) => void) => unknown
  ? P
  : never

/**
 * Channel names. A request's channel is its own name; an event's drops the
 * `on` its subscribe method carries: `onStateChanged` is pushed on
 * `IPC.evtStateChanged`. Local operations have no channel.
 */
export type Channels = { readonly [N in InvokeName | SendName]: `orbital:${N}` } & {
  readonly [N in EventName as `evt${EventStem<N>}`]: `orbital:evt:${Uncapitalize<EventStem<N>>}`
}

/** The payload type of each event, keyed by its channel string. */
export type EventPayloads = {
  [N in EventName as `orbital:evt:${Uncapitalize<EventStem<N>>}`]: EventPayload<N>
}

/** Push an event to the window: the channel fixes what the payload must be. */
export type Push = <C extends keyof EventPayloads>(channel: C, payload: EventPayloads[C]) => void

/** The IPC channel an operation travels on, or null for one that never leaves the preload. */
export function channelOf(name: string, kind: OperationKind): string | null {
  if (kind === 'local') return null
  if (kind === 'event') return `orbital:evt:${name.charAt(2).toLowerCase()}${name.slice(3)}`
  return `orbital:${name}`
}

/** Every channel by key, for main: `IPC.gitStatus`, `IPC.evtStateChanged`. */
export const IPC = Object.fromEntries(
  Object.entries(contract).flatMap(([name, op]) => {
    const channel = channelOf(name, op.kind)
    if (channel === null) return []
    return [[op.kind === 'event' ? `evt${name.slice(2)}` : name, channel]]
  })
) as Channels
