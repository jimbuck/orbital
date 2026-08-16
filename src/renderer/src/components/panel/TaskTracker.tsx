import { useState, type JSX, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, Maximize2, Play, Plus } from 'lucide-react'
import { useStore, activeProject, tasksForProject } from '@renderer/store'
import { taskChipClass, taskStatusLabel } from '@renderer/lib/status'
import type { Task } from '@shared/types'
import TaskTitleButton from './TaskTitleButton'
import { TaskTagsDisplay } from './TaskMeta'
import TaskCardContextMenu from './TaskCardContextMenu'
import { clampMenuPos, type MenuPos } from '../rail/menu'

/**
 * Task tracker for the active project. Captures new tasks as a list, opens a
 * task in the edit modal (via its title), and bridges a task to a Worktree; the
 * expand button opens the full kanban board across all projects. Task data is
 * sourced from the store, which is kept live by the `onStateChanged`
 * subscription, so mutations need no manual reload.
 */
export default function TaskTracker(): JSX.Element {
  const project = useStore(activeProject)
  const worktrees = useStore((s) => s.worktrees)
  const openModal = useStore((s) => s.openModal)
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const tasks = useStore(
    useShallow((s) => {
      const p = activeProject(s)
      return p ? tasksForProject(s, p.id) : []
    })
  )

  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ task: Task; pos: MenuPos } | null>(null)

  const worktreeName = (worktreeId: string | null): string | undefined =>
    worktreeId ? worktrees.find((w) => w.id === worktreeId)?.name : undefined

  const onCaptureKey = async (e: KeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (e.key !== 'Enter') return
    const title = draft.trim()
    if (!title || !project) return
    e.preventDefault()
    setDraft('')
    await window.orbital.createTask(project.id, title)
  }

  // Open the New Worktree modal prefilled with (and pre-linked to) this task,
  // letting the user pick a base ref before the worktree is created.
  const startWorktree = (task: Task): void => {
    openModal('newWorktree', { project, task })
  }

  /** Inline mono link to a task's bound Worktree. */
  const worktreeLink = (task: Task, small: boolean): JSX.Element | null => {
    const name = worktreeName(task.worktreeId)
    if (!task.worktreeId || !name) return null
    return (
      <button
        type="button"
        onClick={() => setActiveWorktree(task.worktreeId!)}
        className={`inline-flex items-center mt-2 w-fit font-mono text-blue hover:underline outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded ${
          small ? 'gap-1 text-[9.5px]' : 'gap-1.5 text-[10px]'
        }`}
      >
        <span className={`flex-none rounded-full bg-accent ${small ? 'size-[5px]' : 'size-1.5'}`} />
        Worktree {name}
        <ChevronRight size={small ? 11 : 12} strokeWidth={1.5} />
      </button>
    )
  }

  return (
    <div className="px-[15px] pt-[13px] pb-5">
      {/* header */}
      <div className="flex items-center justify-between mb-[10px]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] tracking-[0.9px] uppercase text-muted font-bold">Tasks</span>
          {project && (
            <span className="font-mono text-[11px] text-faint truncate" title={project.name}>
              {project.name}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => openModal('board')}
          title="Open full board — all projects"
          aria-label="Open full board"
          className="size-6 flex-none rounded-md border border-line-2 flex items-center justify-center text-muted hover:bg-hover hover:text-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Maximize2 size={13} strokeWidth={1.5} />
        </button>
      </div>

      {/* capture */}
      <div className="flex items-center gap-2 px-[11px] py-2 mb-[11px] rounded-btn bg-bg border border-dashed border-line-2 focus-within:border-accent transition-colors">
        <Plus size={14} strokeWidth={1.5} className="flex-none text-accent" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => void onCaptureKey(e)}
          disabled={!project}
          placeholder="Capture a task…"
          className="allow-select flex-1 min-w-0 bg-transparent text-[12px] text-text placeholder:text-faint outline-none disabled:opacity-50"
        />
      </div>

      {/* task list */}
      <div className="flex flex-col gap-2">
        {tasks.length === 0 && <div className="px-1 py-2 text-[12px] text-faint">No tasks yet.</div>}
        {tasks.map((task) => {
          const done = task.status === 'done'
          return (
            <div
              key={task.id}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ task, pos: clampMenuPos(e, 210, 300) })
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
                <span
                  className={`flex-none inline-flex items-center px-[7px] py-[2px] rounded-chip text-[9.5px] font-bold uppercase tracking-[0.3px] whitespace-nowrap ${taskChipClass(
                    task.status
                  )}`}
                >
                  {taskStatusLabel(task.status)}
                </span>
              </div>

              <TaskTagsDisplay task={task} />

              {worktreeLink(task, false)}

              {!task.worktreeId && (
                <div className="mt-[9px] flex justify-end">
                  <button
                    type="button"
                    onClick={() => startWorktree(task)}
                    title="Start a Worktree from this task"
                    aria-label="Start a Worktree from this task"
                    className="inline-flex size-[22px] flex-none items-center justify-center rounded-full bg-accent text-on-accent outline-none transition hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <Play size={10} strokeWidth={2} fill="currentColor" className="translate-x-[0.5px]" />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {menu && (
        <TaskCardContextMenu task={menu.task} pos={menu.pos} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
