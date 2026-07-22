import type { JSX } from 'react'
import { useStore } from '@renderer/store'
import type { Task } from '@shared/types'

/**
 * A task title rendered as a button that opens the editable task modal. Stops
 * pointer events from bubbling so it works inside clickable / draggable task
 * cards without starting a drag.
 */
export default function TaskTitleButton({ task, className }: { task: Task; className: string }): JSX.Element {
  const openModal = useStore((s) => s.openModal)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        openModal('editTask', { task })
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title="Open task"
      className={`w-full cursor-pointer text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/60 rounded ${className}`}
    >
      <span className="font-mono font-normal text-faint">#{task.seq}</span> {task.title}
    </button>
  )
}
