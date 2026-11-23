import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Archive, FolderGit2, House, Layers, Plus, X } from 'lucide-react'
import { useStore, activeProject } from '@renderer/store'
import {
  boardLanes,
  captureRepoId,
  projectRepos,
  repoLock,
  taskLaneKey,
  type BoardLane
} from '@renderer/lib/taskScope'
import {
  TASK_STATUSES,
  taskStatusLabel,
  taskChipClass,
  taskColumnDot,
  taskColumnHeadClass
} from '@renderer/lib/status'
import type { Task, TaskStatus, TaskPatch } from '@shared/types'
import TaskTitleButton from '../panel/TaskTitleButton'
import { TaskCreatorMark, TaskTagsDisplay } from '../panel/TaskMeta'
import TaskCardContextMenu from '../panel/TaskCardContextMenu'
import ArchiveTaskButton from '../panel/ArchiveTaskButton'
import { clampMenuPos, type MenuPos } from '../rail/menu'
import AddTaskCard from '../panel/AddTaskCard'
import Settings from './Settings'
import AddRepo from './AddRepo'
import NewWorktree from './NewWorktree'
import EditTask from './EditTask'
import ArchivedTasks from './ArchivedTasks'
import About from './About'
import Workspaces from './Workspaces'
import CommitHistory from './CommitHistory'

/* ============================================================================
 * Shared modal primitives
 *
 * ModalShell and the button / input class strings are defined here (the modal
 * hub) and consumed by the leaf modals via a relative import. Usage is always
 * at render time, so the import graph resolves cleanly.
 * ========================================================================== */

/** Primary (accent) action button. */
export const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-btn px-[18px] py-[9px] text-[12.5px] font-bold ' +
  'bg-accent text-on-accent hover:bg-accent-hover transition-colors no-drag ' +
  'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

/** Secondary / Cancel button. */
export const ghostBtn =
  'inline-flex items-center justify-center gap-2 rounded-btn px-[15px] py-[9px] text-[12.5px] font-semibold ' +
  'bg-hover text-text-2 border border-line-2 hover:bg-panel-2 transition-colors no-drag ' +
  'focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

/** Standard form input shell. */
export const inputBase =
  'w-full rounded-btn bg-bg border border-line-2 px-3 py-[9px] text-[12.5px] text-text-2 ' +
  'placeholder:text-faint focus:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

/** Uppercase section eyebrow. */
export const sectionLabel = 'text-[11px] font-bold uppercase tracking-[0.6px] text-muted'

/** Field caption above an input. */
export const fieldLabel = 'text-[11.5px] font-semibold text-text-3'

interface ModalShellProps {
  title: string
  subtitle?: string
  /** Panel width in px (design specs: 540 / 500). */
  width: number
  /** Minimum panel height in px; the body fills any space beyond its content. */
  minHeight?: number
  /** Extra classes for the scrollable body (e.g. `flex flex-col` to let content fill a tall panel). */
  bodyClassName?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

/**
 * The framed dialog panel: a flex column of header (title + subtitle + X), a
 * scrollable body, and an optional footer. Header and footer stay pinned; only
 * the body scrolls, so a tall panel (via `minHeight`) keeps its actions visible.
 */
export function ModalShell({
  title,
  subtitle,
  width,
  minHeight,
  bodyClassName = '',
  onClose,
  footer,
  children
}: ModalShellProps): React.JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ width, minHeight, maxWidth: '94vw', animation: 'panelIn .16s ease-out' }}
      className="flex max-h-[84vh] flex-col overflow-hidden bg-panel border border-line-strong rounded-modal elev-modal"
    >
      <header className="flex flex-none items-center justify-between px-[18px] py-4 border-b border-soft">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-text">{title}</div>
          {subtitle && <div className="mt-0.5 text-[11.5px] text-dim">{subtitle}</div>}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-7 flex-none place-items-center rounded-[7px] text-muted hover:bg-hover hover:text-text transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className={`min-h-0 flex-1 overflow-y-auto p-[18px] ${bodyClassName}`}>{children}</div>

      {footer && (
        <footer className="flex flex-none items-center justify-end gap-[9px] px-[18px] py-[14px] border-t border-soft">
          {footer}
        </footer>
      )}
    </div>
  )
}

/* ============================================================================
 * Task board — the active project's tasks, by status, in a lane per repo.
 * ========================================================================== */

/** `4 tasks` / `1 task` / `no tasks`. */
function taskCount(n: number): string {
  return n === 0 ? 'no tasks' : `${n} task${n === 1 ? '' : 's'}`
}

/** What the board knows about the card being dragged. */
interface BoardDrag {
  taskId: string
  /** The lane it was picked up from. */
  fromKey: string
  /** Pinned to its lane by a live worktree: it may change column, never lane. */
  locked: boolean
}

function BoardTaskCard({
  task,
  canStart,
  onDragStart,
  onDragEnd
}: {
  task: Task
  /** Whether the project has a repo to start a worktree in. */
  canStart: boolean
  onDragStart: (task: Task) => void
  onDragEnd: () => void
}): React.JSX.Element {
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  const openModal = useStore((s) => s.openModal)
  // "No linked worktree" mirrors TaskCardContextMenu: a fresh todo with no Worktree
  // yet. If the task already has a matching Worktree, don't offer Create Worktree.
  const hasWorktree = useStore((s) => !!task.worktreeId && s.worktrees.some((w) => w.id === task.worktreeId))
  const showCreateWorktree = canStart && task.status === 'todo' && !hasWorktree
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(task)
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuPos(clampMenuPos(e, 210, 330))
      }}
      className="group cursor-grab rounded-card border border-line bg-bg p-3 active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <TaskTitleButton task={task} className="block text-[12.5px] font-semibold text-text-2" />
        </div>
        <TaskCreatorMark task={task} />
        <span className={`flex-none rounded-chip px-2 py-0.5 text-[10px] font-bold ${taskChipClass(task.status)}`}>
          {taskStatusLabel(task.status)}
        </span>
      </div>
      <TaskTagsDisplay task={task} />
      {task.status === 'done' && (
        <div className="mt-2 flex justify-end">
          <ArchiveTaskButton task={task} />
        </div>
      )}
      {showCreateWorktree && (
        // stopPropagation + a no-op mouseDown keep the click from starting a
        // card drag. openModal STACKS over the board (see ModalRoot), so New
        // Worktree opens on top and closing it returns here. It works out the
        // repo from the task (or asks for one).
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            openModal('newWorktree', { task })
          }}
          className="mt-2 inline-flex items-center gap-1 rounded-btn border border-line-2 px-2 py-1 text-[10.5px] font-semibold text-accent hover:bg-hover transition-colors no-drag"
        >
          <Plus size={12} strokeWidth={1.5} />
          Create Worktree
        </button>
      )}
      {menuPos && <TaskCardContextMenu task={task} pos={menuPos} onClose={() => setMenuPos(null)} />}
    </div>
  )
}

const LANE_GLYPH = { project: Layers, home: House, repo: FolderGit2 } as const

/**
 * The task board for the active project (it follows the rail: switch project
 * there and an open board re-scopes in place). A project of two or more repos
 * gets a lane per repo under a Project lane for untagged work; dragging a card
 * across lanes files it under that lane's repo. A project of fewer is one
 * plain status board, and the repo tag never shows.
 */
function FullBoard(): React.JSX.Element {
  const project = useStore(activeProject)
  const repos = useStore((s) => s.repos)
  const allTasks = useStore((s) => s.tasks)
  const worktrees = useStore((s) => s.worktrees)
  const closeModal = useStore((s) => s.closeModal)
  const openModal = useStore((s) => s.openModal)
  const singleRepoId = useStore(captureRepoId)
  const [hoverCell, setHoverCell] = useState<string | null>(null)
  const [drag, setDrag] = useState<BoardDrag | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const board = useMemo(() => (project ? boardLanes(project, repos, allTasks) : null), [project, repos, allTasks])
  const taskTotal = board ? board.lanes.reduce((n, l) => n + l.tasks.length, 0) : 0
  const repoTotal = project ? projectRepos(project, repos).length : 0

  const endDrag = (): void => {
    setDrag(null)
    setHoverCell(null)
  }

  // Dropping a card on a cell sets its status (column) and, across lanes of a
  // multi-repo project, its repo (null in the Project lane).
  const dropTask = (taskId: string, lane: BoardLane, status: TaskStatus): void => {
    const task = allTasks.find((t) => t.id === taskId)
    if (!task || !project || !board) return
    const patch: TaskPatch = {}
    if (task.status !== status) patch.status = status
    const crossing = !board.single && taskLaneKey(task, project) !== lane.key
    if (crossing) {
      if (repoLock(task, worktrees)) return
      patch.repoId = lane.repoId
    }
    if (!Object.keys(patch).length) return
    const where = lane.kind === 'project' ? 'Project' : lane.name
    const msg =
      crossing && patch.status
        ? `#${task.seq} moved to ${where}, ${taskStatusLabel(status)}.${lane.repoId === null ? ' Repo cleared.' : ''}`
        : crossing
          ? `#${task.seq} moved to ${where}.${lane.repoId === null ? ' Repo cleared.' : ''}`
          : `#${task.seq} moved to ${taskStatusLabel(status)}.`
    window.orbital.updateTask(taskId, patch).then(
      () => setAnnouncement(msg),
      () => setAnnouncement(`Could not move #${task.seq}.`)
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="board-title"
      style={{ animation: 'panelIn .16s ease-out' }}
      className="flex h-[86vh] w-[2360px] max-w-[95vw] flex-col overflow-hidden bg-panel border border-line-strong rounded-modal elev-modal"
    >
      <header className="flex flex-none items-center justify-between px-[18px] py-[15px] border-b border-soft">
        <div className="min-w-0">
          <div id="board-title" className="truncate text-[15px] font-bold text-text">
            {project ? `Tasks in ${project.name}` : 'Tasks'}
          </div>
          {project && board && (
            <div className="mt-0.5 text-[11.5px] text-dim">
              {board.single ? '' : `${repoTotal} repos · `}
              {taskTotal} task{taskTotal === 1 ? '' : 's'}
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-2">
          {/* Archived tasks are left off the board; this opens them as a table
              (stacked over the board) where each can be unarchived. */}
          <button
            type="button"
            onClick={() => openModal('archivedTasks')}
            className="inline-flex items-center gap-1.5 rounded-btn px-2 py-1 text-[11.5px] font-semibold text-muted hover:bg-hover hover:text-text transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            <Archive size={13} strokeWidth={1.5} />
            Archived tasks
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={closeModal}
            className="grid size-7 flex-none place-items-center rounded-[7px] text-muted hover:bg-hover hover:text-text transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-[18px]">
        {!project || !board ? (
          <div className="text-[12px] text-faint">No projects yet.</div>
        ) : (
          <div className="min-w-[820px]">
            {taskTotal === 0 && (
              <div className="mb-3 text-[12px] text-faint">
                No tasks in {project.name} yet. Add one from any column.
              </div>
            )}
            {/* Status column headers, offset by the lane-label gutter (multi only).
                No bottom padding so the header sits flush on the first lane. */}
            <div className="sticky top-0 z-10 flex gap-2 bg-panel">
              {!board.single && <div className="w-[150px] flex-none" />}
              {TASK_STATUSES.map((status) => {
                const dot = taskColumnDot(status)
                return (
                  <div
                    key={status}
                    className="flex flex-1 items-center gap-2 rounded-t-col border border-line border-b-0 bg-bg px-3 py-2"
                  >
                    <span className={`size-2 flex-none rounded-full ${dot.className}`} style={dot.style} />
                    <span
                      className={`text-[10.5px] font-bold uppercase tracking-[0.5px] ${taskColumnHeadClass(status)}`}
                    >
                      {taskStatusLabel(status)}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* One swim-lane per repo (Project first), split by a dashed lane line. */}
            {board.lanes.map((lane, i) => {
              const Glyph = LANE_GLYPH[lane.kind]
              const hoverLane = hoverCell?.slice(0, hoverCell.lastIndexOf(':'))
              const target = !!drag && !drag.locked && hoverLane === lane.key && lane.key !== drag.fromKey
              const hint = target
                ? `Move to ${lane.kind === 'project' ? 'Project' : lane.name}`
                : drag?.locked && lane.key === drag.fromKey
                  ? 'Has a worktree here'
                  : null
              // A locked card may only move within its own lane.
              const refused = !!drag && drag.locked && !board.single && lane.key !== drag.fromKey
              const laneTitle =
                lane.kind === 'project'
                  ? `Tasks with no repo: work that spans ${project.name}`
                  : (repos.find((r) => r.id === lane.repoId)?.repoPath ?? lane.name)
              const ariaLane = lane.kind === 'project' ? 'Project, no repo' : lane.name
              return (
                <div
                  key={lane.key}
                  className={`flex gap-2 ${i > 0 ? 'border-t border-dashed border-line-strong' : ''}`}
                >
                  {!board.single && (
                    <div className="flex w-[150px] flex-none items-center gap-2 py-3">
                      <Glyph size={12} strokeWidth={1.5} className="flex-none text-faint" aria-hidden />
                      <div className="min-w-0">
                        <div
                          className={`truncate text-[12px] font-bold ${target ? 'text-text' : 'text-text-2'}`}
                          title={laneTitle}
                        >
                          {lane.name}
                        </div>
                        <div className={`truncate font-mono text-[10px] ${target ? 'text-accent' : 'text-faint'}`}>
                          {hint ?? taskCount(lane.tasks.length)}
                        </div>
                      </div>
                    </div>
                  )}
                  {TASK_STATUSES.map((status) => {
                    const cell = lane.tasks.filter((t) => t.status === status)
                    const cellKey = `${lane.key}:${status}`
                    const isHover = hoverCell === cellKey && !refused
                    return (
                      <div
                        key={status}
                        role="group"
                        aria-label={`${board.single ? '' : `${ariaLane}, `}${taskStatusLabel(status)}, ${cell.length} tasks`}
                        onDragOver={(e) => {
                          if (refused) return
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          if (hoverCell !== cellKey) setHoverCell(cellKey)
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          const id = e.dataTransfer.getData('text/plain') || drag?.taskId
                          if (id && !refused) dropTask(id, lane, status)
                          endDrag()
                        }}
                        className={`group/col flex min-h-[88px] flex-1 flex-col gap-2 border-x p-2 transition-[colors,opacity] ${
                          isHover ? 'border-accent/40 bg-accent/[0.06]' : 'border-line bg-bg'
                        } ${refused ? 'opacity-40' : ''}`}
                      >
                        {cell.map((task) => (
                          <BoardTaskCard
                            key={task.id}
                            task={task}
                            canStart={repoTotal > 0}
                            onDragStart={(t) =>
                              setDrag({
                                taskId: t.id,
                                fromKey: lane.key,
                                locked: repoLock(t, worktrees) !== null
                              })
                            }
                            onDragEnd={endDrag}
                          />
                        ))}
                        <AddTaskCard
                          projectId={project.id}
                          repoId={board.single ? singleRepoId : lane.repoId}
                          status={status}
                          pinned={taskTotal === 0 && i === 0 && status === 'todo'}
                        />
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================================================================
 * ModalRoot — the single overlay host driven by store.modal.
 * ========================================================================== */

export default function ModalRoot(): React.JSX.Element | null {
  const modalStack = useStore((s) => s.modalStack)
  const closeModal = useStore((s) => s.closeModal)

  // Dismiss on Escape while any modal is open — closeModal() pops just the top
  // layer, so Escape peels the stack back one at a time (task → board — gone).
  // A control inside the modal that handles Escape itself (an inline input
  // cancelling its edit, a menu closing) calls preventDefault, and that press
  // must not ALSO close the modal underneath it and drop every unsaved edit.
  useEffect(() => {
    if (modalStack.length === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalStack.length, closeModal])

  if (modalStack.length === 0) return null

  // Render every stack entry as its own overlay layer, deeper layers on top.
  // The backdrop deliberately does NOT dismiss on click: a text-selection drag
  // that starts inside the panel and releases outside would register as a
  // backdrop click and close the modal. Closing is explicit only — the X
  // button, Cancel/Save/Archive actions, or Escape.
  return (
    <>
      {modalStack.map((entry, i) => (
        <div
          key={`${i}:${entry.type}`}
          style={{ animation: 'overlayIn .12s ease-out', zIndex: 50 + i * 10 }}
          className="fixed inset-0 grid place-items-center bg-scrim p-8 no-drag"
        >
          {entry.type === 'settings' && <Settings />}
          {entry.type === 'addRepo' && <AddRepo />}
          {entry.type === 'newWorktree' && <NewWorktree />}
          {entry.type === 'editTask' && <EditTask />}
          {entry.type === 'board' && <FullBoard />}
          {entry.type === 'archivedTasks' && <ArchivedTasks />}
          {entry.type === 'about' && <About />}
          {entry.type === 'workspaces' && <Workspaces />}
          {entry.type === 'commitHistory' && <CommitHistory />}
        </div>
      ))}
    </>
  )
}
