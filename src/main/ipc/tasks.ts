import { IPC } from '@shared/contract'
import { tables } from '../runtime'
import { handle, broadcast } from './handle'

/** The task board. */
export function register(): void {
  const h = handle
  // ---- tasks ----
  h(IPC.createTask, (_e, repoId, title, description, tags) => {
    const t = tables.tasks.create({ repoId, title, description, tags, createdBy: 'user' })
    broadcast()
    return t
  })
  h(IPC.updateTask, (_e, taskId, patch) => {
    const t = tables.tasks.update(taskId, patch)
    broadcast()
    return t
  })
  h(IPC.archiveTask, (_e, taskId) => {
    tables.tasks.archive(taskId)
    broadcast()
  })
  h(IPC.unarchiveTask, (_e, taskId) => {
    tables.tasks.unarchive(taskId)
    broadcast()
  })
  h(IPC.listArchivedTasks, () => tables.tasks.list('archived'))
}
