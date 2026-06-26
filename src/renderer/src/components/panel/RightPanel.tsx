import type { JSX } from 'react'
import GitPanel from './GitPanel'
import TaskTracker from './TaskTracker'

/**
 * The cockpit's right rail: a scrollable column hosting the Git surface for the
 * active Flight (bordered off below) followed by the workspace Task tracker.
 */
export default function RightPanel(): JSX.Element {
  return (
    <aside className="w-[344px] flex-none flex flex-col bg-rail border-l border-line overflow-y-auto">
      <GitPanel />
      <TaskTracker />
    </aside>
  )
}
