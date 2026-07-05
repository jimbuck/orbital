import { useEffect, useState, type JSX } from 'react'
import { Check, Trash2, X } from 'lucide-react'

/**
 * Hover-revealed delete affordance for a task card, with a two-step armed
 * confirm (the git panel's discard pattern): the first click arms it, ✓
 * deletes, ✗ or a 4s timeout disarms. The parent card needs the `group`
 * class for the hover reveal.
 */
export default function TaskDeleteButton({ taskId }: { taskId: string }): JSX.Element {
  const [armed, setArmed] = useState(false)

  // An armed delete disarms itself if not confirmed promptly.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  if (armed) {
    return (
      <span className="flex flex-none items-center gap-1">
        <span className="text-[10px] font-bold text-red-2">Delete?</span>
        <button
          type="button"
          title="Confirm — delete this task"
          onClick={() => void window.orbital.deleteTask(taskId)}
          className="grid size-[18px] place-items-center rounded text-red-2 outline-none hover:text-red focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Check size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          title="Cancel"
          onClick={() => setArmed(false)}
          className="grid size-[18px] place-items-center rounded text-faint outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      title="Delete task"
      aria-label="Delete task"
      onClick={() => setArmed(true)}
      className="grid size-[18px] flex-none place-items-center rounded text-faint opacity-0 outline-none transition-opacity hover:text-red-2 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100"
    >
      <Trash2 size={12} strokeWidth={1.5} />
    </button>
  )
}
