import { useState, type JSX } from 'react'
import { ChevronRight, Pencil, Play, Trash2 } from 'lucide-react'
import { useStore } from '@renderer/store'
import { TASK_STATUSES, taskStatusLabel, taskColumnDot } from '@renderer/lib/status'
import type { Task, TaskStatus } from '@shared/types'
import { ContextMenu, MenuItem, MenuConfirm, type MenuPos } from '../rail/menu'

/**
 * Right-click context menu for a task card: edit, bridge to a Flight, quick
 * status changes, and a confirm-guarded delete. Shared by the panel tracker and
 * the full board so a card offers the same actions wherever it's shown. The
 * owning card holds the open/position state and renders this when set.
 */
export default function TaskCardContextMenu({
  task,
  pos,
  onClose
}: {
  task: Task
  pos: MenuPos
  onClose: () => void
}): JSX.Element {
  const openModal = useStore((s) => s.openModal)
  const setActiveFlight = useStore((s) => s.setActiveFlight)
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === task.workspaceId))
  const hasFlight = useStore((s) => !!task.flightId && s.flights.some((f) => f.id === task.flightId))
  const [confirming, setConfirming] = useState(false)

  const setStatus = (status: TaskStatus): void => {
    if (status !== task.status) void window.orbital.updateTask(task.id, { status })
    onClose()
  }

  return (
    <ContextMenu pos={pos} width={210} onClose={onClose}>
      {!confirming ? (
        <>
          <MenuItem
            icon={<Pencil size={13} strokeWidth={1.5} />}
            label="Edit task"
            onClick={() => {
              openModal('editTask', { task })
              onClose()
            }}
          />
          {hasFlight ? (
            <MenuItem
              icon={<ChevronRight size={13} strokeWidth={1.5} />}
              label="Go to Flight"
              onClick={() => {
                if (task.flightId) setActiveFlight(task.flightId)
                onClose()
              }}
            />
          ) : (
            <MenuItem
              icon={<Play size={13} strokeWidth={1.5} />}
              label="Start Flight"
              onClick={() => {
                openModal('newFlight', { workspace, task })
                onClose()
              }}
            />
          )}

          <div className="my-1 h-px bg-soft" />
          {TASK_STATUSES.map((s) => {
            const dot = taskColumnDot(s)
            return (
              <MenuItem
                key={s}
                icon={<span className={`inline-block size-[9px] rounded-full ${dot.className}`} style={dot.style} />}
                label={taskStatusLabel(s)}
                hint={s === task.status ? 'current' : undefined}
                onClick={() => setStatus(s)}
              />
            )
          })}

          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<Trash2 size={13} strokeWidth={1.5} />}
            label="Delete task"
            danger
            onClick={() => setConfirming(true)}
          />
        </>
      ) : (
        <MenuConfirm
          message={`Delete "${task.title}"?`}
          hint="This can't be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            void window.orbital.deleteTask(task.id)
            onClose()
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </ContextMenu>
  )
}
