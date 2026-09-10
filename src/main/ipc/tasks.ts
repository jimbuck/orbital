import { IPC, type TaskPatch } from '@shared/types'
import { repo } from '../runtime'
import { handle, broadcast } from './handle'

/** The task board. */
export function register(): void {
  const h = handle
  // ---- tasks ----
  h(IPC.createTask, (_e, projectId: string, title: string, description?: string, tags?: string[]) => {
    const t = repo.tasks.create({ projectId, title, description, tags })
    broadcast()
    return t
  })
  h(IPC.updateTask, (_e, taskId: string, patch: TaskPatch) => {
    const t = repo.tasks.update(taskId, patch)
    broadcast()
    return t
  })
  h(IPC.deleteTask, (_e, taskId: string) => {
    repo.tasks.remove(taskId)
    broadcast()
  })
}
