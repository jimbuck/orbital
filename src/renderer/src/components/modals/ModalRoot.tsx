import { useEffect, useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { useStore } from '@renderer/store'
import {
  TASK_STATUSES,
  taskStatusLabel,
  taskChipClass,
  taskColumnDot,
  taskColumnHeadClass
} from '@renderer/lib/status'
import type { Task, TaskStatus, TaskPatch } from '@shared/types'
import TaskTitleButton from '../panel/TaskTitleButton'
import { TaskTagsDisplay } from '../panel/TaskMeta'
import TaskCardContextMenu from '../panel/TaskCardContextMenu'
import { clampMenuPos, type MenuPos } from '../rail/menu'
import AddTaskCard from '../panel/AddTaskCard'
import Settings from './Settings'
import AddProject from './AddProject'
import NewWorktree from './NewWorktree'
import EditTask from './EditTask'
import About from './About'
import Workspaces from './Workspaces'

/* ============================================================================
 * Shared modal primitives
 *
 * ModalShell and the button / input class strings are defined here (the modal
 * hub) and consumed by the leaf modals via a relative import. Usage is always
 * at render time, so the import graph resolves cleanly.
 * ========================================================================== */

/** Primary (accent) action button. */
export const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-btn px-[18px] py-[9px] text-[12.5px] font-bold ' +
  'bg-accent text-on-accent hover:bg-accent-hover transition-colors no-drag ' +
  'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

/** Secondary / Cancel button. */
export const ghostBtn =
  'inline-flex items-center justify-center gap-2 rounded-btn px-[15px] py-[9px] text-[12.5px] font-semibold ' +
  'bg-hover text-text-2 border border-line-2 hover:bg-panel-2 transition-colors no-drag ' +
  'focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

/** Standard form input shell. */
export const inputBase =
  'w-full rounded-btn bg-bg border border-line-2 px-3 py-[9px] text-[12.5px] text-text-2 ' +
  'placeholder:text-faint focus:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

/** Uppercase section eyebrow. */
export const sectionLabel = 'text-[11px] font-bold uppercase tracking-[0.6px] text-muted'

/** Field caption above an input. */
export const fieldLabel = 'text-[11.5px] font-semibold text-text-3'

interface ModalShellProps {
  title: string
  subtitle?: string
  /** Panel width in px (design specs: 540 / 500). */
  width: number
  /** Minimum panel height in px; the body fills any space beyond its content. */
  minHeight?: number
  /** Extra classes for the scrollable body (e.g. `flex flex-col` to let content fill a tall panel). */
  bodyClassName?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

/**
 * The framed dialog panel: a flex column of header (title + subtitle + X), a
 * scrollable body, and an optional footer. Header and footer stay pinned; only
 * the body scrolls, so a tall panel (via `minHeight`) keeps its actions visible.
 */
export function ModalShell({
  title,
  subtitle,
  width,
  minHeight,
  bodyClassName = '',
  onClose,
  footer,
  children
}: ModalShellProps): React.JSX.Element {
  return (
    <div
      style={{ width, minHeight, maxWidth: '94vw', animation: 'panelIn .16s ease-out' }}
      className="flex max-h-[84vh] flex-col overflow-hidden bg-panel border border-line-strong rounded-modal elev-modal"
    >
      <header className="flex flex-none items-center justify-between px-[18px] py-4 border-b border-soft">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-text">{title}</div>
          {subtitle && <div className="mt-0.5 text-[11.5px] text-dim">{subtitle}</div>}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-7 flex-none place-items-center rounded-[7px] text-muted hover:bg-hover hover:text-text transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className={`min-h-0 flex-1 overflow-y-auto p-[18px] ${bodyClassName}`}>{children}</div>

      {footer && (
        <footer className="flex flex-none items-center justify-end gap-[9px] px-[18px] py-[14px] border-t border-soft">
          {footer}
        </footer>
      )}
    </div>
  )
}

/* ============================================================================
 * Full-board modal ("All tasks") — tasks across all projects, by status.
 * ========================================================================== */

function BoardTaskCard({ task, onDragEnd }: { task: Task; onDragEnd?: () => void }): React.JSX.Element {
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  const openModal = useStore((s) => s.openModal)
  // Look up the card's project the same way TaskCardContextMenu does, so the
  // Create Worktree flow can seed the New Worktree modal with the right project.
  const project = useStore((s) => s.projects.find((p) => p.id === task.projectId))
  // "No linked worktree" mirrors TaskCardContextMenu: a fresh todo with no Worktree
  // yet. If the task already has a matching Worktree, don't offer Create Worktree.
  const hasWorktree = useStore((s) => !!task.worktreeId && s.worktrees.some((w) => w.id === task.worktreeId))
  const showCreateWorktree = task.status === 'todo' && !hasWorktree
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => onDragEnd?.()}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuPos(clampMenuPos(e, 210, 300))
      }}
      className="group cursor-grab rounded-card border border-line bg-bg p-3 active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <TaskTitleButton task={task} className="block text-[12.5px] font-semibold text-text-2" />
        </div>
        <span className={`flex-none rounded-chip px-2 py-0.5 text-[10px] font-bold ${taskChipClass(task.status)}`}>
          {taskStatusLabel(task.status)}
        </span>
      </div>
      <TaskTagsDisplay task={task} />
      {showCreateWorktree && (
        // stopPropagation + a no-op mouseDown keep the click from starting a
        // card drag. openModal now STACKS over the board (see ModalRoot), so
        // New Worktree opens on top and closing it returns here.
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            openModal('newWorktree', { project, task })
          }}
          className="mt-2 inline-flex items-center gap-1 rounded-btn border border-line-2 px-2 py-1 text-[10.5px] font-semibold text-accent hover:bg-hover transition-colors no-drag"
        >
          <Plus size={12} strokeWidth={1.5} />
          Create Worktree
        </button>
      )}
      {menuPos && <TaskCardContextMenu task={task} pos={menuPos} onClose={() => setMenuPos(null)} />}
    </div>
  )
}

function FullBoard(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const tasks = useStore((s) => s.tasks)
  const closeModal = useStore((s) => s.closeModal)
  const [hoverCell, setHoverCell] = useState<string | null>(null)

  // Dropping a card on a cell sets its status (column) and project (lane).
  const dropTask = (taskId: string, projectId: string, status: TaskStatus): void => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    const patch: TaskPatch = {}
    if (task.status !== status) patch.status = status
    if (task.projectId !== projectId) patch.projectId = projectId
    if (Object.keys(patch).length) void window.orbital.updateTask(taskId, patch)
  }

  return (
    <div
      style={{ animation: 'panelIn .16s ease-out' }}
      className="flex h-[86vh] w-[2360px] max-w-[95vw] flex-col overflow-hidden bg-panel border border-line-strong rounded-modal elev-modal"
    >
      <header className="flex flex-none items-center justify-between px-[18px] py-[15px] border-b border-soft">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-text">All tasks across your projects</div>
          <div className="mt-0.5 text-[11.5px] text-dim">
            {projects.length} project{projects.length === 1 ? '' : 's'} · {tasks.length} task
            {tasks.length === 1 ? '' : 's'}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={closeModal}
          className="grid size-7 flex-none place-items-center rounded-[7px] text-muted hover:bg-hover hover:text-text transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-[18px]">
        {projects.length === 0 ? (
          <div className="text-[12px] text-faint">No projects yet.</div>
        ) : (
          <div className="min-w-[820px]">
            {/* Status column headers, offset by the project-label gutter.
                No bottom padding so the header sits flush on the first lane. */}
            <div className="sticky top-0 z-10 flex gap-2 bg-panel">
              <div className="w-[150px] flex-none" />
              {TASK_STATUSES.map((status) => {
                const dot = taskColumnDot(status)
                return (
                  <div
                    key={status}
                    className="flex flex-1 items-center gap-2 rounded-t-col border border-line border-b-0 bg-bg px-3 py-2"
                  >
                    <span className={`size-2 flex-none rounded-full ${dot.className}`} style={dot.style} />
                    <span
                      className={`text-[10.5px] font-bold uppercase tracking-[0.5px] ${taskColumnHeadClass(status)}`}
                    >
                      {taskStatusLabel(status)}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* One swim-lane per project, split by a dashed lane line. */}
            {projects.map((p, i) => (
              <div
                key={p.id}
                className={`flex gap-2 ${i > 0 ? 'border-t border-dashed border-line-strong' : ''}`}
              >
                <div className="flex w-[150px] flex-none items-center gap-2 py-3">
                  <span className="size-[7px] flex-none rounded-full bg-dim" />
                  <span className="truncate text-[12px] font-bold text-text-2" title={p.repoPath}>
                    {p.name}
                  </span>
                </div>
                {TASK_STATUSES.map((status) => {
                  const cell = tasks.filter((t) => t.projectId === p.id && t.status === status)
                  const cellKey = `${p.id}:${status}`
                  const isHover = hoverCell === cellKey
                  return (
                    <div
                      key={status}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (!isHover) setHoverCell(cellKey)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        const id = e.dataTransfer.getData('text/plain')
                        if (id) dropTask(id, p.id, status)
                        setHoverCell(null)
                      }}
                      className={`group/col flex min-h-[88px] flex-1 flex-col gap-2 border-x p-2 transition-colors ${
                        isHover ? 'border-accent/40 bg-accent/[0.06]' : 'border-line bg-bg'
                      }`}
                    >
                      {cell.map((task) => (
                        <BoardTaskCard key={task.id} task={task} onDragEnd={() => setHoverCell(null)} />
                      ))}
                      <AddTaskCard projectId={p.id} status={status} />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================================================================
 * ModalRoot — the single overlay host driven by store.modal.
 * ========================================================================== */

export default function ModalRoot(): React.JSX.Element | null {
  const modalStack = useStore((s) => s.modalStack)
  const closeModal = useStore((s) => s.closeModal)

  // Dismiss on Escape while any modal is open — closeModal() pops just the top
  // layer, so Escape peels the stack back one at a time (task → board → gone).
  useEffect(() => {
    if (modalStack.length === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalStack.length, closeModal])

  if (modalStack.length === 0) return null

  // Render every stack entry as its own overlay layer, deeper layers on top.
  // The backdrop deliberately does NOT dismiss on click: a text-selection drag
  // that starts inside the panel and releases outside would register as a
  // backdrop click and close the modal. Closing is explicit only — the X
  // button, Cancel/Save/Delete actions, or Escape.
  return (
    <>
      {modalStack.map((entry, i) => (
        <div
          key={`${i}:${entry.type}`}
          style={{ animation: 'overlayIn .12s ease-out', zIndex: 50 + i * 10 }}
          className="fixed inset-0 grid place-items-center bg-scrim p-8 no-drag"
        >
          {entry.type === 'settings' && <Settings />}
          {entry.type === 'addProject' && <AddProject />}
          {entry.type === 'newWorktree' && <NewWorktree />}
          {entry.type === 'editTask' && <EditTask />}
          {entry.type === 'board' && <FullBoard />}
          {entry.type === 'about' && <About />}
          {entry.type === 'workspaces' && <Workspaces />}
        </div>
      ))}
    </>
  )
}
