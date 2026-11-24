import { useEffect, useRef, useState, type JSX } from 'react'
import { Plus } from 'lucide-react'
import type { TaskStatus } from '@shared/types'

/**
 * The "Add Task" row at the foot of a board cell. Quiet until its cell (a
 * named `group/col`) is hovered, unless `pinned`. Open, it is a title input
 * that creates tasks in that cell: the lane's project and repo (none in the
 * Project lane), the column's status.
 *
 * Enter adds the task and keeps the input open for the next one, so a list
 * can be typed straight in. Escape, or leaving the input, closes it; leaving
 * with a title typed adds that task first.
 *
 * The board owns whether it is open (`editing`), because the board's header
 * button, column buttons, menus and N key open it too.
 */
export default function AddTaskCard({
  projectId,
  repoId,
  status,
  editing,
  onEditing,
  pinned = false
}: {
  projectId: string
  repoId: string | null
  status: TaskStatus
  editing: boolean
  onEditing: (open: boolean) => void
  /** Always visible: the one affordance on an empty board. */
  pinned?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    ref.current?.focus()
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [editing])

  const add = async (): Promise<void> => {
    const title = draft.trim()
    setDraft('')
    if (!title) return
    const task = await window.orbital.createTask(projectId, title, repoId)
    if (status !== 'todo') await window.orbital.updateTask(task.id, { status })
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        aria-label="New task title"
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            // An empty Enter is "done adding".
            if (draft.trim()) void add()
            else onEditing(false)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft('')
            onEditing(false)
          }
        }}
        onBlur={() => {
          void add()
          onEditing(false)
        }}
        placeholder="Task title…"
        className="allow-select w-full rounded-card border border-accent/60 bg-panel px-3 py-[9px] text-[12.5px] font-semibold text-text outline-none placeholder:font-normal placeholder:text-faint"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => onEditing(true)}
      className={`flex w-full items-center gap-1.5 rounded-card px-2 py-[7px] text-left text-[11.5px] font-medium text-faint ${pinned ? '' : 'opacity-0'} outline-none transition-opacity hover:bg-hover hover:text-text-3 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover/col:opacity-100`}
    >
      <Plus size={13} strokeWidth={1.5} className="flex-none" />
      Add Task
    </button>
  )
}
