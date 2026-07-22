import { useMemo, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { marked } from 'marked'
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
  const allTasks = useStore((s) => s.tasks)
  const task = data?.task

  const [title, setTitle] = useState(task?.title ?? '')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo')
  const [description, setDescription] = useState(task?.description ?? '')
  // Description is stored as raw markdown; this toggles between the raw editor
  // and a rendered preview so users can author markdown and see it formatted.
  const [descMode, setDescMode] = useState<'write' | 'preview'>('write')
  const [tags, setTags] = useState<string[]>(task?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Recently-used tags to suggest, so users reuse existing tags instead of
  // retyping and creating near-duplicates. Drawn from other tasks in the same
  // project, ordered by how recently a task carrying the tag was touched.
  // Declared before the `if (!task)` early return to keep hook order stable;
  // guarded to return [] when there's no task to edit.
  const tagSuggestions = useMemo<string[]>(() => {
    if (!task) return []
    const selected = new Set(tags)
    const draft = tagDraft.trim().toLowerCase()
    // For each tag, remember the most recent updatedAt of a task that carries it.
    const recency = new Map<string, number>()
    for (const t of allTasks) {
      if (t.projectId !== task.projectId) continue
      for (const tag of t.tags) {
        if (selected.has(tag)) continue
        if (draft && !tag.toLowerCase().includes(draft)) continue
        const prev = recency.get(tag)
        if (prev === undefined || t.updatedAt > prev) recency.set(tag, t.updatedAt)
      }
    }
    return [...recency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag]) => tag)
  }, [allTasks, tags, tagDraft, task])

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

  // Add a clicked suggestion. Dedupe defensively (suggestions already exclude
  // selected tags) and clear the draft, since the draft was only there to filter
  // the suggestion list the user just picked from.
  const addSuggestion = (tag: string): void => {
    if (!tags.includes(tag)) setTags([...tags, tag])
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

  // The preview is injected via dangerouslySetInnerHTML, so a raw <a> click would
  // navigate the whole renderer SPA. Intercept anchor clicks, keep the SPA intact,
  // and hand the URL to the OS browser instead.
  const onPreviewClick = (e: MouseEvent<HTMLDivElement>): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    const href = anchor?.getAttribute('href')
    if (!href) return
    e.preventDefault()
    void window.orbital.openExternal(href)
  }

  return (
    <ModalShell
      title={`Edit task #${task.seq}`}
      width={1040}
      minHeight={760}
      bodyClassName="flex flex-col"
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
      <div className="flex min-h-0 flex-1 flex-col">
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

        <div className="mt-4 flex items-center justify-between gap-2">
          <label className={`${fieldLabel} block`} htmlFor="et-desc">
            Description <span className="font-normal text-faint">· optional</span>{' '}
            <span className="font-normal text-faint">· markdown</span>
          </label>
          {/* Write / Preview segmented toggle — mirrors the Status button styling
              (active vs inactive) but sized down to read as small tabs. */}
          <div className="flex gap-1">
            {(['write', 'preview'] as const).map((mode) => {
              const active = descMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDescMode(mode)}
                  className={`rounded-btn border px-2 py-0.5 text-[11px] font-semibold capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
                    active ? 'border-accent/50 bg-accent/[0.10]' : 'border-line-2 bg-bg hover:bg-hover'
                  }`}
                >
                  {mode}
                </button>
              )
            })}
          </div>
        </div>
        {descMode === 'write' ? (
          <textarea
            id="et-desc"
            value={description}
            rows={4}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add more detail…"
            className={`mt-1.5 min-h-[120px] flex-1 resize-none leading-snug ${inputBase}`}
          />
        ) : description.trim() ? (
          // Rendered markdown occupies the same footprint as the textarea so the
          // modal height doesn't jump when toggling. Links are handled by
          // onPreviewClick since the HTML is injected directly.
          <div
            onClick={onPreviewClick}
            className="task-md mt-1.5 min-h-[120px] flex-1 overflow-auto rounded-btn border border-line-2 bg-bg px-3 py-2 text-[12.5px] leading-snug text-text-2"
            dangerouslySetInnerHTML={{ __html: marked.parse(description, { async: false }) as string }}
          />
        ) : (
          <div className="mt-1.5 flex min-h-[120px] flex-1 items-center justify-center rounded-btn border border-line-2 bg-bg px-3 py-2 text-[12px] text-faint">
            Nothing to preview
          </div>
        )}
        {/* Scoped styles for rendered markdown — all colors use design tokens so
            it reads correctly in both light and dark themes. */}
        <style>{`
          .task-md > :first-child { margin-top: 0; }
          .task-md > :last-child { margin-bottom: 0; }
          .task-md h1, .task-md h2, .task-md h3, .task-md h4 {
            font-weight: 600; color: var(--color-text); line-height: 1.25;
            margin: 0.9em 0 0.4em;
          }
          .task-md h1 { font-size: 1.4em; }
          .task-md h2 { font-size: 1.25em; }
          .task-md h3 { font-size: 1.1em; }
          .task-md h4 { font-size: 1em; }
          .task-md p { margin: 0.5em 0; }
          .task-md strong { font-weight: 600; color: var(--color-text); }
          .task-md em { font-style: italic; }
          .task-md a { color: var(--color-accent); text-decoration: underline; cursor: pointer; }
          .task-md ul, .task-md ol { margin: 0.5em 0; padding-left: 1.4em; }
          .task-md ul { list-style: disc; }
          .task-md ol { list-style: decimal; }
          .task-md li { margin: 0.2em 0; }
          .task-md code {
            font-family: var(--font-mono, ui-monospace, monospace);
            font-size: 0.9em; background: var(--color-panel-2);
            border: 1px solid var(--color-line-2); border-radius: 4px;
            padding: 0.1em 0.35em;
          }
          .task-md pre {
            background: var(--color-panel-2); border: 1px solid var(--color-line-2);
            border-radius: 6px; padding: 0.6em 0.75em; margin: 0.6em 0; overflow: auto;
          }
          .task-md pre code { background: none; border: none; padding: 0; }
          .task-md blockquote {
            border-left: 3px solid var(--color-line-2); margin: 0.6em 0;
            padding: 0.1em 0.8em; color: var(--color-text-3);
          }
          .task-md hr { border: none; border-top: 1px solid var(--color-line-2); margin: 0.9em 0; }
        `}</style>

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

        {/* Recently-used tags from sibling tasks — click to add so users reuse
            existing tags. Styled as add-affordances (dashed, faint, Plus icon)
            to read distinctly from the solid selected-tag chips above. Only
            shown when there's at least one suggestion. */}
        {tagSuggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-faint">Recent:</span>
            {tagSuggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                // Prevent the input's onBlur→addTags from committing a half-typed
                // draft before this click registers: mousedown fires before blur,
                // so suppressing its default keeps focus on the input.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addSuggestion(tag)}
                className="inline-flex items-center gap-0.5 rounded-chip border border-dashed border-line-2 px-2 py-0.5 text-[11px] font-semibold text-faint outline-none transition-colors hover:text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <Plus size={10} strokeWidth={2} />
                {tag}
              </button>
            ))}
          </div>
        )}

        {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
      </div>
    </ModalShell>
  )
}
