import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, CircleOff, FolderOpen, Pencil, Plus, Terminal, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStatus, type Workspace as WorkspaceModel } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot } from '@renderer/lib/status'
import FlightRow from './FlightRow'
import { ContextMenu, MenuItem, MenuConfirm, clampMenuPos, type MenuPos } from './menu'

/**
 * A workspace (repo) header in the rail. The header row IS the root Flight:
 * clicking it selects the workspace's root Flight directly. Worktree Flights
 * live in the collapsible list below — the chevron only renders when there
 * are any. Right-click opens a context menu to rename the workspace inline,
 * start a new Flight, clear a stuck root status, open the repo in Explorer or
 * an external terminal, or remove the workspace.
 */
export default function Workspace({ workspace }: { workspace: WorkspaceModel }): JSX.Element {
  const flights = useStore(useShallow((s) => s.flights.filter((f) => f.workspaceId === workspace.id)))
  const expanded = useStore((s) => !!s.expanded[workspace.id])
  const isActive = useStore((s) => s.activeWorkspaceId === workspace.id)
  const activeFlightId = useStore((s) => s.activeFlightId)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const openModal = useStore((s) => s.openModal)
  const root = flights.find((f) => f.kind === 'root')
  const worktrees = flights.filter((f) => f.kind !== 'root')
  const rootActive = !!root && activeFlightId === root.id
  const status = aggregateStatus(flights.map((f) => f.status))
  const needsAttention = flights.filter((f) => f.status === 'needs_attention').length

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(workspace.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const closeMenu = (): void => {
    setMenu(null)
    setConfirming(false)
  }

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setConfirming(false)
    setMenu(clampMenuPos(e, 210, 200))
  }

  const startRename = (): void => {
    setDraft(workspace.name)
    setRenaming(true)
    closeMenu()
  }
  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (name && name !== workspace.name) void window.orbital.renameWorkspace(workspace.id, name)
  }
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setRenaming(false)
    }
  }

  const activate = (): void => setActiveWorkspace(workspace.id)
  const onHeaderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (renaming) return
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
        onClick={() => !renaming && activate()}
        onKeyDown={onHeaderKey}
        onContextMenu={openMenu}
        className={`group flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          rootActive ? 'bg-panel-2' : isActive ? 'bg-hover' : 'hover:bg-hover'
        }`}
      >
        {worktrees.length > 0 ? (
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
        ) : (
          <span className="w-[14px] flex-none" />
        )}

        <span className="flex w-[11px] flex-none items-center justify-center">
          <StatusDot status={status} />
        </span>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              className="allow-select w-full rounded border border-accent/60 bg-bg px-1 py-0.5 text-[13.5px] font-bold text-text outline-none"
            />
          ) : (
            <div className={`text-[13.5px] font-bold ${isActive ? 'text-text' : 'text-text-2'}`}>
              {workspace.name}
            </div>
          )}
          <div className="mt-px truncate font-mono text-[10.5px] text-faint">
            {root ? `${root.branch} · ` : ''}
            {workspace.repoPath}
          </div>
        </div>

        {!renaming && (
          <button
            type="button"
            aria-label="New Flight from worktree"
            title="New Flight from worktree"
            onClick={(e) => {
              e.stopPropagation()
              openModal('newFlight', { workspace })
            }}
            className="flex size-5 flex-none items-center justify-center rounded-[6px] text-faint opacity-0 outline-none hover:bg-hover hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100"
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        )}

        {!renaming && needsAttention > 0 && (
          <span className="inline-flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-amber/15 px-[5px] font-mono text-[10px] font-bold text-amber-2">
            {needsAttention}
          </span>
        )}
      </div>

      {expanded && worktrees.length > 0 && (
        <div className="ml-3 mb-[6px] mt-[3px] flex flex-col gap-[2px] border-l border-line-2 pl-3">
          {worktrees.map((flight) => (
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
            <>
              <MenuItem icon={<Pencil size={13} strokeWidth={1.5} />} label="Rename" onClick={startRename} />
              <MenuItem
                icon={<Plus size={13} strokeWidth={1.5} />}
                label="New Flight from worktree"
                onClick={() => {
                  openModal('newFlight', { workspace })
                  closeMenu()
                }}
              />
              {root && (
                <MenuItem
                  icon={<CircleOff size={13} strokeWidth={1.5} />}
                  label="Clear Status"
                  onClick={() => {
                    void window.orbital.clearFlightStatus(root.id)
                    closeMenu()
                  }}
                />
              )}
              <MenuItem
                icon={<FolderOpen size={13} strokeWidth={1.5} />}
                label="Open in Explorer"
                onClick={() => {
                  void window.orbital.openPath(workspace.repoPath)
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<Terminal size={13} strokeWidth={1.5} />}
                label="Open in External Terminal"
                onClick={() => {
                  void window.orbital.openInTerminal(workspace.repoPath)
                  closeMenu()
                }}
              />
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<Trash2 size={13} strokeWidth={1.5} />}
                label="Remove workspace"
                danger
                onClick={() => setConfirming(true)}
              />
            </>
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
