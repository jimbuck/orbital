import { create } from 'zustand'
import { fireAndForget } from './lib/bridge'
import type {
  AppState,
  GitFileState,
  Project,
  Repo,
  RailFolder,
  RailItem,
  Worktree,
  Task,
  Settings,
  UpdateStatus,
  WorkspaceInfo
} from '@shared/types'

export type ModalType =
  | 'settings'
  | 'addRepo'
  | 'newWorktree'
  | 'board'
  | 'archivedTasks'
  | 'about'
  | 'editTask'
  | 'workspaces'
  | 'commitHistory'
  | null

interface UIState {
  ready: boolean
  /** The repo of the open session; null while a project's folder session is open. */
  activeRepoId: string | null
  /** The project of the open session (the active repo's, or the folder session's own). */
  activeProjectId: string | null
  activeWorktreeId: string | null
  /**
   * Open/closed rows of the rail, keyed by id (project ids and repo ids never
   * collide). A repo's linked worktrees default closed; a project group's
   * children default OPEN (see {@link projectOpen}).
   */
  expanded: Record<string, boolean>
  /**
   * The project whose name the rail is editing. In the store rather than the
   * rail so a project made from the palette, or by dropping one repo on
   * another, opens straight into its name.
   */
  renamingProjectId: string | null
  /**
   * The rail's latest announcement for screen readers (its polite live
   * region): what a drop or a menu action just did to the grouping.
   */
  railMessage: string
  modal: ModalType
  /** Free-form payload for the open modal (e.g. the repo a New Worktree targets). */
  modalData: unknown
  /**
   * Ordered stack of open modals — enables stacking (e.g. a task modal on top of
   * the board without closing it). `modal`/`modalData` mirror the TOP entry so
   * existing single-modal consumers keep working unchanged.
   */
  modalStack: { type: Exclude<ModalType, null>; data: unknown }[]
  /**
   * The pane the user last worked in, per Worktree (worktreeId → paneId). This
   * is where a tab opened from OUTSIDE the pane area (a git-panel diff, a dev
   * server link) lands, so it appears where the user is looking rather than in
   * whichever pane happens to be first in the layout. Renderer-only: it follows
   * clicks and focus, and a stale entry (pane since closed) is ignored by the
   * `activePaneId` selector.
   */
  activePaneIds: Record<string, string>
  /**
   * The latest ask, from outside the pane area (the git panel's change list),
   * for an editor tab to show a file. Editor tabs keep their open files in
   * component state, so this is how an already-open editor is handed a new
   * one; `seq` makes a repeat of the same file a fresh request. Renderer-only.
   */
  editorOpen: EditorOpenRequest | null
  /** Count of Worktrees currently needing attention (drives the title-bar banner). */
  alertCount: number
  /** Auto-updater state (drives the "restart to update" pill and the About dialog). */
  updateStatus: UpdateStatus
  /** The window's UI zoom factor (1 = 100%), mirrored from main for the View menu. */
  zoomFactor: number
  /**
   * The command palette, when open. `query` is what it should be seeded with
   * (`>` for commands, `''` for the mixed view); `seq` makes re-opening with a
   * different prefix a fresh request even while the palette is already up, so
   * Ctrl+Shift+P from inside the file view switches it to commands.
   */
  palette: { query: string; seq: number } | null
}

/** What an outside caller wants an editor to show. */
export interface EditorOpenTarget {
  path: string
  /** Show the staged (index) side of the diff rather than the working tree. */
  staged?: boolean
  /**
   * What git says about the file. Its PRESENCE is also the signal that a diff
   * is wanted: the git panel sends it, the palette's file search does not, and
   * the editor uses that to decide whether to force diff mode on a file that is
   * already open. See EditorTab's editorOpen effect.
   */
  gitState?: GitFileState
  /**
   * 1-based line to scroll to and flash — a content-search hit. Implies the
   * file view: a diff has different line numbers, so revealing a working-tree
   * line inside one would land somewhere arbitrary.
   */
  line?: number
}

export interface EditorOpenRequest extends EditorOpenTarget {
  tabId: string
  staged: boolean
  seq: number
}

interface Data {
  repos: Repo[]
  /** Every project; the rail arranges these (see Project). */
  projects: Project[]
  /** The rail's folders, in rail order (see RailFolder). */
  railFolders: RailFolder[]
  /** The rail's top level in order: folders and the projects in none of them. */
  railItems: RailItem[]
  worktrees: Worktree[]
  tasks: Task[]
  settings: Settings | null
  /** The workspace this instance is running (null until the first state push). */
  workspace: WorkspaceInfo | null
  /** Live dev servers per worktree (from `orbital server add`). */
  devServers: Record<string, string[]>
  /** Worktree ids still setting up (background node_modules copy). */
  settingUpWorktrees: string[]
}

interface Actions {
  init: () => Promise<void>
  applyState: (s: AppState) => void
  setActiveRepo: (id: string) => void
  /** Open a project's own session: its home repo's root, else its folder session. */
  setActiveProject: (id: string) => void
  setActiveWorktree: (id: string) => void
  /** Flip a rail row open or closed. `defaultOpen` is what an unset entry means (project groups: true). */
  toggleExpanded: (id: string, defaultOpen?: boolean) => void
  /** Set a rail row open or closed. */
  setExpanded: (id: string, open: boolean) => void
  setRenamingProject: (id: string | null) => void
  announceRail: (message: string) => void
  openModal: (type: ModalType, data?: unknown) => void
  closeModal: () => void
  setActivePane: (worktreeId: string, paneId: string) => void
  /** Ask editor `tabId` to show a file (see `editorOpen`). */
  openInEditor: (tabId: string, target: EditorOpenTarget) => void
  /** Open (or re-seed) the command palette with `prefix` already typed. */
  openPalette: (prefix?: string) => void
  closePalette: () => void
}

export type Store = Data & UIState & Actions

/** Guards init() against re-entry (React StrictMode double-invokes App's effect). */
let initStarted = false

/* ---- Structural sharing ------------------------------------------------- */

/**
 * Deep equality over the plain JSON shapes that cross the IPC bridge (objects,
 * arrays, primitives, null). Key order is irrelevant.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/** `next` when it differs from `prev` in content, else `prev` (reference kept). */
function share<T>(prev: T, next: T): T {
  return deepEqual(prev, next) ? prev : next
}

/**
 * Reconcile a freshly received list against the previous one by id: every item
 * whose content is unchanged keeps its PREVIOUS object identity, and if nothing
 * at all changed the previous array itself is returned.
 *
 * Every state broadcast arrives via structured clone, so without this each
 * push (a terminal status flip, a task edit, ...) hands every subscriber brand
 * new objects and `useShallow` / `React.memo` / `useMemo` can never short-
 * circuit — the whole app re-renders on every tick while an agent works.
 */
export function shareById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev === next) return prev
  const byId = new Map<string, T>()
  for (const item of prev) byId.set(item.id, item)
  let same = prev.length === next.length
  const out = next.map((item, i) => {
    const old = byId.get(item.id)
    const kept = old !== undefined && deepEqual(old, item) ? old : item
    if (kept !== prev[i]) same = false
    return kept
  })
  return same ? prev : out
}

/**
 * Open the rail folder hiding `projectId`, if one is.
 *
 * A session can be selected from places that are not its rail row (the
 * command palette, the needs-attention banner), and a selection the rail
 * cannot show reads as nothing having happened. Called only from the explicit
 * select actions, never from applyState: a folder the user collapsed stays
 * collapsed through every state push, including the one at boot. (The project
 * and repo rows are opened by the select actions themselves, in `expanded`.)
 */
function revealProject(folders: RailFolder[], projectId: string | null | undefined): void {
  const hiding = folders.find((f) => f.collapsed && !!projectId && f.projectIds.includes(projectId))
  if (hiding) fireAndForget(window.orbital.setRailFolderCollapsed(hiding.id, false))
}

/** Whether a project group's children are showing: open unless closed by hand. */
export function projectOpen(expanded: Record<string, boolean>, projectId: string): boolean {
  return expanded[projectId] ?? true
}

/** A repo's own session: its root worktree, else (while it has none) its first. */
function repoSession(worktrees: Worktree[], repoId: string): Worktree | undefined {
  const mine = worktrees.filter((w) => w.repoId === repoId)
  return mine.find((w) => w.kind === 'root') ?? mine[0]
}

/**
 * A project's own session: its home repo's root worktree, else its folder
 * session. A plain one-repo project has neither, and its session is its repo's.
 */
export function projectSession(projects: Project[], worktrees: Worktree[], projectId: string): Worktree | undefined {
  const project = projects.find((p) => p.id === projectId)
  if (!project) return undefined
  if (project.homeRepoId) return repoSession(worktrees, project.homeRepoId)
  return (
    worktrees.find((w) => w.kind === 'folder' && w.projectId === projectId) ??
    (project.repoIds.length === 1 ? repoSession(worktrees, project.repoIds[0]) : undefined)
  )
}

export const useStore = create<Store>((set, get) => ({
  // data
  repos: [],
  projects: [],
  railFolders: [],
  railItems: [],
  worktrees: [],
  tasks: [],
  settings: null,
  workspace: null,
  devServers: {},
  settingUpWorktrees: [],

  // ui
  ready: false,
  activeRepoId: null,
  activeProjectId: null,
  activeWorktreeId: null,
  expanded: {},
  renamingProjectId: null,
  railMessage: '',
  modal: null,
  modalData: null,
  modalStack: [],
  activePaneIds: {},
  editorOpen: null,
  alertCount: 0,
  updateStatus: { phase: 'idle' },
  zoomFactor: 1,
  palette: null,

  async init() {
    if (initStarted) return
    initStarted = true
    // These subscriptions intentionally live for the app's lifetime.
    // alertCount is derived in applyState (the alert event always rides along
    // with a state broadcast); the chime listens to onAlert in App.tsx.
    window.orbital.onStateChanged((s) => get().applyState(s))
    window.orbital.onUpdateStatus((status) => set({ updateStatus: status }))
    window.orbital.onZoomChanged((zoomFactor) => set({ zoomFactor }))
    const state = await window.orbital.getState()
    get().applyState(state)
    set({ ready: true })
    // Seed with whatever the updater already knows (events fired before this
    // renderer loaded — e.g. an update that finished downloading — are gone).
    set({ updateStatus: await window.orbital.updateStatus() })
    set({ zoomFactor: await window.orbital.getZoomFactor() })
  },

  applyState(s) {
    const prev = get()
    // The open session, if it survived the push. A folder session can go (its
    // project got a home, or went back to a plain repo row) while its project
    // stays, so the project is the next thing to fall back on; then the active
    // repo, then the first repo.
    let active = s.worktrees.find((w) => w.id === prev.activeWorktreeId)
    const repoKnown = !!prev.activeRepoId && s.repos.some((p) => p.id === prev.activeRepoId)
    if (!active && repoKnown && prev.activeRepoId) active = repoSession(s.worktrees, prev.activeRepoId)
    if (!active && !repoKnown && prev.activeProjectId) {
      active = projectSession(s.projects, s.worktrees, prev.activeProjectId)
    }
    let activeRepoId: string | null
    if (active) {
      activeRepoId = active.repoId
    } else {
      activeRepoId = repoKnown ? prev.activeRepoId : (s.repos[0]?.id ?? null)
      if (activeRepoId) active = repoSession(s.worktrees, activeRepoId)
    }
    const activeWorktreeId = active?.id ?? null
    const activeProjectId = active?.projectId ?? s.repos.find((r) => r.id === activeRepoId)?.projectId ?? null

    let expanded = prev.expanded
    if (activeRepoId && expanded[activeRepoId] === undefined) {
      expanded = { ...expanded, [activeRepoId]: true }
    }

    // Keep previous references wherever the content did not change (see shareById).
    set({
      repos: shareById(prev.repos, s.repos),
      projects: shareById(prev.projects, s.projects),
      railFolders: shareById(prev.railFolders, s.railFolders),
      railItems: share(prev.railItems, s.railItems),
      worktrees: shareById(prev.worktrees, s.worktrees),
      tasks: shareById(prev.tasks, s.tasks),
      settings: share(prev.settings, s.settings),
      workspace: share(prev.workspace, s.workspace),
      devServers: share(prev.devServers, s.devServers),
      settingUpWorktrees: share(prev.settingUpWorktrees, s.settingUpWorktrees),
      activeRepoId,
      activeProjectId,
      activeWorktreeId,
      expanded,
      alertCount: s.worktrees.filter((w) => w.status === 'needs_attention').length
    })
  },

  setActiveRepo(id) {
    const projectId = get().repos.find((r) => r.id === id)?.projectId ?? null
    revealProject(get().railFolders, projectId)
    const activeWorktreeId = repoSession(get().worktrees, id)?.id ?? null
    set((s) => ({
      activeRepoId: id,
      activeProjectId: projectId,
      activeWorktreeId,
      // Folder, then project, then repo: everything between the rail's top and the row.
      expanded: { ...s.expanded, ...(projectId ? { [projectId]: true } : {}), [id]: true }
    }))
  },

  setActiveProject(id) {
    const s = get()
    const project = s.projects.find((p) => p.id === id)
    if (!project) return
    revealProject(s.railFolders, id)
    const session = projectSession(s.projects, s.worktrees, id)
    set((st) => ({
      activeProjectId: id,
      activeRepoId: session ? session.repoId : project.homeRepoId,
      activeWorktreeId: session?.id ?? null,
      expanded: { ...st.expanded, [id]: true }
    }))
  },

  setActiveWorktree(id) {
    const worktree = get().worktrees.find((w) => w.id === id)
    if (!worktree) {
      set({ activeWorktreeId: id })
      return
    }
    revealProject(get().railFolders, worktree.projectId)
    const { projectId, repoId } = worktree
    set((s) => ({
      activeWorktreeId: id,
      activeRepoId: repoId,
      activeProjectId: projectId,
      // A linked worktree shows only inside its open repo, and that inside its open project.
      expanded:
        worktree.kind === 'linked' && repoId
          ? { ...s.expanded, [projectId]: true, [repoId]: true }
          : { ...s.expanded, [projectId]: true }
    }))
  },

  toggleExpanded(id, defaultOpen = false) {
    set((s) => ({ expanded: { ...s.expanded, [id]: !(s.expanded[id] ?? defaultOpen) } }))
  },

  setExpanded(id, open) {
    if (get().expanded[id] === open) return
    set((s) => ({ expanded: { ...s.expanded, [id]: open } }))
  },

  setRenamingProject(id) {
    set({ renamingProjectId: id })
  },

  announceRail(message) {
    set({ railMessage: message })
  },

  openModal(type, data) {
    // A null type means "close everything" — clear the stack and the mirrors.
    if (type === null) {
      set({ modalStack: [], modal: null, modalData: null })
      return
    }
    // Otherwise push a new layer and mirror it as the top. Pushing is
    // backward-compatible: with nothing open the stack holds a single entry
    // (same as before); opening editTask/newWorktree over the board yields
    // [board, editTask] so BOTH render (see ModalRoot).
    set((s) => {
      const modalStack = [...s.modalStack, { type, data: data ?? null }]
      return { modalStack, modal: type, modalData: data ?? null }
    })
  },

  closeModal() {
    // Pop just the top layer and re-mirror the new top (revealing the board
    // beneath a task modal). Empty stack resets the mirrors to null.
    set((s) => {
      const modalStack = s.modalStack.slice(0, -1)
      const top = modalStack[modalStack.length - 1] ?? null
      return { modalStack, modal: top ? top.type : null, modalData: top ? top.data : null }
    })
  },

  setActivePane(worktreeId, paneId) {
    // Fired on every mousedown/focus inside a pane, so skip the no-op write —
    // a fresh object here would re-render every subscriber on each keystroke.
    if (get().activePaneIds[worktreeId] === paneId) return
    set((s) => ({ activePaneIds: { ...s.activePaneIds, [worktreeId]: paneId } }))
  },

  openInEditor(tabId, target) {
    set((s) => ({
      editorOpen: { ...target, tabId, staged: !!target.staged, seq: (s.editorOpen?.seq ?? 0) + 1 }
    }))
  },

  openPalette(prefix = '') {
    set((s) => ({ palette: { query: prefix, seq: (s.palette?.seq ?? 0) + 1 } }))
  },

  closePalette() {
    set({ palette: null })
  }
}))

/* ---- Selectors --------------------------------------------------------- */

export function activeRepo(s: Store): Repo | undefined {
  return s.repos.find((p) => p.id === s.activeRepoId)
}

export function activeProject(s: Store): Project | undefined {
  return s.projects.find((p) => p.id === s.activeProjectId)
}

export function activeWorktree(s: Store): Worktree | undefined {
  return s.worktrees.find((w) => w.id === s.activeWorktreeId)
}

export function tasksForRepo(s: Store, repoId: string): Task[] {
  return s.tasks.filter((t) => t.repoId === repoId)
}

/**
 * The pane a tab opened from outside the pane area should land in: the one the
 * user last clicked or focused in this Worktree, provided it still exists. Null
 * when nothing has been recorded (or the pane was since closed) — callers pass
 * that straight to createTab, whose null means "the first pane", which is also
 * the only sensible answer before the user has touched anything.
 */
export function activePaneId(s: Store, worktreeId: string): string | null {
  const paneId = s.activePaneIds[worktreeId]
  if (!paneId) return null
  const worktree = s.worktrees.find((w) => w.id === worktreeId)
  return worktree?.panes.some((p) => p.id === paneId) ? paneId : null
}
