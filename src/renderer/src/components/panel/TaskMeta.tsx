import type { JSX, MouseEvent, ReactNode } from 'react'
import { Bot, FolderGit2, House, Layers } from 'lucide-react'
import type { Repo, Task, TaskCreator } from '@shared/types'

/** Human wording for who filed a task. */
export function taskCreatorLabel(createdBy: TaskCreator | null): string {
  return createdBy === 'agent' ? 'an agent' : createdBy === 'user' ? 'you' : 'unknown'
}

/** A unix-ms timestamp in the user's locale, date and time. */
export function formatTaskTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/**
 * The provenance line for a task: who filed it and when, and when it last
 * changed. Rendered as plain text so the edit modal and tooltips share one
 * wording.
 */
export function taskProvenance(task: Task): string {
  return `Filed by ${taskCreatorLabel(task.createdBy)} · ${formatTaskTime(task.createdAt)} · updated ${formatTaskTime(task.updatedAt)}`
}

/**
 * A small robot mark on cards for tasks an agent filed from the CLI, so a
 * glance at the tracker tells apart work the human queued from work the agents
 * queued for the human. User-filed (and legacy, untracked) tasks show nothing.
 */
export function TaskCreatorMark({ task }: { task: Task }): JSX.Element | null {
  if (task.createdBy !== 'agent') return null
  return (
    <span
      className="flex-none inline-flex items-center text-faint"
      title={taskProvenance(task)}
      aria-label="Filed by an agent"
      role="img"
    >
      <Bot size={12} strokeWidth={2} />
    </span>
  )
}

/** The glyph for where a task is filed: the home repo, another repo, or none (the project). */
export function repoGlyph(repo: Repo | undefined, homeRepoId: string | null): typeof Layers {
  return !repo ? Layers : repo.id === homeRepoId ? House : FolderGit2
}

/**
 * The scope chip on a tracker card in a list that mixes scopes: which repo the
 * task is filed under, or `Project` (dashed) for none. Mono and unfilled, so it
 * reads as metadata beside the filled tag chips. Clicking opens the card menu
 * at its Repo step; a task pinned by its worktree gets a plain span instead.
 */
export function TaskRepoChip({
  repo,
  homeRepoId,
  locked,
  onOpen
}: {
  /** The repo it is filed under (in its project), or undefined for none. */
  repo: Repo | undefined
  homeRepoId: string | null
  locked: boolean
  onOpen: (e: MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  const Glyph = repoGlyph(repo, homeRepoId)
  const cls = `inline-flex max-w-[130px] items-center gap-1 rounded-chip border border-line-2 px-[5px] py-px font-mono text-[9.5px] text-muted ${
    repo ? '' : 'border-dashed'
  }`
  const body = (
    <>
      <Glyph size={10} strokeWidth={1.5} className="flex-none text-faint" aria-hidden />
      <span className="truncate">{repo ? repo.name : 'Project'}</span>
    </>
  )
  if (locked) {
    return (
      <span className={cls} title="Follows its worktree">
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={repo ? `Repo: ${repo.name}. Change repo` : 'No repo, whole project. Change repo'}
      onClick={onOpen}
      className={`${cls} outline-none hover:bg-hover hover:text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60`}
    >
      {body}
    </button>
  )
}

/** A tag on a task card, wherever the card is drawn. */
export const TASK_TAG_CHIP =
  'inline-flex items-center rounded-chip border border-line-2 bg-panel-2 px-[6px] py-px text-[9.5px] font-semibold text-text-3'

/**
 * Read-only tag chips shown on a task card, after an optional `leading` item
 * (the scope chip). Editing tags (and every other task field) lives in the
 * edit-task modal, opened by clicking the card title — cards themselves only
 * display.
 */
export function TaskTagsDisplay({ task, leading }: { task: Task; leading?: ReactNode }): JSX.Element | null {
  if (task.tags.length === 0 && !leading) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {leading}
      {task.tags.map((tag) => (
        <span key={tag} className={TASK_TAG_CHIP}>
          {tag}
        </span>
      ))}
    </div>
  )
}
