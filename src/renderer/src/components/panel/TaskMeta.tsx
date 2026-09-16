import type { JSX } from 'react'
import { Bot } from 'lucide-react'
import type { Task, TaskCreator } from '@shared/types'

/** Human wording for who filed a task. */
export function taskCreatorLabel(createdBy: TaskCreator | null): string {
  return createdBy === 'agent' ? 'an agent' : createdBy === 'user' ? 'you' : 'unknown'
}

/** A unix-ms timestamp in the user's locale, date and time. */
export function formatTaskTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/**
 * The provenance line for a task: who filed it and when, and when it last
 * changed. Rendered as plain text so the edit modal and tooltips share one
 * wording.
 */
export function taskProvenance(task: Task): string {
  return `Filed by ${taskCreatorLabel(task.createdBy)} · ${formatTaskTime(task.createdAt)} · updated ${formatTaskTime(task.updatedAt)}`
}

/**
 * A small robot mark on cards for tasks an agent filed from the CLI, so a
 * glance at the tracker tells apart work the human queued from work the agents
 * queued for the human. User-filed (and legacy, untracked) tasks show nothing.
 */
export function TaskCreatorMark({ task }: { task: Task }): JSX.Element | null {
  if (task.createdBy !== 'agent') return null
  return (
    <span
      className="flex-none inline-flex items-center text-faint"
      title={taskProvenance(task)}
      aria-label="Filed by an agent"
      role="img"
    >
      <Bot size={12} strokeWidth={2} />
    </span>
  )
}

/**
 * Read-only tag chips shown on a task card. Editing tags (and every other task
 * field) lives in the edit-task modal, opened by clicking the card title —
 * cards themselves only display.
 */
export function TaskTagsDisplay({ task }: { task: Task }): JSX.Element | null {
  if (task.tags.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {task.tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-chip border border-line-2 bg-panel-2 px-[6px] py-px text-[9.5px] font-semibold text-text-3"
        >
          {tag}
        </span>
      ))}
    </div>
  )
}
