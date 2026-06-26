import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useStore } from '@renderer/store'
import {
  TASK_STATUSES,
  taskStatusLabel,
  taskChipClass,
  taskColumnDot,
  taskColumnHeadClass
} from '@renderer/lib/status'
import type { Task } from '@shared/types'
import Settings from './Settings'
import AddWorkspace from './AddWorkspace'
import NewFlight from './NewFlight'

/* ============================================================================
 * Shared modal primitives
 *
 * ModalShell and the button / input class strings are defined here (the modal
 * hub) and consumed by the leaf modals via a relative import. Usage is always
 * at render time, so the import graph resolves cleanly.
 * ========================================================================== */

/** Stop a click inside the panel from bubbling up to the backdrop dismiss. */
export function stopBubble(e: React.MouseEvent): void {
  e.stopPropagation()
}

/** Primary (accent) action button. */
export const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-btn px-[18px] py-[9px] text-[12.5px] font-bold ' +
  'bg-accent text-[#06122e] hover:bg-[#6a9dff] transition-colors no-drag ' +
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
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

/** The framed dialog panel: header (title + subtitle + X), scrollable body, footer. */
export function ModalShell({ title, subtitle, width, onClose, footer, children }: ModalShellProps): React.JSX.Element {
  return (
    <div
      onClick={stopBubble}
      style={{ width, maxWidth: '94vw', animation: 'panelIn .16s ease-out' }}
      className="max-h-[84vh] overflow-y-auto bg-panel border border-line-strong rounded-modal shadow-[0_24px_70px_rgba(0,0,0,.6)]"
    >
      <header className="flex items-center justify-between px-[18px] py-4 border-b border-soft">
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

      <div className="p-[18px]">{children}</div>

      {footer && (
        <footer className="flex items-center justify-end gap-[9px] px-[18px] py-[14px] border-t border-soft">
          {footer}
        </footer>
      )}
    </div>
  )
}

/* ============================================================================
 * Full-board modal ("All tasks") — tasks for the active workspace, by status.
 * ========================================================================== */

function BoardTaskCard({ task }: { task: Task }): React.JSX.Element {
  return (
    <div className="rounded-card bg-bg border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-text-2">{task.title}</span>
        <span className={`flex-none rounded-chip px-2 py-0.5 text-[10px] font-bold ${taskChipClass(task.status)}`}>
          {taskStatusLabel(task.status)}
        </span>
      </div>
      {task.description && <p className="mt-1.5 text-[11px] leading-relaxed text-dim line-clamp-2">{task.description}</p>}
    </div>
  )
}

function FullBoard(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks)
  const closeModal = useStore((s) => s.closeModal)

  return (
    <div
      onClick={stopBubble}
      style={{ animation: 'panelIn .16s ease-out' }}
      className="flex h-[86vh] w-[1180px] max-w-[95vw] flex-col overflow-hidden bg-panel border border-line-strong rounded-modal shadow-[0_24px_70px_rgba(0,0,0,.6)]"
    >
      <header className="flex flex-none items-center justify-between px-[18px] py-[15px] border-b border-soft">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-text">All tasks across your workspaces</div>
          <div className="mt-0.5 text-[11.5px] text-dim">
            {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'} · {tasks.length} task
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
        {workspaces.length === 0 ? (
          <div className="text-[12px] text-faint">No workspaces yet.</div>
        ) : (
          <div className="min-w-[820px]">
            {/* Status column headers, offset by the workspace-label gutter. */}
            <div className="sticky top-0 z-10 mb-0 flex gap-2 bg-panel pb-2">
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

            {/* One swim-lane per workspace, split by a dashed lane line. */}
            {workspaces.map((ws, i) => (
              <div
                key={ws.id}
                className={`flex gap-2 ${i > 0 ? 'border-t border-dashed border-line-strong' : ''}`}
              >
                <div className="flex w-[150px] flex-none items-center gap-2 py-3">
                  <span className="size-[7px] flex-none rounded-full bg-dim" />
                  <span className="truncate text-[12px] font-bold text-text-2" title={ws.repoPath}>
                    {ws.name}
                  </span>
                </div>
                {TASK_STATUSES.map((status) => {
                  const cell = tasks.filter((t) => t.workspaceId === ws.id && t.status === status)
                  return (
                    <div
                      key={status}
                      className="flex min-h-[88px] flex-1 flex-col gap-2 border-x border-line bg-bg p-2"
                    >
                      {cell.map((task) => (
                        <BoardTaskCard key={task.id} task={task} />
                      ))}
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
  const modal = useStore((s) => s.modal)
  const closeModal = useStore((s) => s.closeModal)

  // Dismiss on Escape while any modal is open.
  useEffect(() => {
    if (!modal) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal, closeModal])

  if (!modal) return null

  return (
    <div
      onClick={closeModal}
      style={{ animation: 'overlayIn .12s ease-out' }}
      className="fixed inset-0 z-50 grid place-items-center bg-[#05070b]/70 p-8 no-drag"
    >
      {modal === 'settings' && <Settings />}
      {modal === 'addWorkspace' && <AddWorkspace />}
      {modal === 'newFlight' && <NewFlight />}
      {modal === 'board' && <FullBoard />}
    </div>
  )
}
