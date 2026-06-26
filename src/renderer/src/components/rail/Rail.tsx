import type { JSX } from 'react'
import { Plus } from 'lucide-react'
import { useStore } from '@renderer/store'
import Workspace from './Workspace'
import RailFooter from './RailFooter'

/**
 * The left rail: the workspace switcher. Lists every repo as a collapsible
 * group of Flights, with an add-workspace affordance up top and a terminal
 * tally in the footer.
 */
export default function Rail(): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const openModal = useStore((s) => s.openModal)

  return (
    <aside className="flex w-[266px] flex-none flex-col border-r border-line bg-rail">
      <div className="flex items-center justify-between border-b border-soft px-[14px] pb-3 pt-[14px]">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.9px] text-faint">Workspaces</div>
          <div className="mt-[3px] text-[11px] text-dim">
            {workspaces.length} repo{workspaces.length === 1 ? '' : 's'} · get work done from orbit
          </div>
        </div>
        <button
          type="button"
          aria-label="Add workspace"
          onClick={() => openModal('addWorkspace')}
          className="flex size-6 flex-none items-center justify-center rounded-[7px] border border-line-2 text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Plus size={15} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-[9px] py-[10px]">
        {workspaces.map((workspace) => (
          <Workspace key={workspace.id} workspace={workspace} />
        ))}
      </div>

      <RailFooter />
    </aside>
  )
}
