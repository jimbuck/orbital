import { create } from 'zustand'
import type { AppState, Workspace, Flight, Task, Settings } from '@shared/types'

export type ModalType = 'settings' | 'addWorkspace' | 'newFlight' | 'board' | 'about' | null
export type TaskView = 'list' | 'board'

interface UIState {
  ready: boolean
  activeWorkspaceId: string | null
  activeFlightId: string | null
  expanded: Record<string, boolean>
  modal: ModalType
  /** Free-form payload for the open modal (e.g. the workspace a New Flight targets). */
  modalData: unknown
  taskView: TaskView
  /** Count of Flights currently needing attention (drives the title-bar banner). */
  alertCount: number
}

interface Data {
  workspaces: Workspace[]
  flights: Flight[]
  tasks: Task[]
  settings: Settings | null
}

interface Actions {
  init: () => Promise<void>
  applyState: (s: AppState) => void
  refresh: () => Promise<void>
  setActiveWorkspace: (id: string) => void
  setActiveFlight: (id: string) => void
  toggleExpanded: (id: string) => void
  setExpanded: (id: string, value: boolean) => void
  openModal: (type: ModalType, data?: unknown) => void
  closeModal: () => void
  setTaskView: (v: TaskView) => void
  setAlertCount: (n: number) => void
}

export type Store = Data & UIState & Actions

export const useStore = create<Store>((set, get) => ({
  // data
  workspaces: [],
  flights: [],
  tasks: [],
  settings: null,

  // ui
  ready: false,
  activeWorkspaceId: null,
  activeFlightId: null,
  expanded: {},
  modal: null,
  modalData: null,
  taskView: 'list',
  alertCount: 0,

  async init() {
    const state = await window.orbital.getState()
    get().applyState(state)
    set({ ready: true })
    window.orbital.onStateChanged((s) => get().applyState(s))
    window.orbital.onAlert((evt) => set({ alertCount: evt.count }))
  },

  applyState(s) {
    const prev = get()
    let activeWorkspaceId = prev.activeWorkspaceId
    if (!activeWorkspaceId || !s.workspaces.some((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = s.workspaces[0]?.id ?? null
    }

    const wsFlights = s.flights.filter((f) => f.workspaceId === activeWorkspaceId)
    let activeFlightId = prev.activeFlightId
    if (!activeFlightId || !wsFlights.some((f) => f.id === activeFlightId)) {
      // Prefer the root Flight, else the first Flight of the active workspace.
      activeFlightId = (wsFlights.find((f) => f.kind === 'root') ?? wsFlights[0])?.id ?? null
    }

    const expanded = { ...prev.expanded }
    if (activeWorkspaceId && expanded[activeWorkspaceId] === undefined) {
      expanded[activeWorkspaceId] = true
    }

    set({
      workspaces: s.workspaces,
      flights: s.flights,
      tasks: s.tasks,
      settings: s.settings,
      activeWorkspaceId,
      activeFlightId,
      expanded,
      alertCount: s.flights.filter((f) => f.status === 'needs_attention').length
    })
  },

  async refresh() {
    get().applyState(await window.orbital.getState())
  },

  setActiveWorkspace(id) {
    const wsFlights = get().flights.filter((f) => f.workspaceId === id)
    const activeFlightId = (wsFlights.find((f) => f.kind === 'root') ?? wsFlights[0])?.id ?? null
    set((s) => ({
      activeWorkspaceId: id,
      activeFlightId,
      expanded: { ...s.expanded, [id]: true }
    }))
  },

  setActiveFlight(id) {
    const flight = get().flights.find((f) => f.id === id)
    set({ activeFlightId: id, activeWorkspaceId: flight ? flight.workspaceId : get().activeWorkspaceId })
  },

  toggleExpanded(id) {
    set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } }))
  },

  setExpanded(id, value) {
    set((s) => ({ expanded: { ...s.expanded, [id]: value } }))
  },

  openModal(type, data) {
    set({ modal: type, modalData: data ?? null })
  },

  closeModal() {
    set({ modal: null, modalData: null })
  },

  setTaskView(v) {
    set({ taskView: v })
  },

  setAlertCount(n) {
    set({ alertCount: n })
  }
}))

/* ---- Selectors --------------------------------------------------------- */

export function activeWorkspace(s: Store): Workspace | undefined {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)
}

export function activeFlight(s: Store): Flight | undefined {
  return s.flights.find((f) => f.id === s.activeFlightId)
}

export function flightsForWorkspace(s: Store, workspaceId: string): Flight[] {
  return s.flights.filter((f) => f.workspaceId === workspaceId)
}

export function tasksForWorkspace(s: Store, workspaceId: string): Task[] {
  return s.tasks.filter((t) => t.workspaceId === workspaceId)
}
