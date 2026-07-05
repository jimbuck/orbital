import { useState, type JSX, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronDown, ChevronRight, Maximize2, Play, Plus } from 'lucide-react'
import { useStore, activeWorkspace, tasksForWorkspace } from '@renderer/store'
import {
  TASK_STATUSES,
  taskChipClass,
  taskColumnDot,
  taskColumnHeadClass,
  taskStatusLabel
} from '@renderer/lib/status'
import type { Task, TaskStatus } from '@shared/types'
import EditableTaskTitle from './EditableTaskTitle'
import TaskDeleteButton from './TaskDeleteButton'

/** Segmented-toggle pill class for the List / Board switch. */
function segClass(active: boolean): string {
  return (
    'px-[9px] py-[3px] rounded-chip text-[11px] font-semibold cursor-pointer transition-colors ' +
    'outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ' +
    (active ? 'bg-panel-2 text-text' : 'text-faint hover:text-text-2')
  )
}

/**
 * Task tracker for the active workspace. Captures new tasks, switches between a
 * List and a Board view, lets a task's status be changed from a dropdown, and
 * bridges a task to a Flight. Task data is sourced from the store, which is kept
 * live by the `onStateChanged` subscription, so mutations need no manual reload.
 */
export default function TaskTracker(): JSX.Element {
  const workspace = useStore(activeWorkspace)
  const flights = useStore((s) => s.flights)
  const taskView = useStore((s) => s.taskView)
  const setTaskView = useStore((s) => s.setTaskView)
  const openModal = useStore((s) => s.openModal)
  const setActiveFlight = useStore((s) => s.setActiveFlight)
  const tasks = useStore(
    useShallow((s) => {
      const ws = activeWorkspace(s)
      return ws ? tasksForWorkspace(s, ws.id) : []
    })
  )

  const [draft, setDraft] = useState('')
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)

  const flightName = (flightId: string | null): string | undefined =>
    flightId ? flights.find((f) => f.id === flightId)?.name : undefined

  const onCaptureKey = async (e: KeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (e.key !== 'Enter') return
    const title = draft.trim()
    if (!title || !workspace) return
    e.preventDefault()
    setDraft('')
    await window.orbital.createTask(workspace.id, title)
  }

  const setStatus = async (taskId: string, status: TaskStatus): Promise<void> => {
    setMenuTaskId(null)
    await window.orbital.updateTask(taskId, { status })
  }

  // Open the New Flight modal prefilled with (and pre-linked to) this task,
  // letting the user pick a base ref before the worktree is created.
  const startFlight = (task: Task): void => {
    openModal('newFlight', { workspace, task })
  }

  /** Inline mono link to a task's bound Flight. */
  const flightLink = (task: Task, small: boolean): JSX.Element | null => {
    const name = flightName(task.flightId)
    if (!task.flightId || !name) return null
    return (
      <button
        type="button"
        onClick={() => setActiveFlight(task.flightId!)}
        className={`inline-flex items-center mt-2 w-fit font-mono text-blue hover:underline outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded ${
          small ? 'gap-1 text-[9.5px]' : 'gap-1.5 text-[10px]'
        }`}
      >
        <span className={`flex-none rounded-full bg-accent ${small ? 'size-[5px]' : 'size-1.5'}`} />
        Flight {name}
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
          {workspace && (
            <span className="font-mono text-[11px] text-faint truncate" title={workspace.name}>
              {workspace.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-[7px] flex-none">
          <div className="flex p-[2px] rounded-[7px] bg-bg border border-line-2">
            <button type="button" onClick={() => setTaskView('list')} className={segClass(taskView === 'list')}>
              List
            </button>
            <button type="button" onClick={() => setTaskView('board')} className={segClass(taskView === 'board')}>
              Board
            </button>
          </div>
          <button
            type="button"
            onClick={() => openModal('board')}
            title="Open full board — all workspaces"
            aria-label="Open full board"
            className="size-6 flex-none rounded-md border border-line-2 flex items-center justify-center text-muted hover:bg-hover hover:text-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Maximize2 size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* capture */}
      <div className="flex items-center gap-2 px-[11px] py-2 mb-[11px] rounded-btn bg-bg border border-dashed border-line-2 focus-within:border-accent transition-colors">
        <Plus size={14} strokeWidth={1.5} className="flex-none text-accent" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => void onCaptureKey(e)}
          disabled={!workspace}
          placeholder="Capture a task…"
          className="allow-select flex-1 min-w-0 bg-transparent text-[12px] text-text placeholder:text-faint outline-none disabled:opacity-50"
        />
      </div>

      {/* LIST VIEW */}
      {taskView === 'list' && (
        <div className="flex flex-col gap-2">
          {tasks.length === 0 && <div className="px-1 py-2 text-[12px] text-faint">No tasks yet.</div>}
          {tasks.map((task) => {
            const done = task.status === 'done'
            return (
              <div
                key={task.id}
                className="group relative p-3 rounded-card bg-panel border border-line-2 hover:border-line-strong transition-colors"
              >
                <div className="flex items-start justify-between gap-[9px]">
                  <div className="min-w-0 flex-1">
                    <EditableTaskTitle
                      task={task}
                      className={`block text-[12.5px] font-semibold leading-snug text-pretty ${
                        done ? 'text-faint line-through' : 'text-text'
                      }`}
                    />
                  </div>
                  <TaskDeleteButton taskId={task.id} />
                  <button
                    type="button"
                    onClick={() => setMenuTaskId((id) => (id === task.id ? null : task.id))}
                    aria-haspopup="menu"
                    aria-expanded={menuTaskId === task.id}
                    className={`flex-none inline-flex items-center gap-1 px-[7px] py-[2px] rounded-chip text-[9.5px] font-bold uppercase tracking-[0.3px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${taskChipClass(
                      task.status
                    )}`}
                  >
                    {taskStatusLabel(task.status)}
                    <ChevronDown size={10} strokeWidth={2} className="opacity-65" />
                  </button>
                </div>

                {flightLink(task, false)}

                {!task.flightId && (
                  <div className="mt-[9px] flex justify-end">
                    <button
                      type="button"
                      onClick={() => startFlight(task)}
                      title="Start a Flight from this task"
                      aria-label="Start a Flight from this task"
                      className="inline-flex size-[22px] flex-none items-center justify-center rounded-full bg-accent text-[#06122e] outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <Play size={10} strokeWidth={2} fill="currentColor" className="translate-x-[0.5px]" />
                    </button>
                  </div>
                )}

                {menuTaskId === task.id && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuTaskId(null)} />
                    <div
                      role="menu"
                      className="absolute top-8 right-[11px] z-50 w-[152px] p-1 rounded-[9px] bg-elev border border-line-strong shadow-[0_14px_36px_rgba(0,0,0,0.55)]"
                    >
                      {TASK_STATUSES.map((s) => {
                        const dot = taskColumnDot(s)
                        const active = s === task.status
                        return (
                          <button
                            type="button"
                            role="menuitem"
                            key={s}
                            onClick={() => void setStatus(task.id, s)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                          >
                            <span className={`flex-none size-[7px] rounded-full ${dot.className}`} style={dot.style} />
                            <span className={`text-[11.5px] font-semibold ${taskColumnHeadClass(s)}`}>
                              {taskStatusLabel(s)}
                            </span>
                            {active && <Check size={11} strokeWidth={2} className="ml-auto text-muted" />}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* BOARD VIEW */}
      {taskView === 'board' && (
        <div className="flex gap-[9px] overflow-x-auto pb-2">
          {TASK_STATUSES.map((status) => {
            const colTasks = tasks.filter((t) => t.status === status)
            const dot = taskColumnDot(status)
            return (
              <div key={status} className="flex-none w-[158px] flex flex-col gap-[7px]">
                <div className="flex items-center gap-[7px] px-[2px] pb-[2px]">
                  <span className={`flex-none size-[7px] rounded-full ${dot.className}`} style={dot.style} />
                  <span
                    className={`text-[10.5px] tracking-[0.4px] uppercase font-bold ${taskColumnHeadClass(status)}`}
                  >
                    {taskStatusLabel(status)}
                  </span>
                  <span className="font-mono text-[10px] text-faint">{colTasks.length}</span>
                </div>
                {colTasks.map((task) => {
                  const done = task.status === 'done'
                  return (
                    <div
                      key={task.id}
                      className="group p-[10px] rounded-[9px] bg-panel border border-line-2 hover:border-line-strong transition-colors"
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <div className="min-w-0 flex-1">
                          <EditableTaskTitle
                            task={task}
                            className={`block text-[12px] font-semibold leading-snug text-pretty ${
                              done ? 'text-faint line-through' : 'text-text'
                            }`}
                          />
                        </div>
                        <TaskDeleteButton taskId={task.id} />
                      </div>

                      {flightLink(task, true)}

                      {status === 'todo' && !task.flightId && (
                        <button
                          type="button"
                          onClick={() => startFlight(task)}
                          title="Start a Flight from this task"
                          className="flex items-center gap-1.5 mt-2 w-fit pl-[5px] pr-[7px] py-1 rounded-md bg-accent/[0.08] border border-accent/20 text-blue text-[10px] font-semibold hover:bg-accent/[0.16] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                        >
                          <span className="inline-flex items-center justify-center flex-none size-[14px] rounded-full bg-accent text-[#06122e]">
                            <Play size={7} strokeWidth={2} fill="currentColor" className="translate-x-[0.5px]" />
                          </span>
                          Start a Flight
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
