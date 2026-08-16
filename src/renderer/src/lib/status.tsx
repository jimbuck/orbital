import type { JSX } from 'react'
import type { TerminalStatus, TaskStatus } from '@shared/types'

/* ============================================================================
 * Status vocabulary — colors, labels and dot renderings copied from the
 * Orbital design guide ("Worktree status dots" + "Status chip"). Color always
 * means a status; never decorate with it.
 * ========================================================================== */

export function worktreeStatusLabel(s: TerminalStatus): string {
  switch (s) {
    case 'needs_attention':
      return 'needs you'
    case 'working':
      return 'working'
    case 'error':
      return 'error'
    case 'done':
      return 'done'
    default:
      return 'idle'
  }
}

/** Text tint for a Worktree's status label in the rail. */
export function worktreeStatusTextClass(s: TerminalStatus): string {
  switch (s) {
    case 'needs_attention':
      return 'text-amber-2'
    case 'working':
      return 'text-blue'
    case 'error':
      return 'text-red-2'
    case 'done':
      return 'text-green-2'
    default:
      return 'text-dim'
  }
}

/**
 * The glanceable status dot for a Worktree or terminal, rendered exactly as the
 * design's legend specifies (pulsing amber, accent spinner, red glow, hollow
 * green ring, dim dot).
 */
export function StatusDot({ status, className = '' }: { status: TerminalStatus; className?: string }): JSX.Element {
  switch (status) {
    case 'needs_attention':
      return (
        <span className={`relative inline-block size-2 ${className}`}>
          <span className="absolute inset-0 rounded-full bg-amber animate-pulse-dot" />
        </span>
      )
    case 'working':
      return (
        <span
          className={`inline-block size-[11px] rounded-full border-[1.6px] border-accent border-t-transparent animate-spin ${className}`}
        />
      )
    case 'error':
      return (
        <span
          className={`inline-block size-2 rounded-full bg-red shadow-[0_0_7px_rgba(255,107,107,.5)] ${className}`}
        />
      )
    case 'done':
      return <span className={`inline-block size-[9px] rounded-full border-[1.6px] border-green ${className}`} />
    default:
      return <span className={`inline-block size-[7px] rounded-full bg-dim ${className}`} />
  }
}

/* ---- Tasks -------------------------------------------------------------- */

export const TASK_STATUSES: TaskStatus[] = ['draft', 'todo', 'in_progress', 'ready_for_review', 'done']

export function taskStatusLabel(s: TaskStatus): string {
  switch (s) {
    case 'draft':
      return 'Draft'
    case 'in_progress':
      return 'In progress'
    case 'ready_for_review':
      return 'Review'
    case 'done':
      return 'Done'
    default:
      return 'Todo'
  }
}

/** Chip classes for a task status (text + background tint), per the recipe. */
export function taskChipClass(s: TaskStatus): string {
  switch (s) {
    case 'draft':
      return 'text-purple bg-purple/15'
    case 'in_progress':
      return 'text-blue bg-accent/15'
    case 'ready_for_review':
      return 'text-amber-2 bg-amber/15'
    case 'done':
      return 'text-green-2 bg-green/15'
    default:
      return 'text-muted bg-hover'
  }
}

/** Column dot styling for the board view (filled vs. hollow). */
export function taskColumnDot(s: TaskStatus): { className: string; style: React.CSSProperties } {
  switch (s) {
    case 'draft':
      return { className: 'border-[1.6px] border-purple bg-transparent', style: {} }
    case 'in_progress':
      return { className: 'bg-accent', style: {} }
    case 'ready_for_review':
      return { className: 'bg-amber', style: {} }
    case 'done':
      return { className: 'border-[1.6px] border-green bg-transparent', style: {} }
    default:
      return { className: 'bg-dim', style: {} }
  }
}

export function taskColumnHeadClass(s: TaskStatus): string {
  switch (s) {
    case 'draft':
      return 'text-purple'
    case 'in_progress':
      return 'text-blue'
    case 'ready_for_review':
      return 'text-amber-2'
    case 'done':
      return 'text-green-2'
    default:
      return 'text-muted'
  }
}
