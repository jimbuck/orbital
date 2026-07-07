import type { JSX } from 'react'
import { usePanelWidth } from '@renderer/lib/usePanelWidth'
import PanelResizeHandle from '../PanelResizeHandle'
import GitPanel from './GitPanel'
import TaskTracker from './TaskTracker'

/**
 * The cockpit's right rail: a scrollable column hosting the Git surface for the
 * active Flight (bordered off below) followed by the workspace Task tracker.
 * Scrolling lives on an inner wrapper so the resize handle stays pinned.
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <GitPanel />
        <TaskTracker />
      </div>
      <PanelResizeHandle edge="left" dragging={dragging} onMouseDown={startResize} onDoubleClick={resetWidth} />
    </aside>
  )
}
