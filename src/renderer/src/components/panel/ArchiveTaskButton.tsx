import type { JSX } from 'react'
import { Trash2 } from 'lucide-react'
import { fireAndForget } from '@renderer/lib/bridge'
import type { Task } from '@shared/types'

/**
 * The trash button on a done task's card: archives it in one click, without
 * opening the task. Archiving is reversible (the board's Archived view brings a
 * task back), so there is no confirm. Stops pointer events like
 * {@link TaskTitleButton}, so it works inside draggable board cards.
 */
export default function ArchiveTaskButton({ task }: { task: Task }): JSX.Element {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        fireAndForget(window.orbital.archiveTask(task.id))
      }}
      title="Archive task"
      aria-label={`Archive task #${task.seq}`}
      className="inline-flex size-[22px] flex-none items-center justify-center rounded-full text-faint outline-none transition hover:bg-hover hover:text-red-2 focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Trash2 size={12} strokeWidth={1.5} />
    </button>
  )
}
