import type { JSX } from 'react'
import { usePanelWidth } from '@renderer/lib/usePanelWidth'
import PanelResizeHandle from '../PanelResizeHandle'
import GitPanel from './GitPanel'
import TaskTracker from './TaskTracker'

/**
 * The cockpit's right rail: the Git surface for the active Worktree (bordered off
 * below) followed by the project Task tracker. Each section scrolls on its
 * own — a long changed-file list caps at ~half the panel so the task list stays
 * reachable, and the task list scrolls independently below it.
 */
export default function RightPanel(): JSX.Element {
  const { width, dragging, startResize, resetWidth } = usePanelWidth({
    storageKey: 'orbital.rightPanelWidth',
    defaultWidth: 344,
    min: 280,
    max: 560,
    handleEdge: 'left'
  })

  return (
    <aside style={{ width }} className="relative flex flex-none flex-col bg-rail border-l border-line">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="max-h-[55%] flex-none overflow-y-auto">
          <GitPanel />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskTracker />
        </div>
      </div>
      <PanelResizeHandle edge="left" dragging={dragging} onMouseDown={startResize} onDoubleClick={resetWidth} />
    </aside>
  )
}
