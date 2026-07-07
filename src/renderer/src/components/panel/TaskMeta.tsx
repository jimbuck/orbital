import { useEffect, useRef, useState, type JSX } from 'react'
import { Plus, X } from 'lucide-react'
import type { Task } from '@shared/types'

/**
 * Secondary task fields shown under the title on task cards: an editable
 * description (double-click to edit, "Add description…" affordance appears on
 * card hover when empty) and a row of tag chips with inline add/remove. Both
 * commit through updateTask and stop pointer events from bubbling so they work
 * inside clickable / draggable cards.
 */

export function EditableTaskDescription({ task }: { task: Task }): JSX.Element | null {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.description)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) ref.current?.select()
  }, [editing])

  const commit = (): void => {
    const next = draft.trim()
    setEditing(false)
    if (next !== task.description) void window.orbital.updateTask(task.id, { description: next })
  }

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        onBlur={commit}
        className="allow-select mt-1.5 w-full resize-none rounded border border-accent/60 bg-bg px-1 py-0.5 text-[11px] leading-snug text-text-2 outline-none"
      />
    )
  }

  if (!task.description) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setDraft('')
          setEditing(true)
        }}
        className="mt-1 hidden w-fit rounded text-[10.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:block"
      >
        Add description…
      </button>
    )
  }

  return (
    <p
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(task.description)
        setEditing(true)
      }}
      title="Double-click to edit description"
      className="mt-1 cursor-text whitespace-pre-wrap text-[11px] leading-snug text-text-3"
    >
      {task.description}
    </p>
  )
}

export function TaskTags({ task }: { task: Task }): JSX.Element | null {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) ref.current?.focus()
  }, [adding])

  const commit = (): void => {
    const fresh = draft
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t && !task.tags.includes(t))
    setAdding(false)
    setDraft('')
    if (fresh.length > 0) void window.orbital.updateTask(task.id, { tags: [...task.tags, ...fresh] })
  }

  const removeTag = (tag: string): void => {
    void window.orbital.updateTask(task.id, { tags: task.tags.filter((t) => t !== tag) })
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {task.tags.map((tag) => (
        <span
          key={tag}
          className="group/tag inline-flex items-center gap-0.5 rounded-chip border border-line-2 bg-panel-2 px-[6px] py-px text-[9.5px] font-semibold text-text-3"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={(e) => {
              e.stopPropagation()
              removeTag(tag)
            }}
            className="hidden rounded text-faint outline-none hover:text-red-2 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover/tag:block"
          >
            <X size={9} strokeWidth={2} />
          </button>
        </span>
      ))}

      {adding ? (
        <input
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setAdding(false)
              setDraft('')
            }
          }}
          onBlur={commit}
          placeholder="tag, tag"
          className="allow-select w-20 rounded border border-accent/60 bg-bg px-1 py-px text-[10px] text-text outline-none placeholder:text-faint"
        />
      ) : (
        <button
          type="button"
          aria-label="Add tag"
          onClick={(e) => {
            e.stopPropagation()
            setAdding(true)
          }}
          className={`items-center gap-0.5 rounded-chip border border-dashed border-line-2 px-[5px] py-px text-[9.5px] font-semibold text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60 ${
            task.tags.length > 0 ? 'inline-flex' : 'hidden group-hover:inline-flex'
          }`}
        >
          <Plus size={9} strokeWidth={2} />
          tag
        </button>
      )}
    </div>
  )
}
