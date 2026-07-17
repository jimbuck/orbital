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
}

export type Store = Data & UIState & Actions

/** Guards init() against re-entry (React StrictMode double-invokes App's effect). */
let initStarted = false

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

    const expanded = { ...prev.expanded }
    if (activeProjectId && expanded[activeProjectId] === undefined) {
      expanded[activeProjectId] = true
    }

    set({
      projects: s.projects,
      worktrees: s.worktrees,
      tasks: s.tasks,
      settings: s.settings,
      workspace: s.workspace,
      devServers: s.devServers,
      settingUpWorktrees: s.settingUpWorktrees,
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
