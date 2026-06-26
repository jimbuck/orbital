import type { JSX, KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { aggregateStatus, type Workspace as WorkspaceModel } from '@shared/types'
import { useStore, flightsForWorkspace } from '@renderer/store'
import { StatusDot } from '@renderer/lib/status'
import FlightRow from './FlightRow'

/**
 * A workspace (repo) header in the rail. Clicking the row activates the
 * workspace; the chevron independently expands/collapses its Flight list.
 */
export default function Workspace({ workspace }: { workspace: WorkspaceModel }): JSX.Element {
  const store = useStore()
  const flights = flightsForWorkspace(store, workspace.id)
  const status = aggregateStatus(flights.map((f) => f.status))
  const expanded = !!store.expanded[workspace.id]
  const isActive = store.activeWorkspaceId === workspace.id
  const needsAttention = flights.filter((f) => f.status === 'needs_attention').length

  const activate = (): void => store.setActiveWorkspace(workspace.id)
  const onHeaderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate()
    }
  }

  return (
    <div className="mb-1">
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={onHeaderKey}
        className={`flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          isActive ? 'bg-hover' : 'hover:bg-hover'
        }`}
      >
        <button
          type="button"
          aria-label={expanded ? 'Collapse workspace' : 'Expand workspace'}
          onClick={(e) => {
            e.stopPropagation()
            store.toggleExpanded(workspace.id)
          }}
          className="flex flex-none items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {expanded ? (
            <ChevronDown size={14} strokeWidth={1.5} className="text-muted" />
          ) : (
            <ChevronRight size={14} strokeWidth={1.5} className="text-faint" />
          )}
        </button>

        <span className="flex w-[11px] flex-none items-center justify-center">
          <StatusDot status={status} />
        </span>

        <div className="min-w-0 flex-1">
          <div className={`text-[13.5px] font-bold ${isActive ? 'text-text' : 'text-text-2'}`}>
            {workspace.name}
          </div>
          <div className="mt-px truncate font-mono text-[10.5px] text-faint">{workspace.repoPath}</div>
        </div>

        {needsAttention > 0 && (
          <span className="inline-flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-amber/15 px-[5px] font-mono text-[10px] font-bold text-amber-2">
            {needsAttention}
          </span>
        )}
      </div>

      {expanded && (
        <div className="ml-3 mb-[6px] mt-[3px] flex flex-col gap-[2px] border-l border-line-2 pl-3">
          {flights.map((flight) => (
            <FlightRow key={flight.id} flight={flight} />
          ))}
          <button
            type="button"
            onClick={() => store.openModal('newFlight', { workspace })}
            className="mt-px flex items-center gap-[7px] rounded px-[9px] py-[6px] text-left text-[11.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Plus size={13} strokeWidth={1.5} className="flex-none" />
            <span>New Flight from worktree</span>
          </button>
        </div>
      )}
    </div>
  )
}
