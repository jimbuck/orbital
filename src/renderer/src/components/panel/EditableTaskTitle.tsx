import { useEffect, useRef, useState, type JSX } from 'react'
import type { Task } from '@shared/types'

/**
 * A task title that turns into an inline text field on double-click. Commits on
 * Enter or blur (via updateTask), cancels on Escape. Stops pointer/key events
 * from bubbling so it works inside clickable / draggable task cards.
 */
export default function EditableTaskTitle({ task, className }: { task: Task; className: string }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) ref.current?.select()
  }, [editing])

  const commit = (): void => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== task.title) void window.orbital.updateTask(task.id, { title: next })
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        onBlur={commit}
        className={`allow-select w-full rounded border border-accent/60 bg-bg px-1 py-0.5 text-text outline-none ${className}`}
      />
    )
  }

  return (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(task.title)
        setEditing(true)
      }}
      title="Double-click to rename"
      className={`cursor-text ${className}`}
    >
      {task.title}
    </span>
  )
}
