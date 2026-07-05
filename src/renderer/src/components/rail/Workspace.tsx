import { useState, type JSX, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStatus, type Workspace as WorkspaceModel } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot } from '@renderer/lib/status'
import FlightRow from './FlightRow'
import { ContextMenu, MenuItem, MenuConfirm, clampMenuPos, type MenuPos } from './menu'

/**
 * A workspace (repo) header in the rail. Clicking the row activates the
 * workspace; the chevron independently expands/collapses its Flight list.
 * Right-click opens a context menu to remove the workspace from Orbital.
 */
export default function Workspace({ workspace }: { workspace: WorkspaceModel }): JSX.Element {
  const flights = useStore(useShallow((s) => s.flights.filter((f) => f.workspaceId === workspace.id)))
  const expanded = useStore((s) => !!s.expanded[workspace.id])
  const isActive = useStore((s) => s.activeWorkspaceId === workspace.id)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const openModal = useStore((s) => s.openModal)
  const status = aggregateStatus(flights.map((f) => f.status))
  const needsAttention = flights.filter((f) => f.status === 'needs_attention').length

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [confirming, setConfirming] = useState(false)

  const closeMenu = (): void => {
    setMenu(null)
    setConfirming(false)
  }

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setConfirming(false)
    setMenu(clampMenuPos(e, 210, 130))
  }

  const activate = (): void => setActiveWorkspace(workspace.id)
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
        onContextMenu={openMenu}
        className={`flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          isActive ? 'bg-hover' : 'hover:bg-hover'
        }`}
      >
        <button
          type="button"
          aria-label={expanded ? 'Collapse workspace' : 'Expand workspace'}
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded(workspace.id)
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
            onClick={() => openModal('newFlight', { workspace })}
            className="mt-px flex items-center gap-[7px] rounded px-[9px] py-[6px] text-left text-[11.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Plus size={13} strokeWidth={1.5} className="flex-none" />
            <span>New Flight from worktree</span>
          </button>
        </div>
      )}

      {menu && (
        <ContextMenu pos={menu} width={210} onClose={closeMenu}>
          {!confirming ? (
            <MenuItem
              icon={<Trash2 size={13} strokeWidth={1.5} />}
              label="Remove workspace"
              danger
              onClick={() => setConfirming(true)}
            />
          ) : (
            <MenuConfirm
              message={`Remove "${workspace.name}" from Orbital?`}
              hint="The repo and its worktrees stay on disk; open terminals close."
              confirmLabel="Remove"
              danger={false}
              onConfirm={() => {
                void window.orbital.removeWorkspace(workspace.id)
                closeMenu()
              }}
              onCancel={closeMenu}
            />
          )}
        </ContextMenu>
      )}
    </div>
  )
}
