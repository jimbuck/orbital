import { useEffect, useState } from 'react'
import { useStore } from '@renderer/store'
import type { Task } from '@shared/types'

/**
 * The active workspace's archived tasks. The hydrated state carries only active
 * tasks, so these are fetched on demand, and refetched whenever the task list
 * changes (an archive or unarchive broadcasts fresh state). Empty until the
 * first fetch lands, and on failure.
 */
export function useArchivedTasks(): Task[] {
  const tasks = useStore((s) => s.tasks)
  const [archived, setArchived] = useState<Task[]>([])
  useEffect(() => {
    let live = true
    window.orbital.listArchivedTasks().then(
      (list) => {
        if (live) setArchived(Array.isArray(list) ? list : [])
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [tasks])
  return archived
}
