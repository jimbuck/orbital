import { create } from 'zustand'
import type { AppState, Project, Worktree, Task, Settings, UpdateStatus, WorkspaceInfo } from '@shared/types'

export type ModalType =
  | 'settings'
  | 'addProject'
  | 'newWorktree'
  | 'board'
  | 'about'
  | 'editTask'
  | 'workspaces'
  | 'commitHistory'
  | null

interface UIState {
  ready: boolean
  activeProjectId: string | null
  activeWorktreeId: string | null
  expanded: Record<string, boolean>
  modal: ModalType
  /** Free-form payload for the open modal (e.g. the project a New Worktree targets). */
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
  /** Count of Worktrees currently needing attention (drives the title-bar banner). */
  alertCount: number
  /** Auto-updater state (drives the "restart to update" pill and the About dialog). */
  updateStatus: UpdateStatus
}

interface Data {
  projects: Project[]
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
  setActiveProject: (id: string) => void
  setActiveWorktree: (id: string) => void
  toggleExpanded: (id: string) => void
  openModal: (type: ModalType, data?: unknown) => void
  closeModal: () => void
  setActivePane: (worktreeId: string, paneId: string) => void
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

export const useStore = create<Store>((set, get) => ({
  // data
  projects: [],
  worktrees: [],
  tasks: [],
  settings: null,
  workspace: null,
  devServers: {},
  settingUpWorktrees: [],

  // ui
  ready: false,
  activeProjectId: null,
  activeWorktreeId: null,
  expanded: {},
  modal: null,
  modalData: null,
  modalStack: [],
  activePaneIds: {},
  alertCount: 0,
  updateStatus: { phase: 'idle' },

  async init() {
    if (initStarted) return
    initStarted = true
    // These subscriptions intentionally live for the app's lifetime.
    // alertCount is derived in applyState (the alert event always rides along
    // with a state broadcast); the chime listens to onAlert in App.tsx.
    window.orbital.onStateChanged((s) => get().applyState(s))
    window.orbital.onUpdateStatus((status) => set({ updateStatus: status }))
    const state = await window.orbital.getState()
    get().applyState(state)
    set({ ready: true })
    // Seed with whatever the updater already knows (events fired before this
    // renderer loaded — e.g. an update that finished downloading — are gone).
    set({ updateStatus: await window.orbital.updateStatus() })
  },

  applyState(s) {
    const prev = get()
    let activeProjectId = prev.activeProjectId
    if (!activeProjectId || !s.projects.some((p) => p.id === activeProjectId)) {
      activeProjectId = s.projects[0]?.id ?? null
    }

    const projectWorktrees = s.worktrees.filter((w) => w.projectId === activeProjectId)
    let activeWorktreeId = prev.activeWorktreeId
    if (!activeWorktreeId || !projectWorktrees.some((w) => w.id === activeWorktreeId)) {
      // Prefer the root Worktree, else the first Worktree of the active project.
      activeWorktreeId = (projectWorktrees.find((w) => w.kind === 'root') ?? projectWorktrees[0])?.id ?? null
    }

    let expanded = prev.expanded
    if (activeProjectId && expanded[activeProjectId] === undefined) {
      expanded = { ...expanded, [activeProjectId]: true }
    }

    // Keep previous references wherever the content did not change (see shareById).
    set({
      projects: shareById(prev.projects, s.projects),
      worktrees: shareById(prev.worktrees, s.worktrees),
      tasks: shareById(prev.tasks, s.tasks),
      settings: share(prev.settings, s.settings),
      workspace: share(prev.workspace, s.workspace),
      devServers: share(prev.devServers, s.devServers),
      settingUpWorktrees: share(prev.settingUpWorktrees, s.settingUpWorktrees),
      activeProjectId,
      activeWorktreeId,
      expanded,
      alertCount: s.worktrees.filter((w) => w.status === 'needs_attention').length
    })
  },

  setActiveProject(id) {
    const projectWorktrees = get().worktrees.filter((w) => w.projectId === id)
    const activeWorktreeId = (projectWorktrees.find((w) => w.kind === 'root') ?? projectWorktrees[0])?.id ?? null
    set((s) => ({
      activeProjectId: id,
      activeWorktreeId,
      expanded: { ...s.expanded, [id]: true }
    }))
  },

  setActiveWorktree(id) {
    const worktree = get().worktrees.find((w) => w.id === id)
    set({ activeWorktreeId: id, activeProjectId: worktree ? worktree.projectId : get().activeProjectId })
  },

  toggleExpanded(id) {
    set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } }))
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
  }
}))

/* ---- Selectors --------------------------------------------------------- */

export function activeProject(s: Store): Project | undefined {
  return s.projects.find((p) => p.id === s.activeProjectId)
}

export function activeWorktree(s: Store): Worktree | undefined {
  return s.worktrees.find((w) => w.id === s.activeWorktreeId)
}

export function tasksForProject(s: Store, projectId: string): Task[] {
  return s.tasks.filter((t) => t.projectId === projectId)
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
