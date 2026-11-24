import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useStore } from '@renderer/store'
import Settings from './Settings'
import AddRepo from './AddRepo'
import NewWorktree from './NewWorktree'
import EditTask from './EditTask'
import TaskBoard from './TaskBoard'
import ArchivedTasks from './ArchivedTasks'
import About from './About'
import Workspaces from './Workspaces'
import CommitHistory from './CommitHistory'

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
      role="dialog"
      aria-modal="true"
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
 * ModalRoot — the single overlay host driven by store.modal.
 * ========================================================================== */

export default function ModalRoot(): React.JSX.Element | null {
  const modalStack = useStore((s) => s.modalStack)
  const closeModal = useStore((s) => s.closeModal)

  // Dismiss on Escape while any modal is open — closeModal() pops just the top
  // layer, so Escape peels the stack back one at a time (task → board — gone).
  // A control inside the modal that handles Escape itself (an inline input
  // cancelling its edit, a menu closing) calls preventDefault, and that press
  // must not ALSO close the modal underneath it and drop every unsaved edit.
  useEffect(() => {
    if (modalStack.length === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalStack.length, closeModal])

  if (modalStack.length === 0) return null

  // Render every stack entry as its own overlay layer, deeper layers on top.
  // The backdrop deliberately does NOT dismiss on click: a text-selection drag
  // that starts inside the panel and releases outside would register as a
  // backdrop click and close the modal. Closing is explicit only — the X
  // button, Cancel/Save/Archive actions, or Escape.
  return (
    <>
      {modalStack.map((entry, i) => (
        <div
          key={`${i}:${entry.type}`}
          style={{ animation: 'overlayIn .12s ease-out', zIndex: 50 + i * 10 }}
          className="fixed inset-0 grid place-items-center bg-scrim p-8 no-drag"
        >
          {entry.type === 'settings' && <Settings />}
          {entry.type === 'addRepo' && <AddRepo />}
          {entry.type === 'newWorktree' && <NewWorktree />}
          {entry.type === 'editTask' && <EditTask />}
          {entry.type === 'board' && <TaskBoard />}
          {entry.type === 'archivedTasks' && <ArchivedTasks />}
          {entry.type === 'about' && <About />}
          {entry.type === 'workspaces' && <Workspaces />}
          {entry.type === 'commitHistory' && <CommitHistory />}
        </div>
      ))}
    </>
  )
}
