import type { JSX } from 'react'
import { usePanelWidth } from '@renderer/lib/usePanelWidth'
import PanelResizeHandle from '../PanelResizeHandle'
import { CollapsedPane, PaneCollapseTab } from '../PaneCollapse'
import GitPanel from './GitPanel'
import TaskTracker from './TaskTracker'

/**
 * The cockpit's right rail: the Git surface for the active Worktree (bordered off
 * below) followed by the project Task tracker. Inside each, only the list
 * scrolls — the changed files, the task cards — while the buttons and inputs
 * around it stay put. The Git section caps at ~half the panel so the task list
 * stays reachable. Each wrapper still scrolls as a last resort, for a window
 * too short to fit even a section's fixed parts.
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
        <div className="flex max-h-[55%] flex-none flex-col overflow-y-auto">
          <GitPanel />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <TaskTracker />
        </div>
      </div>
      <PanelResizeHandle edge="left" dragging={dragging} onMouseDown={startResize} onDoubleClick={resetWidth} />
      <PaneCollapseTab edge="left" label="git & tasks panel" onCollapse={toggleCollapsed} />
    </aside>
  )
}
