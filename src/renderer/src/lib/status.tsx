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
 * Orbital's loading spinner: a comet, a bright head trailing a tail that fades
 * out behind it (the `.spinner` recipe in app.css). Sized by font-size and
 * coloured by the current text colour, so pass `text-[11px] text-accent` or
 * let it inherit the button's ink. Replaces the generic three-quarter ring
 * everywhere something is in flight.
 */
export function Spinner({ className = '' }: { className?: string }): JSX.Element {
  return <span aria-hidden className={`spinner animate-spin ${className}`} />
}

/**
 * The glanceable status dot for a Worktree or terminal. One small orbital
 * legend: a comet while working, an amber beacon radiating a ring when it
 * needs you, a slowly glowing red core inside an exclusion ring on error, a
 * heavy green ring with a soft halo when done, and a thin grey ring at rest.
 *
 * Every variant is drawn inside the same 10px box with the same outer
 * diameter, so the marks line up down the rail and across the tab strip and
 * only their weight, colour and motion differ. Anything that reaches past the
 * box (the beacon's ring, the glows) is absolutely positioned and overflows
 * without shifting layout.
 */
export function StatusDot({ status, className = '' }: { status: TerminalStatus; className?: string }): JSX.Element {
  const box = `relative inline-block size-[10px] flex-none rounded-full ${className}`
  switch (status) {
    case 'needs_attention':
      return (
        <span className={`${box} bg-amber`}>
          <span className="absolute -inset-px rounded-full border-[1.5px] border-amber animate-beacon" />
        </span>
      )
    case 'working':
      // text-working, not text-accent: the workspace accent can be green, red
      // or amber, which would make "working" read as another status.
      return <Spinner className={`text-[10px] text-working ${className}`} />
    case 'error':
      return (
        <span className={`${box} border border-red/55`}>
          <span className="absolute inset-[2px] rounded-full bg-red animate-hot-core" />
        </span>
      )
    case 'done':
      return <span className={`${box} border-[2.4px] border-green animate-glow-ring`} />
    default:
      return <span className={`${box} border border-dim`} />
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
