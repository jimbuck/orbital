import { useState, type JSX } from 'react'
import { Archive, ChevronRight, FolderGit2, Pencil, Play } from 'lucide-react'
import { useStore } from '@renderer/store'
import { TASK_STATUSES, taskStatusLabel, taskColumnDot } from '@renderer/lib/status'
import { isSingleProject, repoLock, taskLaneKey, PROJECT_LANE } from '@renderer/lib/taskScope'
import type { Task, TaskStatus } from '@shared/types'
import { ContextMenu, MenuItem, type MenuPos } from '../rail/menu'
import TaskRepoStep from './TaskRepoStep'

/**
 * Right-click context menu for a task card: edit, bridge to a Worktree, file
 * it under a repo, quick status changes, and archive (reversible, so
 * unconfirmed). Shared by the panel tracker and the full board so a card
 * offers the same actions wherever it's shown. The owning card holds the
 * open/position state and renders this when set; the tracker's scope chip
 * opens it straight at the Repo step.
 */
export default function TaskCardContextMenu({
  task,
  pos,
  onClose,
  initialStep = 'items'
}: {
  task: Task
  pos: MenuPos
  onClose: () => void
  initialStep?: 'items' | 'repo'
}): JSX.Element {
  const openModal = useStore((s) => s.openModal)
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const project = useStore((s) => s.projects.find((p) => p.id === task.projectId))
  const repos = useStore((s) => s.repos)
  const worktrees = useStore((s) => s.worktrees)
  const hasWorktree = !!task.worktreeId && worktrees.some((w) => w.id === task.worktreeId)
  const lock = repoLock(task, worktrees)
  const [step, setStep] = useState<'items' | 'repo'>(lock ? 'items' : initialStep)

  const setStatus = (status: TaskStatus): void => {
    if (status !== task.status) void window.orbital.updateTask(task.id, { status })
    onClose()
  }

  if (step === 'repo' && project) {
    return (
      <ContextMenu pos={pos} width={210} onClose={onClose}>
        <TaskRepoStep task={task} project={project} repos={repos} onDone={onClose} />
      </ContextMenu>
    )
  }

  const laneKey = project ? taskLaneKey(task, project) : PROJECT_LANE
  const repoName = laneKey === PROJECT_LANE ? 'none' : (repos.find((r) => r.id === laneKey)?.name ?? 'none')
  const noRepos = !project || project.repoIds.length === 0

  return (
    <ContextMenu pos={pos} width={210} onClose={onClose}>
      <MenuItem
        icon={<Pencil size={13} strokeWidth={1.5} />}
        label="Edit task"
        onClick={() => {
          openModal('editTask', { task })
          onClose()
        }}
      />
      {hasWorktree ? (
        <MenuItem
          icon={<ChevronRight size={13} strokeWidth={1.5} />}
          label="Go to Worktree"
          onClick={() => {
            if (task.worktreeId) setActiveWorktree(task.worktreeId)
            onClose()
          }}
        />
      ) : (
        <MenuItem
          icon={<Play size={13} strokeWidth={1.5} />}
          label="Start Worktree"
          hint={noRepos ? 'add a repo first' : undefined}
          disabled={noRepos}
          onClick={() => {
            // New Worktree works out the repo (or asks for one).
            openModal('newWorktree', { task })
            onClose()
          }}
        />
      )}
      {project && !isSingleProject(project) && (
        <MenuItem
          icon={<FolderGit2 size={13} strokeWidth={1.5} />}
          label="Repo"
          hint={lock ? 'has worktree' : repoName}
          disabled={!!lock}
          onClick={() => setStep('repo')}
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
        icon={<Archive size={13} strokeWidth={1.5} />}
        label="Archive task"
        onClick={() => {
          void window.orbital.archiveTask(task.id)
          onClose()
        }}
      />
    </ContextMenu>
  )
}
