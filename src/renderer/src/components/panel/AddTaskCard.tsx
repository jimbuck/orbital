import { useEffect, useRef, useState, type JSX } from 'react'
import { Plus } from 'lucide-react'
import type { TaskStatus } from '@shared/types'

/**
 * Ghost "Add Task" card at the foot of a board column. Invisible until its
 * column (a named `group/col`) is hovered; clicking swaps in an inline title
 * input that creates a task directly in that column's status.
 */
export default function AddTaskCard({
  projectId,
  status
}: {
  projectId: string
  status: TaskStatus
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  const commit = async (): Promise<void> => {
    const title = draft.trim()
    setDraft('')
    setEditing(false)
    if (!title) return
    const task = await window.orbital.createTask(projectId, title)
    if (status !== 'todo') await window.orbital.updateTask(task.id, { status })
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft('')
            setEditing(false)
          }
        }}
        onBlur={() => void commit()}
        placeholder="Task title…"
        className="allow-select w-full rounded-[9px] border border-accent/60 bg-bg px-2 py-2 text-[11.5px] text-text outline-none placeholder:text-faint"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="flex items-center justify-center gap-1.5 rounded-[9px] border border-dashed border-line-2 px-2 py-2 text-[11px] font-medium text-faint opacity-0 outline-none transition-opacity hover:border-line-strong hover:text-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover/col:opacity-100"
    >
      <Plus size={12} strokeWidth={1.5} className="flex-none" />
      Add Task
    </button>
  )
}
