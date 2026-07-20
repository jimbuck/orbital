import type { JSX } from 'react'
import { usePanelWidth } from '@renderer/lib/usePanelWidth'
import PanelResizeHandle from '../PanelResizeHandle'
import { CollapsedPane, PaneCollapseTab } from '../PaneCollapse'
import GitPanel from './GitPanel'
import TaskTracker from './TaskTracker'

/**
 * The cockpit's right rail: the Git surface for the active Worktree (bordered off
 * below) followed by the project Task tracker. Each section scrolls on its
 * own — a long changed-file list caps at ~half the panel so the task list stays
 * reachable, and the task list scrolls independently below it.
 */
export default function RightPanel(): JSX.Element {
  const { width, collapsed, dragging, startResize, resetWidth, toggleCollapsed } = usePanelWidth({
    storageKey: 'orbital.rightPanelWidth',
    defaultWidth: 344,
    min: 280,
    max: 560,
    handleEdge: 'left'
  })

  if (collapsed) return <CollapsedPane edge="left" label="git & tasks panel" onExpand={toggleCollapsed} />

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
      <PaneCollapseTab edge="left" label="git & tasks panel" onCollapse={toggleCollapsed} />
    </aside>
  )
}
