import type { JSX } from 'react'
import { Plus } from 'lucide-react'
import { useStore } from '@renderer/store'
import { usePanelWidth } from '@renderer/lib/usePanelWidth'
import PanelResizeHandle from '../PanelResizeHandle'
import { CollapsedPane, PaneCollapseTab } from '../PaneCollapse'
import Project from './Project'
import RailFooter from './RailFooter'

/**
 * The left rail: the project switcher. Lists every repo as a collapsible
 * group of Worktrees, with an add-project affordance up top and a terminal
 * tally in the footer.
 */
export default function Rail(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const openModal = useStore((s) => s.openModal)
  const { width, collapsed, dragging, startResize, resetWidth, toggleCollapsed } = usePanelWidth({
    storageKey: 'orbital.railWidth',
    defaultWidth: 266,
    min: 200,
    max: 440,
    handleEdge: 'right'
  })

  if (collapsed) return <CollapsedPane edge="right" label="projects panel" onExpand={toggleCollapsed} />

  return (
    <aside style={{ width }} className="relative flex flex-none flex-col border-r border-line bg-rail">
      <div className="flex items-center justify-between border-b border-soft px-[14px] pb-3 pt-[14px]">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.9px] text-faint">Projects</div>
          <div className="mt-[3px] text-[11px] text-dim">
            {projects.length} repo{projects.length === 1 ? '' : 's'} · get work done from orbit
          </div>
        </div>
        <button
          type="button"
          aria-label="Add project"
          onClick={() => openModal('addProject')}
          className="flex size-6 flex-none items-center justify-center rounded-[7px] border border-line-2 text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Plus size={15} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-[9px] py-[10px]">
        {projects.map((project) => (
          <Project key={project.id} project={project} />
        ))}
      </div>

      <RailFooter />
      <PanelResizeHandle edge="right" dragging={dragging} onMouseDown={startResize} onDoubleClick={resetWidth} />
      <PaneCollapseTab edge="right" label="projects panel" onCollapse={toggleCollapsed} />
    </aside>
  )
}
