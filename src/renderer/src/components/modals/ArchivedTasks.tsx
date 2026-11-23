import { useState, type JSX } from 'react'
import { useStore, activeProject } from '@renderer/store'
import { isSingleProject, taskLaneKey, PROJECT_LANE } from '@renderer/lib/taskScope'
import { taskChipClass, taskStatusLabel } from '@renderer/lib/status'
import { useArchivedTasks } from '@renderer/lib/useArchivedTasks'
import { formatTaskTime } from '@renderer/components/panel/TaskMeta'
import { ModalShell, ghostBtn } from './ModalRoot'

/**
 * The active project's archived tasks, newest archive first,
 * each with an Unarchive action. Opened from the full board's header; stacks
 * over it, so closing returns to the board. There is no purge: archived rows
 * stay in the database for good.
 */
export default function ArchivedTasks(): JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const repos = useStore((s) => s.repos)
  const project = useStore(activeProject)
  const archived = useArchivedTasks()
  // Rows being unarchived, so a double click doesn't fire twice while the
  // refreshed list is on its way.
  const [pending, setPending] = useState<Set<string>>(new Set())

  const rows = archived
    .filter((t) => !!project && t.projectId === project.id)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  // The Repo column only where repos are told apart: a project of two or more.
  const showRepo = !!project && !isSingleProject(project)
  const repoCell = (t: (typeof rows)[number]): React.JSX.Element => {
    const key = project ? taskLaneKey(t, project) : PROJECT_LANE
    return key === PROJECT_LANE ? (
      <span className="text-faint">Project</span>
    ) : (
      <>{repos.find((r) => r.id === key)?.name ?? ''}</>
    )
  }
  const where = project?.name ?? 'this project'

  const unarchive = (taskId: string): void => {
    setPending((s) => new Set(s).add(taskId))
    void window.orbital.unarchiveTask(taskId).finally(() =>
      setPending((s) => {
        const next = new Set(s)
        next.delete(taskId)
        return next
      })
    )
  }

  return (
    <ModalShell
      title="Archived tasks"
      subtitle={`${rows.length} archived in ${where}`}
      width={820}
      onClose={closeModal}
    >
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-text-3">No archived tasks in {where}.</p>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[10.5px] font-bold uppercase tracking-[0.5px] text-muted">
              <th className="px-2 py-1.5 font-bold">#</th>
              <th className="px-2 py-1.5 font-bold">Title</th>
              {showRepo && <th className="px-2 py-1.5 font-bold">Repo</th>}
              <th className="px-2 py-1.5 font-bold">Status</th>
              <th className="px-2 py-1.5 font-bold">Archived</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-soft">
                <td className="px-2 py-2 text-faint">#{t.seq}</td>
                <td className="px-2 py-2 font-semibold text-text-2">{t.title}</td>
                {showRepo && <td className="px-2 py-2 text-text-3">{repoCell(t)}</td>}
                <td className="px-2 py-2">
                  <span className={`rounded-chip px-2 py-0.5 text-[10px] font-bold ${taskChipClass(t.status)}`}>
                    {taskStatusLabel(t.status)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-text-3">
                  {t.archivedAt != null ? formatTaskTime(t.archivedAt) : ''}
                </td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    className={`${ghostBtn} px-[10px] py-[5px] text-[11.5px]`}
                    onClick={() => unarchive(t.id)}
                    disabled={pending.has(t.id)}
                  >
                    Unarchive
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ModalShell>
  )
}
