import type { JSX } from 'react'
import type { Task } from '@shared/types'

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
