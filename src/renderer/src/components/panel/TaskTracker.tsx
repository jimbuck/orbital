import { useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ChevronRight, Maximize2, Play, Plus } from 'lucide-react'
import { useStore, activeProject, tasksForProject } from '@renderer/store'
import { taskChipClass, taskStatusLabel } from '@renderer/lib/status'
import {
  captureRepoId,
  isSingleProject,
  repoLock,
  taskLaneKey,
  trackerFocusRepoId,
  PROJECT_LANE
} from '@renderer/lib/taskScope'
import type { Task } from '@shared/types'
import TaskTitleButton from './TaskTitleButton'
import { TaskCreatorMark, TaskRepoChip, TaskTagsDisplay } from './TaskMeta'
import TaskCardContextMenu from './TaskCardContextMenu'
import ArchiveTaskButton from './ArchiveTaskButton'
import { clampMenuPos, type MenuPos } from '../rail/menu'

/** Whether "Rest of project" is open: one boolean, shared by every project. */
const REST_OPEN_KEY = 'orbital.tracker.restOpen'

function readRestOpen(): boolean {
  try {
    return localStorage.getItem(REST_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeRestOpen(open: boolean): void {
  try {
    localStorage.setItem(REST_OPEN_KEY, open ? '1' : '0')
  } catch {
    // Storage unavailable: the section just forgets its state.
  }
}

/**
 * Task tracker for the active project, in one of three contexts:
 *
 *  - single (a project of fewer than two repos): every task, one list;
 *  - project (the project session of a multi-repo project): every task, each
 *    with a chip naming its repo; capture files under no repo;
 *  - repo (one of its repos' sessions): that repo's tasks, then a collapsed
 *    "Rest of project" with the others (chipped); capture files under it.
 *
 * The capture box's placeholder is the only statement of where a capture
 * goes. Captures new tasks, opens a task in the edit modal (via its title),
 * and bridges a task to a Worktree; the expand button opens the project's
 * board. Task data comes from the store, kept live by `onStateChanged`.
 */
export default function TaskTracker(): JSX.Element {
  const project = useStore(activeProject)
  const repos = useStore((s) => s.repos)
  const worktrees = useStore((s) => s.worktrees)
  const openModal = useStore((s) => s.openModal)
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const focusRepoId = useStore(trackerFocusRepoId)
  const captureTo = useStore(captureRepoId)
  const tasks = useStore(useShallow((s) => (s.activeProjectId ? tasksForProject(s, s.activeProjectId) : [])))

  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{
    task: Task
    pos: MenuPos
    step: 'items' | 'repo'
  } | null>(null)
  const [restOpen, setRestOpen] = useState(readRestOpen)

  const single = !project || isSingleProject(project)
  const focusRepo = focusRepoId ? repos.find((r) => r.id === focusRepoId) : undefined
  const mine = focusRepo && project ? tasks.filter((t) => taskLaneKey(t, project) === focusRepo.id) : tasks
  const rest = focusRepo && project ? tasks.filter((t) => taskLaneKey(t, project) !== focusRepo.id) : []
  const canStart = !!project && project.repoIds.length > 0

  const placeholder = single
    ? 'Capture a task…'
    : focusRepo
      ? `Capture a task for ${focusRepo.name}…`
      : 'Capture a project task…'

  const worktreeName = (worktreeId: string | null): string | undefined =>
    worktreeId ? worktrees.find((w) => w.id === worktreeId)?.name : undefined

  const onCaptureKey = async (e: KeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (e.key !== 'Enter') return
    const title = draft.trim()
    if (!title || !project) return
    e.preventDefault()
    setDraft('')
    await window.orbital.createTask(project.id, title, captureTo)
  }

  const toggleRest = (): void => {
    const next = !restOpen
    setRestOpen(next)
    writeRestOpen(next)
  }

  /** Inline mono link to a task's bound Worktree. */
  const worktreeLink = (task: Task): JSX.Element | null => {
    const name = worktreeName(task.worktreeId)
    if (!task.worktreeId || !name) return null
    return (
      <button
        type="button"
        onClick={() => setActiveWorktree(task.worktreeId!)}
        className="inline-flex items-center mt-2 w-fit font-mono text-blue hover:underline outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded gap-1.5 text-[10px]"
      >
        <span className="flex-none rounded-full bg-accent size-1.5" />
        Worktree {name}
        <ChevronRight size={12} strokeWidth={1.5} />
      </button>
    )
  }

  /** The chip opens the card menu at its Repo step, just under itself. */
  const openRepoStep = (task: Task, e: MouseEvent<HTMLButtonElement>): void => {
    const box = e.currentTarget.getBoundingClientRect()
    setMenu({
      task,
      step: 'repo',
      pos: {
        x: Math.max(0, Math.min(box.left, window.innerWidth - 210 - 12)),
        y: Math.max(0, Math.min(box.bottom + 4, window.innerHeight - 330))
      }
    })
  }

  const card = (task: Task, chipped: boolean): JSX.Element => {
    const done = task.status === 'done'
    const laneKey = project ? taskLaneKey(task, project) : PROJECT_LANE
    const repo = laneKey === PROJECT_LANE ? undefined : repos.find((r) => r.id === laneKey)
    const chip =
      chipped && project ? (
        <TaskRepoChip
          repo={repo}
          homeRepoId={project.homeRepoId}
          locked={repoLock(task, worktrees) !== null}
          onOpen={(e) => openRepoStep(task, e)}
        />
      ) : undefined
    return (
      <div
        key={task.id}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ task, step: 'items', pos: clampMenuPos(e, 210, 330) })
        }}
        className="group relative p-3 rounded-card bg-panel border border-line-2 hover:border-line-strong transition-colors"
      >
        <div className="flex items-start justify-between gap-[9px]">
          <div className="min-w-0 flex-1">
            <TaskTitleButton
              task={task}
              className={`block text-[12.5px] font-semibold leading-snug text-pretty ${
                done ? 'text-faint line-through' : 'text-text'
              }`}
            />
          </div>
          <TaskCreatorMark task={task} />
          <span
            className={`flex-none inline-flex items-center px-[7px] py-[2px] rounded-chip text-[9.5px] font-bold uppercase tracking-[0.3px] whitespace-nowrap ${taskChipClass(
              task.status
            )}`}
          >
            {taskStatusLabel(task.status)}
          </span>
        </div>

        <TaskTagsDisplay task={task} leading={chip} />

        {worktreeLink(task)}

        {((!task.worktreeId && canStart) || done) && (
          <div className="mt-[9px] flex justify-end gap-1">
            {done && <ArchiveTaskButton task={task} />}
            {!task.worktreeId && canStart && (
              <button
                type="button"
                // New Worktree works out the repo from the task, or asks.
                onClick={() => openModal('newWorktree', { task })}
                title="Start a Worktree from this task"
                aria-label="Start a Worktree from this task"
                className="inline-flex size-[22px] flex-none items-center justify-center rounded-full bg-accent text-on-accent outline-none transition hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <Play size={10} strokeWidth={2} fill="currentColor" className="translate-x-[0.5px]" />
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const scope = project ? (focusRepo ? `${project.name} / ${focusRepo.name}` : project.name) : ''
  const Chevron = restOpen ? ChevronDown : ChevronRight

  // The header and capture box stay put; only the cards below them scroll.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className="flex flex-none items-center justify-between px-[15px] pt-[13px] mb-[10px]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] tracking-[0.9px] uppercase text-muted font-bold">Tasks</span>
          {project && (
            <span className="font-mono text-[11px] text-faint truncate" title={scope}>
              {project.name}
              {focusRepo && <span className="text-muted"> / {focusRepo.name}</span>}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => openModal('board')}
          title={project ? `Open board: ${project.name}` : 'Open task board'}
          aria-label={project ? `Open task board for ${project.name}` : 'Open task board'}
          className="size-6 flex-none rounded-md border border-line-2 flex items-center justify-center text-muted hover:bg-hover hover:text-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Maximize2 size={13} strokeWidth={1.5} />
        </button>
      </div>

      {/* capture */}
      <div className="mx-[15px] flex flex-none items-center gap-2 px-[11px] py-2 mb-[11px] rounded-btn bg-bg border border-dashed border-line-2 focus-within:border-accent transition-colors">
        <Plus size={14} strokeWidth={1.5} className="flex-none text-accent" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => void onCaptureKey(e)}
          disabled={!project}
          placeholder={placeholder}
          aria-label={placeholder.replace(/…$/, '')}
          className="allow-select flex-1 min-w-0 bg-transparent text-[12px] text-text placeholder:text-faint outline-none disabled:opacity-50"
        />
      </div>

      {/* task list */}
      <div className="flex min-h-[88px] flex-1 flex-col gap-2 overflow-y-auto px-[15px] pb-5">
        {tasks.length === 0 ? (
          <div className="px-1 py-2 text-[12px] text-faint">No tasks yet.</div>
        ) : (
          mine.length === 0 &&
          focusRepo && <div className="px-1 py-2 text-[12px] text-faint">No tasks for {focusRepo.name} yet.</div>
        )}
        {/* Chips only where the list mixes scopes: the project session's list. */}
        {mine.map((task) => card(task, !single && !focusRepo))}
        {focusRepo && rest.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={restOpen}
              aria-controls="tracker-rest"
              onClick={toggleRest}
              className="mt-1 flex w-full flex-none items-center gap-1.5 border-t border-line px-1 pb-1.5 pt-3 text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Chevron size={12} strokeWidth={1.5} />
              <span className="flex-1 text-left text-[10.5px] font-bold uppercase tracking-[0.5px]">
                Rest of project
              </span>
              <span className="font-mono text-[10px]">{rest.length}</span>
            </button>
            <div id="tracker-rest" className="flex flex-col gap-2">
              {restOpen && rest.map((task) => card(task, true))}
            </div>
          </>
        )}
      </div>

      {menu && (
        <TaskCardContextMenu
          key={`${menu.task.id}:${menu.step}`}
          task={menu.task}
          pos={menu.pos}
          initialStep={menu.step}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
