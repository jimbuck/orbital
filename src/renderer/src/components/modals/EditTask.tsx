import { useState, type JSX, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { useStore } from '@renderer/store'
import { TASK_STATUSES, taskStatusLabel, taskColumnDot, taskColumnHeadClass } from '@renderer/lib/status'
import type { Task, TaskStatus, TaskPatch } from '@shared/types'
import { ModalShell, primaryBtn, ghostBtn, inputBase, fieldLabel } from './ModalRoot'

/** modalData payload for the Edit Task modal. */
interface EditTaskData {
  task?: Task
}

/** True when two tag lists differ in order or membership. */
function tagsChanged(a: string[], b: string[]): boolean {
  return a.length !== b.length || a.some((t, i) => t !== b[i])
}

/**
 * Edit every field of a task in one place — opened by clicking a card's title.
 * Fields are edited into local state and committed together on Save (a single
 * updateTask patch of only what changed); Delete removes the task after an
 * armed confirm.
 */
export default function EditTask(): JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const data = useStore((s) => s.modalData) as EditTaskData | null
  const task = data?.task

  const [title, setTitle] = useState(task?.title ?? '')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo')
  const [description, setDescription] = useState(task?.description ?? '')
  const [tags, setTags] = useState<string[]>(task?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The card that opened us passed a task snapshot; if it's gone, say so.
  if (!task) {
    return (
      <ModalShell
        title="Edit task"
        width={520}
        onClose={closeModal}
        footer={
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Close
          </button>
        }
      >
        <p className="text-[12.5px] text-text-3">This task is no longer available.</p>
      </ModalShell>
    )
  }

  // Fold the pending tag-input text into a fresh tag set (comma-split, deduped).
  const withPendingTags = (): string[] => {
    const fresh = tagDraft
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t && !tags.includes(t))
    return fresh.length ? [...tags, ...fresh] : tags
  }

  const addTags = (): void => {
    setTags(withPendingTags())
    setTagDraft('')
  }

  const onTagKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTags()
    } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
      setTags(tags.slice(0, -1))
    }
  }

  const save = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) {
      setError('Title is required.')
      return
    }
    const nextTags = withPendingTags()
    const nextDesc = description.trim()
    const patch: TaskPatch = {}
    if (trimmed !== task.title) patch.title = trimmed
    if (status !== task.status) patch.status = status
    if (nextDesc !== task.description) patch.description = nextDesc
    if (tagsChanged(nextTags, task.tags)) patch.tags = nextTags

    setBusy(true)
    setError(null)
    try {
      if (Object.keys(patch).length) await window.orbital.updateTask(task.id, patch)
      closeModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the task.')
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.orbital.deleteTask(task.id)
      closeModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the task.')
      setBusy(false)
    }
  }

  const onTitleKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    }
  }

  return (
    <ModalShell
      title="Edit task"
      width={520}
      onClose={closeModal}
      footer={
        <>
          {deleteArmed ? (
            <button
              type="button"
              className={`${ghostBtn} mr-auto border-red/40 text-red-2`}
              onClick={() => void remove()}
              disabled={busy}
            >
              Confirm delete
            </button>
          ) : (
            <button
              type="button"
              className={`${ghostBtn} mr-auto`}
              onClick={() => setDeleteArmed(true)}
              disabled={busy}
            >
              Delete
            </button>
          )}
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={() => void save()} disabled={busy || !title.trim()}>
            Save
          </button>
        </>
      }
    >
      <label className={fieldLabel} htmlFor="et-title">
        Title
      </label>
      <input
        id="et-title"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onTitleKey}
        aria-invalid={Boolean(error && !title.trim())}
        className={`mt-1.5 ${inputBase}`}
      />

      <div className={`${fieldLabel} mt-4`}>Status</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {TASK_STATUSES.map((s) => {
          const dot = taskColumnDot(s)
          const active = s === status
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`inline-flex items-center gap-1.5 rounded-btn border px-2.5 py-1.5 text-[11.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
                active ? 'border-accent/50 bg-accent/[0.10]' : 'border-line-2 bg-bg hover:bg-hover'
              }`}
            >
              <span className={`flex-none size-[7px] rounded-full ${dot.className}`} style={dot.style} />
              <span className={taskColumnHeadClass(s)}>{taskStatusLabel(s)}</span>
            </button>
          )
        })}
      </div>

      <label className={`${fieldLabel} mt-4 block`} htmlFor="et-desc">
        Description <span className="font-normal text-faint">· optional</span>
      </label>
      <textarea
        id="et-desc"
        value={description}
        rows={4}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Add more detail…"
        className={`mt-1.5 resize-none leading-snug ${inputBase}`}
      />

      <div className={`${fieldLabel} mt-4`}>
        Tags <span className="font-normal text-faint">· optional</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-btn border border-line-2 bg-bg px-2.5 py-2 focus-within:border-accent/40">
        {tags.map((tag) => (
          <span
            key={tag}
            className="group/tag inline-flex items-center gap-1 rounded-chip border border-line-2 bg-panel-2 px-2 py-0.5 text-[11px] font-semibold text-text-3"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => setTags(tags.filter((t) => t !== tag))}
              className="rounded text-faint outline-none hover:text-red-2 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <X size={11} strokeWidth={2} />
            </button>
          </span>
        ))}
        <input
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={onTagKey}
          onBlur={addTags}
          placeholder={tags.length ? 'Add a tag…' : 'tag, tag'}
          className="min-w-[90px] flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-faint"
        />
        {tagDraft.trim() && (
          <button
            type="button"
            aria-label="Add tag"
            onClick={addTags}
            className="inline-flex items-center gap-0.5 rounded-chip border border-dashed border-line-2 px-1.5 py-0.5 text-[10px] font-semibold text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Plus size={10} strokeWidth={2} />
            add
          </button>
        )}
      </div>

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
