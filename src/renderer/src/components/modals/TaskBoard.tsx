import { useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react'
import {
  Archive,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FilterX,
  FolderGit2,
  House,
  Layers,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  X
} from 'lucide-react'
import { useStore, activeProject } from '@renderer/store'
import { boardLanes, projectRepos, repoLock, taskLaneKey, type BoardLane } from '@renderer/lib/taskScope'
import {
  StatusDot,
  TASK_STATUSES,
  taskColumnDot,
  taskColumnHeadClass,
  taskStatusLabel,
  worktreeStatusLabel
} from '@renderer/lib/status'
import type { Task, TaskPatch, TaskStatus } from '@shared/types'
import TaskTitleButton from '../panel/TaskTitleButton'
import { TASK_TAG_CHIP, TaskCreatorMark } from '../panel/TaskMeta'
import TaskCardContextMenu from '../panel/TaskCardContextMenu'
import ArchiveTaskButton from '../panel/ArchiveTaskButton'
import AddTaskCard from '../panel/AddTaskCard'
import { ContextMenu, MenuConfirm, MenuItem, clampMenuPos, type MenuPos } from '../rail/menu'

/*
 * The task board: one project's tasks, by status, in a lane per repo that has
 * any. Everything that can be done to a card, a column, a lane or the board
 * is on a button within reach and again on its right-click menu.
 */

/** The card menu's footprint, for keeping it on screen. */
const CARD_MENU = { width: 210, height: 390 }
const BOARD_MENU = { width: 230, height: 200 }

/** A round icon button, the size of the card's archive button beside it. */
const ICON_BTN =
  'grid size-[22px] flex-none place-items-center rounded-full text-faint outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60'

/** `4 tasks` / `1 task` / `no tasks`. */
function taskCount(n: number): string {
  return n === 0 ? 'no tasks' : `${n} task${n === 1 ? '' : 's'}`
}

/** A menu's place just under the button that opened it. */
function under(el: Element, size: { width: number; height: number }): MenuPos {
  const box = el.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(box.left, window.innerWidth - size.width - 12)),
    y: Math.max(0, Math.min(box.bottom + 4, window.innerHeight - size.height))
  }
}

/**
 * The first lines of a description as one run of plain text, for the two
 * lines a card has room for. Markdown marks that would read as noise at that
 * size (heading hashes, list bullets, quotes, backticks, bold) are dropped.
 */
export function descriptionPreview(description: string): string {
  const lines: string[] = []
  for (const raw of description.split('\n')) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+\.\s+)/, '')
      .replace(/`|\*\*/g, '')
      .trim()
    if (line) lines.push(line)
    if (lines.join(' ').length > 220) break
  }
  return lines.join(' ')
}

/** Whether a task has every filter term somewhere in its number, title, tags or description. */
function matches(task: Task, terms: string[]): boolean {
  if (terms.length === 0) return true
  const text = `#${task.seq} ${task.title} ${task.tags.join(' ')} ${task.description}`.toLowerCase()
  return terms.every((t) => text.includes(t))
}

/** What the board knows about the card being dragged. */
interface BoardDrag {
  taskId: string
  /** The lane it was picked up from. */
  fromKey: string
  /** The cell it was picked up from (`lane:status`). */
  fromCell: string
  /** Pinned to its lane by a live worktree: it may change column, never lane. */
  locked: boolean
}

/** What a board menu was opened on. */
type MenuTarget =
  | { kind: 'board' }
  | { kind: 'column'; status: TaskStatus }
  | { kind: 'lane'; lane: BoardLane }
  | { kind: 'cell'; lane: BoardLane; status: TaskStatus }

/**
 * A card. Clicking it opens the task. Its number and title lead; under them
 * come two lines of the description, then the worktree it is being worked in
 * (with that worktree's live status, which is what tells you an agent is on
 * it or waiting for you) and its tags. The column already says its status,
 * so the card does not repeat it.
 *
 * Hovering or focusing the card brings up its buttons over the top right
 * corner: start a worktree (or archive, once done) and the full menu, which
 * is also the right-click menu.
 */
function BoardCard({
  task,
  canStart,
  dragging,
  onDragStart,
  onDragEnd
}: {
  task: Task
  /** Whether the project has a repo to start a worktree in. */
  canStart: boolean
  /** This is the card being dragged. */
  dragging: boolean
  onDragStart: (task: Task) => void
  onDragEnd: () => void
}): JSX.Element {
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  const openModal = useStore((s) => s.openModal)
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const worktree = useStore((s) => (task.worktreeId ? s.worktrees.find((w) => w.id === task.worktreeId) : undefined))
  const done = task.status === 'done'
  const preview = useMemo(() => descriptionPreview(task.description), [task.description])
  const agent = task.createdBy === 'agent'

  return (
    <div
      draggable
      data-task-id={task.id}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(task)
      }}
      onDragEnd={onDragEnd}
      onClick={() => openModal('editTask', { task })}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenuPos(clampMenuPos(e, CARD_MENU.width, CARD_MENU.height))
      }}
      className={`group/card relative cursor-pointer rounded-card border bg-panel px-3 py-[10px] transition-colors active:cursor-grabbing ${
        menuPos ? 'border-accent/50' : 'border-line-2 hover:border-line-strong'
      } ${dragging ? 'opacity-40' : ''}`}
    >
      <TaskTitleButton
        task={task}
        className={`block text-[13px] font-semibold leading-snug text-pretty ${done ? 'text-text-3' : 'text-text'}`}
      />

      {preview && <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted">{preview}</p>}

      {(worktree || task.tags.length > 0 || agent) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {worktree && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setActiveWorktree(worktree.id)
                // Going there means leaving the board.
                openModal(null)
              }}
              title={`Go to worktree ${worktree.name} (${worktreeStatusLabel(worktree.status)})`}
              aria-label={`Go to worktree ${worktree.name}, ${worktreeStatusLabel(worktree.status)}`}
              className="inline-flex max-w-full items-center gap-[6px] rounded-chip border border-line-2 py-[2px] pl-[5px] pr-[6px] font-mono text-[10px] text-text-3 outline-none transition-colors hover:border-line-strong hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <StatusDot status={worktree.status} className="scale-[0.8]" />
              <span className="truncate">{worktree.branch || worktree.name}</span>
            </button>
          )}
          {task.tags.map((tag) => (
            <span key={tag} className={TASK_TAG_CHIP}>
              {tag}
            </span>
          ))}
          {agent && (
            <span className="ml-auto flex">
              <TaskCreatorMark task={task} />
            </span>
          )}
        </div>
      )}

      {/* The card's buttons, over its top right corner. They take no room of
          their own, so no card is taller for having them; the fill and its
          soft left edge keep a long title from showing through. */}
      <div
        className={`absolute right-[5px] top-[5px] flex items-center gap-px rounded-full bg-panel shadow-[-10px_0_8px_var(--color-panel)] transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100 ${
          menuPos ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {done ? (
          <ArchiveTaskButton task={task} />
        ) : (
          !worktree &&
          canStart && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                // New Worktree stacks over the board and works out the repo from the task (or asks).
                openModal('newWorktree', { task })
              }}
              title="Start a worktree from this task"
              aria-label={`Start a worktree from task #${task.seq}`}
              className={`${ICON_BTN} hover:text-accent`}
            >
              <Play size={11} strokeWidth={1.8} />
            </button>
          )
        )}
        <button
          type="button"
          aria-haspopup="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            setMenuPos(under(e.currentTarget, CARD_MENU))
          }}
          title="More actions"
          aria-label={`More actions for task #${task.seq}`}
          className={ICON_BTN}
        >
          <MoreHorizontal size={13} strokeWidth={1.5} />
        </button>
      </div>

      {menuPos && (
        // The menu is drawn inside the card, so its clicks must not open the task.
        <div onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          <TaskCardContextMenu task={task} pos={menuPos} onClose={() => setMenuPos(null)} />
        </div>
      )}
    </div>
  )
}

const LANE_GLYPH = { project: Layers, home: House, repo: FolderGit2 } as const

/**
 * The task board, for one project at a time. It opens on the active project
 * and follows the rail until a project is picked from the title, which is
 * how another project's tasks are looked at without leaving the session
 * underneath; the pick lasts until the board closes.
 *
 * Filing a task under a repo is optional, so the board has a lane only for a
 * repo that has a task, under a Project lane for the untagged ones; dragging
 * a card across lanes files it under that lane's repo. With no task filed
 * under a repo (or in a project of fewer than two repos) it is one plain
 * status board whose columns run the height of the window.
 *
 * Keys: N starts a new task in Todo, / goes to the filter.
 */
export default function TaskBoard(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const active = useStore(activeProject)
  const [pickedId, setPickedId] = useState<string | null>(null)
  // A picked project that has since been removed falls back to the active one.
  const project = projects.find((p) => p.id === pickedId) ?? active
  const repos = useStore((s) => s.repos)
  const allTasks = useStore((s) => s.tasks)
  const worktrees = useStore((s) => s.worktrees)
  const closeModal = useStore((s) => s.closeModal)
  const openModal = useStore((s) => s.openModal)
  const setActiveRepo = useStore((s) => s.setActiveRepo)
  // Keys are the board's only while nothing is stacked over it.
  const onTop = useStore((s) => s.modalStack[s.modalStack.length - 1]?.type === 'board')

  const [hoverCell, setHoverCell] = useState<string | null>(null)
  const [drag, setDrag] = useState<BoardDrag | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState('')
  /** Collapsed lanes, as `project:lane`. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  /** The cell whose Add Task input is open (`lane:status`). */
  const [adding, setAdding] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ pos: MenuPos; target: MenuTarget; confirm?: boolean } | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const board = useMemo(() => (project ? boardLanes(project, repos, allTasks) : null), [project, repos, allTasks])
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query])
  /** Each lane with the tasks the filter leaves in it. */
  const lanes = useMemo(
    () => (board ? board.lanes.map((lane) => ({ lane, tasks: lane.tasks.filter((t) => matches(t, terms)) })) : []),
    [board, terms]
  )
  const taskTotal = board ? board.lanes.reduce((n, l) => n + l.tasks.length, 0) : 0
  const shownTotal = lanes.reduce((n, l) => n + l.tasks.length, 0)
  const repoTotal = project ? projectRepos(project, repos).length : 0
  const filtering = terms.length > 0

  const laneId = (lane: BoardLane): string => `${project?.id}:${lane.key}`
  const isCollapsed = (lane: BoardLane): boolean => !!board?.laned && collapsed.has(laneId(lane))
  const anyOpen = lanes.some((l) => !isCollapsed(l.lane))
  const setLaneCollapsed = (lane: BoardLane, closed: boolean): void =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (closed) next.add(laneId(lane))
      else next.delete(laneId(lane))
      return next
    })
  const setAllCollapsed = (closed: boolean): void =>
    setCollapsed((s) => {
      const next = new Set(s)
      for (const { lane } of lanes) {
        if (closed) next.add(laneId(lane))
        else next.delete(laneId(lane))
      }
      return next
    })

  const endDrag = (): void => {
    setDrag(null)
    setHoverCell(null)
  }

  /** Open the Add Task input of a cell, opening its lane first. */
  const startAdding = (lane: BoardLane, status: TaskStatus): void => {
    setLaneCollapsed(lane, false)
    setAdding(`${lane.key}:${status}`)
  }
  /** A new task with nothing said about where: Todo, in the first lane (no repo, in a laned board). */
  const newTask = (): void => {
    if (board) startAdding(board.lanes[0], 'todo')
  }
  const newTaskRef = useRef(newTask)
  newTaskRef.current = newTask

  useEffect(() => {
    if (!onTop) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      // A menu is open: its keys are not the board's.
      if (document.querySelector('[role="menu"]')) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        newTaskRef.current()
      } else if (e.key === '/') {
        e.preventDefault()
        filterRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onTop])

  // Dropping a card on a cell sets its status (column) and, across lanes, its
  // repo (null in the Project lane).
  const dropTask = (taskId: string, lane: BoardLane, status: TaskStatus | null): void => {
    const task = allTasks.find((t) => t.id === taskId)
    if (!task || !project || !board) return
    const patch: TaskPatch = {}
    if (status && task.status !== status) patch.status = status
    const crossing = board.laned && taskLaneKey(task, project) !== lane.key
    if (crossing) {
      if (repoLock(task, worktrees)) return
      patch.repoId = lane.repoId
    }
    if (!Object.keys(patch).length) return
    const where = lane.kind === 'project' ? 'Project' : lane.name
    const cleared = lane.repoId === null ? ' Repo cleared.' : ''
    const msg =
      crossing && patch.status
        ? `#${task.seq} moved to ${where}, ${taskStatusLabel(patch.status)}.${cleared}`
        : crossing
          ? `#${task.seq} moved to ${where}.${cleared}`
          : `#${task.seq} moved to ${taskStatusLabel(status ?? task.status)}.`
    window.orbital.updateTask(taskId, patch).then(
      () => setAnnouncement(msg),
      () => setAnnouncement(`Could not move #${task.seq}.`)
    )
  }

  const openMenu = (e: MouseEvent, target: MenuTarget): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ pos: clampMenuPos(e, BOARD_MENU.width, BOARD_MENU.height), target })
  }
  const closeMenu = (): void => setMenu(null)

  /** The done tasks a menu's "archive" would take: the column's, or one cell's. */
  const doneIn = (target: MenuTarget): Task[] =>
    target.kind === 'column' && target.status === 'done'
      ? lanes.flatMap((l) => l.tasks.filter((t) => t.status === 'done'))
      : target.kind === 'cell' && target.status === 'done'
        ? (lanes.find((l) => l.lane.key === target.lane.key)?.tasks.filter((t) => t.status === 'done') ?? [])
        : []

  const menuItems = (target: MenuTarget): JSX.Element => {
    const run = (fn: () => void) => (): void => {
      fn()
      closeMenu()
    }
    const done = doneIn(target)
    const newItem = (label: string, lane: BoardLane, status: TaskStatus, hint?: string): JSX.Element => (
      <MenuItem
        icon={<Plus size={13} strokeWidth={1.5} />}
        label={label}
        hint={hint}
        onClick={run(() => startAdding(lane, status))}
      />
    )
    const archiveItem = done.length > 0 && (
      <MenuItem
        icon={<Archive size={13} strokeWidth={1.5} />}
        label={`Archive ${done.length === 1 ? 'the Done Task' : `All ${done.length} Done Tasks`}`}
        onClick={() => setMenu((m) => (m ? { ...m, confirm: true } : m))}
      />
    )
    const laneItems = board?.laned && (
      <>
        <div className="my-1 h-px bg-soft" />
        <MenuItem
          icon={
            anyOpen ? <ChevronsDownUp size={13} strokeWidth={1.5} /> : <ChevronsUpDown size={13} strokeWidth={1.5} />
          }
          label={anyOpen ? 'Collapse All Lanes' : 'Expand All Lanes'}
          onClick={run(() => setAllCollapsed(anyOpen))}
        />
      </>
    )

    if (target.kind === 'cell') {
      return (
        <>
          {newItem('New Task Here', target.lane, target.status)}
          {archiveItem}
          {laneItems}
        </>
      )
    }
    if (target.kind === 'column') {
      return (
        <>
          {board && newItem(`New Task in ${taskStatusLabel(target.status)}`, board.lanes[0], target.status)}
          {archiveItem}
          {laneItems}
        </>
      )
    }
    if (target.kind === 'lane') {
      const { lane } = target
      const repo = lane.repoId ? repos.find((r) => r.id === lane.repoId) : undefined
      const closed = isCollapsed(lane)
      return (
        <>
          {newItem(`New Task in ${lane.name}`, lane, 'todo')}
          {repo && (
            <>
              <MenuItem
                icon={<ArrowUpRight size={13} strokeWidth={1.5} />}
                label={`Go to ${repo.name}`}
                onClick={run(() => {
                  setActiveRepo(repo.id)
                  openModal(null)
                })}
              />
              <MenuItem
                icon={<Play size={13} strokeWidth={1.5} />}
                label="New Worktree…"
                hint={`in ${repo.name}`}
                onClick={run(() => openModal('newWorktree', { repo }))}
              />
            </>
          )}
          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={closed ? <ChevronDown size={13} strokeWidth={1.5} /> : <ChevronRight size={13} strokeWidth={1.5} />}
            label={closed ? 'Expand Lane' : 'Collapse Lane'}
            onClick={run(() => setLaneCollapsed(lane, !closed))}
          />
          <MenuItem
            icon={
              anyOpen ? <ChevronsDownUp size={13} strokeWidth={1.5} /> : <ChevronsUpDown size={13} strokeWidth={1.5} />
            }
            label={anyOpen ? 'Collapse All Lanes' : 'Expand All Lanes'}
            onClick={run(() => setAllCollapsed(anyOpen))}
          />
        </>
      )
    }
    return (
      <>
        <MenuItem icon={<Plus size={13} strokeWidth={1.5} />} label="New Task" hint="N" onClick={run(newTask)} />
        <MenuItem
          icon={<Search size={13} strokeWidth={1.5} />}
          label="Filter Tasks"
          hint="/"
          onClick={run(() => filterRef.current?.focus())}
        />
        {filtering && (
          <MenuItem
            icon={<FilterX size={13} strokeWidth={1.5} />}
            label="Clear Filter"
            onClick={run(() => setQuery(''))}
          />
        )}
        <MenuItem
          icon={<Archive size={13} strokeWidth={1.5} />}
          label="Archived Tasks"
          onClick={run(() => openModal('archivedTasks', project ? { projectId: project.id } : undefined))}
        />
        {laneItems}
      </>
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={project ? `Tasks in ${project.name}` : 'Tasks'}
      style={{ animation: 'panelIn .16s ease-out' }}
      className="flex h-[86vh] w-[2360px] max-w-[95vw] flex-col overflow-hidden bg-panel border border-line-strong rounded-modal elev-modal"
    >
      <header className="flex flex-none items-center gap-4 border-b border-soft px-5 py-[13px]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[15px] font-bold text-text">
            {!project ? (
              'Tasks'
            ) : projects.length < 2 ? (
              <span className="truncate">Tasks in {project.name}</span>
            ) : (
              <>
                <span className="flex-none">Tasks in</span>
                {/* A native select is as wide as its longest option. The hidden
                    copy of the name sizes the box to the project it shows. */}
                <span className="relative inline-grid min-w-0 max-w-[420px] items-center">
                  <span aria-hidden className="invisible col-start-1 row-start-1 truncate whitespace-pre pl-[9px] pr-7">
                    {project.name}
                  </span>
                  <select
                    aria-label="Project"
                    title="Show another project's tasks"
                    value={project.id}
                    onChange={(e) => {
                      endDrag()
                      setAdding(null)
                      setPickedId(e.target.value)
                    }}
                    className="col-start-1 row-start-1 w-full min-w-0 cursor-pointer appearance-none truncate rounded-btn border border-line-2 bg-bg py-[3px] pl-2 pr-7 text-[15px] font-bold text-text outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60 [&_option]:bg-elev [&_option]:font-normal [&_option]:text-text"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    strokeWidth={1.5}
                    aria-hidden
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint"
                  />
                </span>
              </>
            )}
          </div>
          {project && board && (
            <div className="mt-0.5 text-[11.5px] text-dim">
              {board.single ? '' : `${repoTotal} repos · `}
              {filtering
                ? `${shownTotal} of ${taskTotal} task${taskTotal === 1 ? '' : 's'}`
                : `${taskTotal} task${taskTotal === 1 ? '' : 's'}`}
            </div>
          )}
        </div>

        <div className="ml-auto flex flex-none items-center gap-2">
          {project && board && (
            <>
              <div className="relative flex items-center">
                <Search
                  size={13}
                  strokeWidth={1.5}
                  aria-hidden
                  className="pointer-events-none absolute left-[9px] text-faint"
                />
                <input
                  ref={filterRef}
                  value={query}
                  aria-label="Filter tasks"
                  placeholder="Filter tasks"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape clears a filter before it is allowed to close the board.
                    if (e.key === 'Escape' && query) {
                      e.preventDefault()
                      setQuery('')
                    }
                  }}
                  className="allow-select h-[30px] w-[210px] rounded-btn border border-line-2 bg-bg pl-[29px] pr-7 text-[12px] text-text-2 outline-none placeholder:text-faint focus:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/60"
                />
                {query ? (
                  <button
                    type="button"
                    aria-label="Clear filter"
                    title="Clear filter"
                    onClick={() => {
                      setQuery('')
                      filterRef.current?.focus()
                    }}
                    className="absolute right-1 grid size-[22px] place-items-center rounded-full text-faint outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <X size={12} strokeWidth={1.5} />
                  </button>
                ) : (
                  <kbd
                    aria-hidden
                    className="pointer-events-none absolute right-[7px] rounded-[4px] border border-line-2 px-[5px] font-mono text-[10px] leading-[15px] text-faint"
                  >
                    /
                  </kbd>
                )}
              </div>
              <button
                type="button"
                onClick={newTask}
                title="New task (N)"
                className="inline-flex h-[30px] items-center gap-1.5 rounded-btn bg-accent pl-[10px] pr-3 text-[12px] font-bold text-on-accent outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <Plus size={14} strokeWidth={2} />
                New Task
              </button>
            </>
          )}
          {/* Archived tasks are left off the board; this opens them as a table
              (stacked over the board) where each can be unarchived. */}
          <button
            type="button"
            onClick={() => openModal('archivedTasks', project ? { projectId: project.id } : undefined)}
            className="inline-flex h-[30px] items-center gap-1.5 rounded-btn px-2 text-[11.5px] font-semibold text-muted hover:bg-hover hover:text-text transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
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

      <div className="min-h-0 flex-1 overflow-auto bg-bg px-5 pb-5" onContextMenu={(e) => openMenu(e, { kind: 'board' })}>
        {!project || !board ? (
          <div className="pt-5 text-[12px] text-faint">No projects yet.</div>
        ) : (
          <div className="flex min-h-full min-w-[980px] flex-col">
            {/* The status columns' heads, which stay put while the lanes scroll under them. */}
            <div className="sticky top-0 z-10 grid flex-none grid-cols-5 gap-3 bg-bg pb-[6px] pt-4">
              {TASK_STATUSES.map((status) => {
                const dot = taskColumnDot(status)
                const count = lanes.reduce((n, l) => n + l.tasks.filter((t) => t.status === status).length, 0)
                return (
                  <div
                    key={status}
                    onContextMenu={(e) => openMenu(e, { kind: 'column', status })}
                    className="flex items-center gap-2 pl-[7px] pr-[3px]"
                  >
                    <span className={`size-2 flex-none rounded-full ${dot.className}`} style={dot.style} />
                    <span className={`truncate text-[12.5px] font-bold ${taskColumnHeadClass(status)}`}>
                      {taskStatusLabel(status)}
                    </span>
                    <span className="font-mono text-[10.5px] text-faint">{count}</span>
                    <button
                      type="button"
                      onClick={() => startAdding(board.lanes[0], status)}
                      title={`New task in ${taskStatusLabel(status)}`}
                      aria-label={`New task in ${taskStatusLabel(status)}`}
                      className={`${ICON_BTN} ml-auto`}
                    >
                      <Plus size={13} strokeWidth={1.5} />
                    </button>
                  </div>
                )
              })}
            </div>

            {taskTotal === 0 && (
              <div className="mb-2 flex-none pl-[7px] text-[12px] text-faint">
                No tasks in {project.name} yet. Add one from any column.
              </div>
            )}
            {filtering && shownTotal === 0 && taskTotal > 0 && (
              <div className="mb-2 flex flex-none items-center gap-2 pl-[7px] text-[12px] text-faint">
                No task matches “{query.trim()}”.
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="rounded font-semibold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  Clear filter
                </button>
              </div>
            )}

            {/* One swim-lane per repo with tasks (Project first). */}
            {lanes.map(({ lane, tasks }, i) => {
              const Glyph = LANE_GLYPH[lane.kind]
              const closed = isCollapsed(lane)
              const Chevron = closed ? ChevronRight : ChevronDown
              const hoverLane = hoverCell?.slice(0, hoverCell.lastIndexOf(':'))
              const target = !!drag && !drag.locked && hoverLane === lane.key && lane.key !== drag.fromKey
              const hint = target
                ? `Move to ${lane.kind === 'project' ? 'Project' : lane.name}`
                : drag?.locked && lane.key === drag.fromKey
                  ? 'Has a worktree here'
                  : null
              // A locked card may only move within its own lane.
              const refused = !!drag && drag.locked && lane.key !== drag.fromKey
              const laneTitle =
                lane.kind === 'project'
                  ? `Tasks with no repo: work that spans ${project.name}`
                  : (repos.find((r) => r.id === lane.repoId)?.repoPath ?? lane.name)
              const ariaLane = lane.kind === 'project' ? 'Project, no repo' : lane.name
              const laneCell = `${lane.key}:`
              // A lane the filter empties keeps its head (so it can still be dropped on) and gives up its rows.
              const filteredOut = board.laned && filtering && tasks.length === 0
              return (
                <section
                  key={lane.key}
                  className={
                    board.laned
                      ? `flex-none ${i > 0 ? 'mt-1 border-t border-line pt-2' : ''}`
                      : 'flex flex-1 flex-col'
                  }
                >
                  {board.laned && (
                    // A card dropped on the lane's head changes its repo and keeps its status,
                    // which is the only way into a collapsed lane.
                    <div
                      onContextMenu={(e) => openMenu(e, { kind: 'lane', lane })}
                      onDragOver={(e) => {
                        if (refused) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (hoverCell !== laneCell) setHoverCell(laneCell)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        const id = e.dataTransfer.getData('text/plain') || drag?.taskId
                        if (id && !refused) dropTask(id, lane, null)
                        endDrag()
                      }}
                      className={`group/lane mb-[2px] flex items-center gap-1 rounded-btn ${
                        target ? 'bg-accent/[0.08]' : ''
                      } ${refused ? 'opacity-40' : ''}`}
                    >
                      <button
                        type="button"
                        aria-expanded={!closed}
                        onClick={() => setLaneCollapsed(lane, !closed)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-btn py-[5px] pl-1 pr-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                      >
                        <Chevron size={13} strokeWidth={1.5} className="flex-none text-faint" aria-hidden />
                        <Glyph size={13} strokeWidth={1.5} className="flex-none text-faint" aria-hidden />
                        <span
                          className={`truncate text-[12.5px] font-bold ${
                            target ? 'text-text' : filteredOut ? 'text-faint' : 'text-text-2'
                          }`}
                          title={laneTitle}
                        >
                          {lane.name}
                        </span>
                        <span className={`flex-none font-mono text-[10.5px] ${target ? 'text-accent' : 'text-faint'}`}>
                          {hint ?? (filtering ? `${tasks.length} of ${lane.tasks.length}` : taskCount(tasks.length))}
                        </span>
                        {/* Collapsed, the lane says what it is hiding, by status. */}
                        {closed && (
                          <span className="ml-1 flex flex-none items-center gap-[9px]">
                            {TASK_STATUSES.map((status) => {
                              const n = tasks.filter((t) => t.status === status).length
                              if (n === 0) return null
                              const dot = taskColumnDot(status)
                              return (
                                <span
                                  key={status}
                                  title={`${n} ${taskStatusLabel(status)}`}
                                  className="inline-flex items-center gap-1 font-mono text-[10px] text-faint"
                                >
                                  <span
                                    className={`size-[7px] rounded-full ${dot.className}`}
                                    style={dot.style}
                                    aria-hidden
                                  />
                                  {n}
                                  <span className="sr-only"> {taskStatusLabel(status)}</span>
                                </span>
                              )
                            })}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => startAdding(lane, 'todo')}
                        title={`New task in ${lane.name}`}
                        aria-label={`New task in the ${lane.name} lane`}
                        className={`${ICON_BTN} opacity-0 focus-visible:opacity-100 group-hover/lane:opacity-100`}
                      >
                        <Plus size={13} strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        aria-haspopup="menu"
                        onClick={(e) => setMenu({ pos: under(e.currentTarget, BOARD_MENU), target: { kind: 'lane', lane } })}
                        title="Lane actions"
                        aria-label={`Actions for the ${lane.name} lane`}
                        className={`${ICON_BTN} opacity-0 focus-visible:opacity-100 group-hover/lane:opacity-100`}
                      >
                        <MoreHorizontal size={13} strokeWidth={1.5} />
                      </button>
                    </div>
                  )}

                  {!closed && !filteredOut && (
                    <div className={`grid grid-cols-5 gap-3 ${board.laned ? '' : 'flex-1'}`}>
                      {TASK_STATUSES.map((status) => {
                        const cell = tasks.filter((t) => t.status === status)
                        const cellKey = `${lane.key}:${status}`
                        const isHover = hoverCell === cellKey && !refused
                        return (
                          <div
                            key={status}
                            role="group"
                            aria-label={`${board.laned ? `${ariaLane}, ` : ''}${taskStatusLabel(status)}, ${cell.length} tasks`}
                            onContextMenu={(e) => openMenu(e, { kind: 'cell', lane, status })}
                            // Double-clicking the cell's own space (not a card) starts a task there.
                            onDoubleClick={(e) => {
                              if (e.target === e.currentTarget) startAdding(lane, status)
                            }}
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
                            className={`group/col flex min-h-[52px] flex-col gap-2 rounded-col p-[6px] transition-[background-color,box-shadow,opacity] ${
                              isHover ? 'bg-accent/[0.07] ring-1 ring-inset ring-accent/40' : ''
                            } ${refused ? 'opacity-40' : ''}`}
                          >
                            {cell.map((task) => (
                              <BoardCard
                                key={task.id}
                                task={task}
                                canStart={repoTotal > 0}
                                dragging={drag?.taskId === task.id}
                                onDragStart={(t) =>
                                  setDrag({
                                    taskId: t.id,
                                    fromKey: lane.key,
                                    fromCell: cellKey,
                                    locked: repoLock(t, worktrees) !== null
                                  })
                                }
                                onDragEnd={endDrag}
                              />
                            ))}
                            {/* Where the card will land. */}
                            {isHover && drag && drag.fromCell !== cellKey && (
                              <div
                                aria-hidden
                                className="h-9 flex-none rounded-card border border-dashed border-accent/50"
                              />
                            )}
                            <AddTaskCard
                              projectId={project.id}
                              repoId={lane.repoId}
                              status={status}
                              editing={adding === cellKey}
                              onEditing={(open) => setAdding((a) => (open ? cellKey : a === cellKey ? null : a))}
                              pinned={taskTotal === 0 && i === 0 && status === 'todo'}
                            />
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {menu &&
        (() => {
          const done = doneIn(menu.target)
          return (
            <ContextMenu pos={menu.pos} width={BOARD_MENU.width} onClose={closeMenu}>
              {menu.confirm ? (
                <MenuConfirm
                  message={`Archive ${done.length === 1 ? 'this done task' : `these ${done.length} done tasks`}?`}
                  hint="They leave the board and stay under Archived tasks, where each can be brought back."
                  confirmLabel="Archive"
                  danger={false}
                  onConfirm={() => {
                    for (const t of done) void window.orbital.archiveTask(t.id)
                    setAnnouncement(`Archived ${taskCount(done.length)}.`)
                    closeMenu()
                  }}
                  onCancel={closeMenu}
                />
              ) : (
                menuItems(menu.target)
              )}
            </ContextMenu>
          )
        })()}
    </div>
  )
}
