import { IPC, type TaskPatch } from '@shared/types'
import { repo } from '../runtime'
import { handle, broadcast } from './handle'

/** The task board. */
export function register(): void {
  const h = handle
  // ---- tasks ----
  h(IPC.createTask, (_e, projectId: string, title: string, description?: string, tags?: string[]) => {
    const t = repo.tasks.create({ projectId, title, description, tags, createdBy: 'user' })
    broadcast()
    return t
  })
  h(IPC.updateTask, (_e, taskId: string, patch: TaskPatch) => {
    const t = repo.tasks.update(taskId, patch)
    broadcast()
    return t
  })
  h(IPC.archiveTask, (_e, taskId: string) => {
    repo.tasks.archive(taskId)
    broadcast()
  })
  h(IPC.unarchiveTask, (_e, taskId: string) => {
    repo.tasks.unarchive(taskId)
    broadcast()
  })
  h(IPC.listArchivedTasks, () => repo.tasks.list('archived'))
}
